import { mkdtemp, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database, openDatabase } from '../../src/db/database';

/** Owns only this mkdtemp directory and these exact SQLite files; never recursively deletes. */
export class FileDatabaseFixture {
  private readonly connections: Database[] = [];
  readonly filename: string;

  private constructor(readonly directory: string) {
    this.filename = join(directory, 'data', 'test.sqlite');
  }

  static async create(): Promise<FileDatabaseFixture> {
    return new FileDatabaseFixture(await mkdtemp(join(tmpdir(), 'crypto-tracker-sqlite-')));
  }

  async open(): Promise<Database> {
    const database = await openDatabase(this.filename);
    this.connections.push(database);
    return database;
  }

  async dispose(): Promise<void> {
    for (const database of this.connections) await database.close();
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      try { await unlink(this.filename + suffix); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    for (const directory of [join(this.directory, 'data'), this.directory]) {
      try { await rmdir(directory); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
}

export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}
