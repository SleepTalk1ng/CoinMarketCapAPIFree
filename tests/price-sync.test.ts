import axios, { AxiosError, AxiosHeaders } from 'axios';
import request from 'supertest';
import { createApp } from '../src/app';
import { Database } from '../src/db/database';
import { CoinMarketCapClient } from '../src/integrations/coinmarketcap';
import { ManagedQuotes } from '../src/integrations/managed-quotes';
import { PriceSync } from '../src/jobs/price-sync';
import { CryptocurrencyRepository } from '../src/repositories/cryptocurrencies';
import { PriceHistoryRepository } from '../src/repositories/price-history';
import { CryptocurrencyService } from '../src/services/cryptocurrencies';
import { PriceService, PriceUpdater } from '../src/services/prices';
import { deferred, FileDatabaseFixture } from './helpers/file-database';

const FIRST = '2026-10-07T10:00:00.000Z';
const SOURCE = '2026-10-07T09:59:00.000Z';
const KEY = 'mock-only-service-key';
const CMC_KEY = 'mock-only-provider-key';
const get = jest.spyOn(axios, 'get');

function response(ids: number[] = [1]) {
  return { status: 200, headers: {}, data: {
    status: { error_code: '0', timestamp: FIRST },
    data: ids.map(id => ({ id, name: `Coin ${id}`, symbol: `C${id}`,
      quote: [{ id: 2781, symbol: 'USD', price: id * 100, last_updated: SOURCE }] })),
  } };
}

function rateLimit(code: number, retryAfter?: string) {
  const config = { headers: new AxiosHeaders({ 'X-CMC_PRO_API_KEY': CMC_KEY }) };
  return new AxiosError(CMC_KEY, 'ERR_BAD_RESPONSE', config, {}, {
    status: 429, statusText: CMC_KEY, config,
    headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter },
    data: { status: { error_code: code, error_message: CMC_KEY } },
  });
}

