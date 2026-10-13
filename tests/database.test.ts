import { Database } from '../src/db/database';
import { deferred, FileDatabaseFixture } from './helpers/file-database';

const TIME = '2026-10-07T12:00:00.000Z';
const INSERT_COIN = `INSERT INTO cryptocurrencies (cmc_id, symbol, name, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?)`;

describe('file SQLite data integrity', () => {
  let fixture: FileDatabaseFixture;
  let database: Database;
  beforeEach(async () => { fixture = await FileDatabaseFixture.create(); database = await fixture.open(); });
  afterEach(async () => { await fixture.dispose(); });

  it('keeps concurrent reads and writes outside a failing transaction and preserves their data', async () => {
    const entered = deferred();
    const release = deferred();
    const failed = database.transaction(async (sql) => {
      await sql.run(INSERT_COIN, [1, 'BTC', 'Rolled back', TIME, TIME]);
      entered.resolve();
      await release.promise;
      throw new Error('rollback first transaction');
    });
    const failureResult = expect(failed).rejects.toThrow('rollback first transaction');
    await entered.promise;
    const read = database.all('SELECT cmc_id FROM cryptocurrencies ORDER BY cmc_id');
    const committed = database.transaction(async (sql) => {
      await sql.run(INSERT_COIN, [2, 'ETH', 'Committed', TIME, TIME]);
    });
    const standalone = database.run(INSERT_COIN, [3, 'SOL', 'Standalone', TIME, TIME]);
    release.resolve();
    await Promise.all([failureResult, committed, standalone]);
    expect(await read).toEqual([]);
    expect(await database.all('SELECT cmc_id FROM cryptocurrencies ORDER BY cmc_id'))
      .toEqual([{ cmc_id: 2 }, { cmc_id: 3 }]);
    await database.close();
    database = await fixture.open();
    expect(await database.all('SELECT cmc_id FROM cryptocurrencies ORDER BY cmc_id'))
      .toEqual([{ cmc_id: 2 }, { cmc_id: 3 }]);
  });

  it('finishes accepted writes before closing the connection', async () => {
    const entered = deferred();
    const release = deferred();
    const transaction = database.transaction(async (sql) => {
      entered.resolve();
      await release.promise;
      await sql.run(INSERT_COIN, [1, 'BTC', 'Persisted', TIME, TIME]);
    });
    await entered.promise;
    const closing = database.close();
    release.resolve();
    await Promise.all([transaction, closing]);
    database = await fixture.open();
    expect(await database.get('SELECT cmc_id FROM cryptocurrencies')).toEqual({ cmc_id: 1 });
  });
});
