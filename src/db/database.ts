import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import sqlite3 from 'sqlite3';

export type SqlParameters = readonly (string | number | null)[];
export interface RunResult {
  readonly lastID: number;
  readonly changes: number;
}

/** Trusted SQL only. Bind data with parameters; transaction control belongs to transaction(). */
export interface SqlExecutor {
  run(sql: string, parameters?: SqlParameters): Promise<RunResult>;
  get<T>(sql: string, parameters?: SqlParameters): Promise<T | undefined>;
  all<T>(sql: string, parameters?: SqlParameters): Promise<T[]>;
  exec(sql: string): Promise<void>;
}

function wrapConnection(connection: sqlite3.Database): SqlExecutor {
  return {
    run: (sql, parameters = []) => new Promise((resolveResult, reject) => {
      connection.run(sql, parameters, function (error: Error | null) {
        if (error) reject(error);
        else resolveResult({ lastID: this.lastID, changes: this.changes });
      });
    }),
    get: <T>(sql: string, parameters: SqlParameters = []) => new Promise<T | undefined>((resolveResult, reject) => {
      connection.get<T>(sql, parameters, (error, row) => {
        if (error) reject(error);
        else resolveResult(row);
      });
    }),
    all: <T>(sql: string, parameters: SqlParameters = []) => new Promise<T[]>((resolveResult, reject) => {
      connection.all<T>(sql, parameters, (error, rows) => {
        if (error) reject(error);
        else resolveResult(rows);
      });
    }),
    exec: (sql) => new Promise<void>((resolveResult, reject) => {
      connection.exec(sql, (error) => {
        if (error) reject(error);
        else resolveResult();
      });
    }),
  };
}

/** One queue for every statement, transaction and close on this connection. */
export class Database implements SqlExecutor {
  private tail: Promise<void> = Promise.resolve();
  private readonly context = new AsyncLocalStorage<symbol>();
  private readonly raw: SqlExecutor;
  private closing = false;
  private failed = false;
  private closePromise?: Promise<void>;

  private constructor(private readonly connection: sqlite3.Database) {
    this.raw = wrapConnection(connection);
  }

  static async open(filename: string): Promise<Database> {
    if (typeof filename !== 'string' || !filename.trim() || filename.includes('\0') ||
        filename === ':memory:' || /^file:/i.test(filename)) {
      throw new Error('Database requires a non-empty filesystem path.');
    }
    const absolutePath = resolve(filename);
    await mkdir(dirname(absolutePath), { recursive: true });
    const connection = await new Promise<sqlite3.Database>((resolveConnection, reject) => {
      const opened = new sqlite3.Database(absolutePath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (error) => {
        if (error) reject(error);
        else resolveConnection(opened);
      });
    });
    const database = new Database(connection);
    try {
      connection.configure('busyTimeout', 5000);
      await database.exec('PRAGMA foreign_keys = ON;');
      const pragma = await database.get<{ foreign_keys: number }>('PRAGMA foreign_keys');
      if (pragma?.foreign_keys !== 1) throw new Error('SQLite foreign keys could not be enabled.');
      await database.migrate();
      return database;
    } catch (error) {
      await database.close();
      throw error;
    }
  }

  private schedule<T>(operation: () => Promise<T>): Promise<T> {
    if (this.context.getStore() !== undefined) {
      return Promise.reject(new Error('Use the transaction executor inside a transaction; nested transactions are not supported.'));
    }
    if (this.closing) return Promise.reject(new Error('Database is closing or closed.'));
    const result = this.tail.then(() => {
      if (this.failed) throw new Error('Database is unusable after a failed rollback.');
      return operation();
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  run(sql: string, parameters: SqlParameters = []): Promise<RunResult> {
    const bindings = [...parameters];
    return this.schedule(() => this.raw.run(sql, bindings));
  }

  get<T>(sql: string, parameters: SqlParameters = []): Promise<T | undefined> {
    const bindings = [...parameters];
    return this.schedule(() => this.raw.get<T>(sql, bindings));
  }

  all<T>(sql: string, parameters: SqlParameters = []): Promise<T[]> {
    const bindings = [...parameters];
    return this.schedule(() => this.raw.all<T>(sql, bindings));
  }

  exec(sql: string): Promise<void> {
    return this.schedule(() => this.raw.exec(sql));
  }

  transaction<T>(operation: (sql: SqlExecutor) => Promise<T>): Promise<T> {
    return this.schedule(async () => {
      await this.raw.exec('BEGIN IMMEDIATE');
      const token = Symbol('transaction');
      let active = true;
      let statementTail: Promise<void> = Promise.resolve();
      let statementError: unknown;
      let statementFailed = false;
      const dispatch = <R>(statement: () => Promise<R>): Promise<R> => {
        if (!active || this.context.getStore() !== token) {
          return Promise.reject(new Error('Transaction executor is only valid inside its active callback.'));
        }
        const result = statementTail.then(statement);
        statementTail = result.then(() => undefined, (error: unknown) => {
          if (!statementFailed) statementError = error;
          statementFailed = true;
        });
        return result;
      };
      const sql: SqlExecutor = {
        run: (query, parameters = []) => {
          const bindings = [...parameters];
          return dispatch(() => this.raw.run(query, bindings));
        },
        get: <R>(query: string, parameters: SqlParameters = []) => {
          const bindings = [...parameters];
          return dispatch(() => this.raw.get<R>(query, bindings));
        },
        all: <R>(query: string, parameters: SqlParameters = []) => {
          const bindings = [...parameters];
          return dispatch(() => this.raw.all<R>(query, bindings));
        },
        exec: (query) => dispatch(() => this.raw.exec(query)),
      };
      try {
        const result = await this.context.run(token, () => operation(sql));
        active = false;
        await statementTail;
        if (statementFailed) throw statementError;
        await this.raw.exec('COMMIT');
        return result;
      } catch (error) {
        active = false;
        await statementTail;
        try {
          await this.raw.exec('ROLLBACK');
        } catch (rollbackError) {
          this.failed = true;
          throw new AggregateError([error, rollbackError], 'Transaction and rollback failed.');
        }
        throw error;
      }
    });
  }

  close(): Promise<void> {
    if (this.context.getStore() !== undefined) {
      return Promise.reject(new Error('Cannot close the database from a transaction callback.'));
    }
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.tail.then(() => new Promise<void>((resolveClosed, reject) => {
      this.connection.close((error) => {
        if (error) reject(error);
        else resolveClosed();
      });
    }));
    return this.closePromise;
  }

  private async migrate(): Promise<void> {
    await this.transaction(async (sql) => {
      const version = await sql.get<{ user_version: number }>('PRAGMA user_version');
      if (version?.user_version === 1) return;
      if (version?.user_version !== 0) throw new Error('Unsupported database schema version.');
      const initialSql = await readFile(join(__dirname, 'migrations', '001_initial.sql'), 'utf8');
      await sql.exec(initialSql);
      await sql.exec('PRAGMA user_version = 1');
    });
  }
}

export const openDatabase = (filename: string): Promise<Database> => Database.open(filename);