describe('Sequential price sync with file SQLite and mock axios', () => {
  let fixture: FileDatabaseFixture;
  let database: Database;
  let coins: CryptocurrencyRepository;
  let history: PriceHistoryRepository;
  let quotes: ManagedQuotes;
  let updater: PriceUpdater;
  let job: PriceSync;
  let warn: jest.SpyInstance;
  let info: jest.SpyInstance;

  async function seed(cmcId = 1, trackingEnabled = true) {
    return (await coins.createWithFirstSnapshot(
      { cmcId, symbol: `C${cmcId}`, name: `Coin ${cmcId}`, trackingEnabled },
      { price: 10, receivedAt: FIRST, sourceUpdatedAt: SOURCE },
    )).cryptocurrency;
  }
  const count = async (id: number): Promise<number> => (await history.list(id)).pagination.total;

  beforeEach(async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(new Date('2026-10-09T12:00:00.000Z'));
    get.mockReset().mockResolvedValue(response());
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    info = jest.spyOn(console, 'info').mockImplementation(() => {});
    fixture = await FileDatabaseFixture.create();
    database = await fixture.open();
    coins = new CryptocurrencyRepository(database);
    history = new PriceHistoryRepository(database);
    quotes = new ManagedQuotes(new CoinMarketCapClient({ cmcApiKey: CMC_KEY, cmcTimeoutMs: 5000 }));
    updater = new PriceUpdater(history, quotes);
    job = new PriceSync(coins, updater, 60_000, quotes);
  });

  afterEach(async () => {
    await Promise.all([job.stop(), quotes.stop()]);
    await fixture.dispose();
    warn.mockRestore(); info.mockRestore();
    jest.useRealTimers();
  });

  it('starts immediately, batches active UCIDs and exposes stored prices over HTTP without extra CMC calls', async () => {
    const first = await seed(1);
    const second = await seed(1027);
    const paused = await seed(52, false);
    get.mockResolvedValue(response([1, 1027]));
    await job.start();
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0]?.[1]?.params).toEqual({ id: '1,1027', convert: 'USD', skip_invalid: 'true' });
    expect(await count(first.id)).toBe(2);
    expect(await count(second.id)).toBe(2);
    expect(await count(paused.id)).toBe(1);
    const app = createApp({ serviceApiKey: KEY,
      cryptocurrencies: new CryptocurrencyService(coins, quotes),
      prices: new PriceService(coins, history, updater),
    });
    const saved = await request(app).get('/api/v1/cryptocurrencies/1027/price').set('Authorization', `Bearer ${KEY}`);
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ cmcId: 1027, price: 102700, receivedAt: new Date().toISOString() });
    expect(get).toHaveBeenCalledTimes(1);
    get.mockResolvedValue(response([52]));
    const manual = await request(app).post('/api/v1/cryptocurrencies/52/price/refresh').set('Authorization', `Bearer ${KEY}`);
    expect(manual.status).toBe(200);
    expect(await count(paused.id)).toBe(2);
    expect(get).toHaveBeenCalledTimes(2);
    await job.stop();
    await database.close();
    database = await fixture.open();
    expect((await new PriceHistoryRepository(database).findLatest(second.id))?.price).toBe(102700);
  });

  it('does not call CMC for an empty list or for an entirely paused list, then resumes after enabling', async () => {
    await job.start();
    await jest.advanceTimersByTimeAsync(60_000);
    const coin = await seed(1, false);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(get).not.toHaveBeenCalled();
    await coins.setTrackingEnabled(coin.id, true);
    await jest.advanceTimersByTimeAsync(60_000);
    await job.start();
    await job.stop();
    expect(get).toHaveBeenCalledTimes(1);
    expect(await count(coin.id)).toBe(2);
  });

  it('never overlaps passes and measures the interval from completion, including repeated start', async () => {
    await seed();
    const entered = deferred(); const release = deferred();
    get.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return response(); });
    const first = job.start();
    await entered.promise;
    void job.start();
    await jest.advanceTimersByTimeAsync(180_000);
    expect(get).toHaveBeenCalledTimes(1);
    release.resolve(); await first;
    await jest.advanceTimersByTimeAsync(59_999);
    expect(get).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await job.start();
    await job.stop();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('preserves history on an upstream failure, logs only a fixed code and recovers on the next pass', async () => {
    const coin = await seed();
    get.mockRejectedValueOnce(new Error(`Unsafe transport ${CMC_KEY}`));
    await job.start();
    expect(await count(coin.id)).toBe(1);
    expect(warn).toHaveBeenCalledWith('Price sync failed: NETWORK_ERROR.');
    expect(JSON.stringify(warn.mock.calls)).not.toContain(CMC_KEY);
    await jest.advanceTimersByTimeAsync(60_000);
    await job.start();
    await job.stop();
    expect(await count(coin.id)).toBe(2);
  });

  it('saves valid partial quotes and safely reports missing and invalid UCIDs', async () => {
    const valid = await seed(1); const missing = await seed(2); const invalid = await seed(3);
    const partial = response([1, 3]);
    get.mockResolvedValueOnce({ ...partial, data: { ...partial.data, data: [
      partial.data.data[0],
      { ...partial.data.data[1], quote: [{ ...partial.data.data[1]!.quote[0], price: null }] },
    ] } });
    await job.start();
    expect(await count(valid.id)).toBe(2);
    expect(await count(missing.id)).toBe(1);
    expect(await count(invalid.id)).toBe(1);
    expect(warn.mock.calls).toEqual([
      ['Price sync skipped UCID 2: COIN_NOT_FOUND.'], ['Price sync skipped UCID 3: INVALID_QUOTE.'],
    ]);
  });

  it('skips coins paused or deleted/re-added during a request, while saving the remaining batch', async () => {
    const paused = await seed(1); const deleted = await seed(2); const replaced = await seed(3); const valid = await seed(4);
    const entered = deferred(); const release = deferred();
    get.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return response([1, 2, 3, 4]); });
    const pass = job.start(); await entered.promise;
    await coins.setTrackingEnabled(paused.id, false);
    await coins.deleteById(deleted.id);
    await coins.deleteById(replaced.id);
    const replacement = await seed(3);
    release.resolve(); await pass;
    expect(await count(paused.id)).toBe(1);
    expect(await count(deleted.id)).toBe(0);
    expect(await count(replacement.id)).toBe(1);
    expect(await count(valid.id)).toBe(2);
    expect(info).toHaveBeenCalledTimes(3);
  });

  it('rolls back a failed background snapshot and continues later passes', async () => {
    const coin = await seed();
    await database.exec(`CREATE TRIGGER fail_sync BEFORE UPDATE OF last_price_received_at ON cryptocurrencies
      BEGIN SELECT RAISE(ABORT, 'mock failure'); END;`);
    await job.start();
    expect(await count(coin.id)).toBe(1);
    expect(warn).toHaveBeenCalledWith('Price sync failed: INTERNAL_ERROR.');
    await database.exec('DROP TRIGGER fail_sync');
    await jest.advanceTimersByTimeAsync(60_000);
    await job.start();
    await job.stop();
    expect(await count(coin.id)).toBe(2);
  });

  it('cancels an in-flight request, waits for it and never schedules another pass', async () => {
    const coin = await seed(); const entered = deferred(); const aborted = deferred(); const release = deferred();
    get.mockImplementationOnce(async (_url, options) => {
      options!.signal!.addEventListener!('abort', () => aborted.resolve());
      entered.resolve(); await release.promise; return response();
    });
    const pass = job.start(); await entered.promise;
    let stopped = false;
    const stopping = job.stop().then(() => { stopped = true; });
    await aborted.promise;
    expect(stopped).toBe(false);
    release.resolve(); await stopping; await pass;
    expect(await count(coin.id)).toBe(1);
    await jest.advanceTimersByTimeAsync(300_000);
    await job.start(); await job.stop();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('observes minute quota from a manual call and delays background/HTTP calls until Retry-After', async () => {
    const coin = await seed(); await job.start();
    get.mockRejectedValueOnce(rateLimit(1008, '120'));
    await expect(quotes.getQuote(1)).rejects.toMatchObject({ code: 'RATE_LIMITED', rateLimit: 'minute' });
    const app = createApp({ serviceApiKey: KEY,
      cryptocurrencies: new CryptocurrencyService(coins, quotes),
      prices: new PriceService(coins, history, updater),
    });
    const manual = await request(app).post('/api/v1/cryptocurrencies/1/price/refresh').set('Authorization', `Bearer ${KEY}`);
    expect(manual.status).toBe(503);
    expect(manual.body.error.code).toBe('CMC_RATE_LIMITED');
    const saved = await request(app).get('/api/v1/cryptocurrencies/1/price').set('Authorization', `Bearer ${KEY}`);
    expect(saved.status).toBe(200);
    expect(saved.body.price).toBe(100);
    await jest.advanceTimersByTimeAsync(119_999);
    expect(get).toHaveBeenCalledTimes(2);
    expect(await count(coin.id)).toBe(2);
    await jest.advanceTimersByTimeAsync(1);
    await job.start();
    await job.stop();
    expect(get).toHaveBeenCalledTimes(3);
    expect(await count(coin.id)).toBe(3);
  });

  it('waits a conservative full day after daily exhaustion without Retry-After and recovers', async () => {
    const coin = await seed();
    get.mockRejectedValueOnce(rateLimit(1009));
    await job.start();
    await jest.advanceTimersByTimeAsync(86_400_000 - 1);
    expect(get).toHaveBeenCalledTimes(1);
    expect(await count(coin.id)).toBe(1);
    await jest.advanceTimersByTimeAsync(1); await job.start(); await job.stop();
    expect(get).toHaveBeenCalledTimes(2);
    expect(await count(coin.id)).toBe(2);
  });

  it('does not overflow Node timers during the 31-day monthly fallback and resumes afterward', async () => {
    await seed(); get.mockRejectedValueOnce(rateLimit(1010));
    await job.start();
    await jest.advanceTimersByTimeAsync(31 * 86_400_000 - 1);
    expect(get).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1); await job.start(); await job.stop();
    expect(get).toHaveBeenCalledTimes(2);
  });
});
