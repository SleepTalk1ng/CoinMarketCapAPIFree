import { Database } from '../src/db/database';
import { CryptocurrencyRepository } from '../src/repositories/cryptocurrencies';
import { PriceHistoryRepository } from '../src/repositories/price-history';
import { FileDatabaseFixture } from './helpers/file-database';

const FIRST = '2026-10-07T12:00:00.000Z';
const SECOND = '2026-10-07T12:01:00.000Z';
const THIRD = '2026-10-07T12:02:00.000Z';
const BTC = { cmcId: 1, symbol: 'BTC', name: 'Bitcoin' };
const SNAPSHOT = { price: 60000.125, receivedAt: FIRST, sourceUpdatedAt: '2026-10-07T11:59:00.000Z' };

describe('SQLite repositories', () => {
  let fixture: FileDatabaseFixture;
  let database: Database;
  let coins: CryptocurrencyRepository;
  let history: PriceHistoryRepository;
  function bindRepositories(): void {
    coins = new CryptocurrencyRepository(database);
    history = new PriceHistoryRepository(database);
  }
  beforeEach(async () => {
    fixture = await FileDatabaseFixture.create();
    database = await fixture.open();
    bindRepositories();
  });
  afterEach(async () => { await fixture.dispose(); });

  it('binds quote-containing and SQL-like metadata as data', async () => {
    const metadata = { cmcId: 1, symbol: "B'TC", name: "Coin'); DROP TABLE price_history; --" };
    const created = await coins.createWithFirstSnapshot(metadata, SNAPSHOT);
    expect(await coins.findById(created.cryptocurrency.id)).toEqual(created.cryptocurrency);
    expect((await coins.list()).items[0]).toEqual(expect.objectContaining(metadata));
    expect(await history.findLatest(created.cryptocurrency.id)).toEqual(created.snapshot);
  });

  it('retains older late-arriving snapshots without moving last-price/updated timestamps backwards', async () => {
    await coins.createWithFirstSnapshot(BTC, SNAPSHOT);
    const latest = await history.saveSnapshot(1, { price: 3, receivedAt: THIRD });
    await history.saveSnapshot(1, { price: 2, receivedAt: SECOND });
    expect(await history.findLatest(1)).toEqual(latest);
    expect(await coins.findById(1)).toEqual(expect.objectContaining({ updatedAt: THIRD, lastPriceReceivedAt: THIRD }));
    expect((await history.list(1)).pagination.total).toBe(3);
  });
});
