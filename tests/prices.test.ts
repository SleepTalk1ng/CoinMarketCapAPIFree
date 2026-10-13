import axios, { AxiosError, AxiosHeaders } from 'axios';
import { Express } from 'express';
import request from 'supertest';
import { createApp } from '../src/app';
import { Database } from '../src/db/database';
import { CoinMarketCapClient } from '../src/integrations/coinmarketcap';
import { CryptocurrencyRepository } from '../src/repositories/cryptocurrencies';
import { PriceHistoryRepository } from '../src/repositories/price-history';
import { CryptocurrencyService } from '../src/services/cryptocurrencies';
import { PriceService, PriceUpdater } from '../src/services/prices';
import { deferred, FileDatabaseFixture } from './helpers/file-database';

const KEY = 'mock-only-service-key';
const CMC_KEY = 'mock-only-provider-key';
const BASE = '/api/v1/cryptocurrencies';
const FIRST = '2026-10-07T10:00:00.000Z';
const SOURCE = '2026-10-07T09:59:00.000Z';
const get = jest.spyOn(axios, 'get');

function quoteResponse(cmcId = 1027) {
  return { status: 200, headers: {}, data: {
    status: { error_code: '0', timestamp: FIRST },
    data: [{ id: cmcId, name: 'Ethereum', symbol: 'ETH',
      quote: [{ id: 2781, symbol: 'USD', price: 2600, last_updated: SOURCE }] }],
  } };
}

function upstreamError(httpStatus: number, providerCode: number): AxiosError {
  const config = { headers: new AxiosHeaders({ 'X-CMC_PRO_API_KEY': CMC_KEY }) };
  return new AxiosError(`unsafe ${CMC_KEY}`, 'ERR_BAD_RESPONSE', config, {}, {
    status: httpStatus, statusText: CMC_KEY, headers: {}, config,
    data: { status: { error_code: providerCode, error_message: CMC_KEY } },
  });
}

describe('Price refresh and SQLite reads over HTTP', () => {
  let fixture: FileDatabaseFixture;
  let database: Database;
  let coins: CryptocurrencyRepository;
  let history: PriceHistoryRepository;
  let updater: PriceUpdater;
  let app: Express;

  async function seed(cmcId = 1027) {
    return (await coins.createWithFirstSnapshot(
      { cmcId, symbol: 'ETH', name: 'Ethereum' },
      { price: 2500, receivedAt: FIRST, sourceUpdatedAt: SOURCE },
    )).cryptocurrency;
  }

  beforeEach(async () => {
    get.mockReset();
    get.mockRejectedValue(new Error('No upstream fixture configured.'));
    fixture = await FileDatabaseFixture.create();
    database = await fixture.open();
    coins = new CryptocurrencyRepository(database);
    history = new PriceHistoryRepository(database);
    const quotes = new CoinMarketCapClient({ cmcApiKey: CMC_KEY, cmcTimeoutMs: 5000 });
    updater = new PriceUpdater(history, quotes);
    app = createApp({ serviceApiKey: KEY,
      cryptocurrencies: new CryptocurrencyService(coins, quotes),
      prices: new PriceService(coins, history, updater),
    });
  });

  afterEach(async () => { await fixture.dispose(); });

  it('refreshes a paused UCID, stores repeat source quotes and persists across reopen', async () => {
    const coin = await seed();
    await coins.setTrackingEnabled(coin.id, false);
    get.mockResolvedValue(quoteResponse());
    const first = await request(app).post(`${BASE}/1027/price/refresh`).auth(KEY, { type: 'bearer' });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ cmcId: 1027, symbol: 'ETH', price: 2600, currency: 'USD',
      receivedAt: expect.any(String), sourceUpdatedAt: SOURCE });
    const second = await request(app).post(`${BASE}/1027/price/refresh`).auth(KEY, { type: 'bearer' }).send({});
    expect(second.status).toBe(200);
    expect((await history.list(coin.id)).pagination.total).toBe(3);
    const updated = await coins.findById(coin.id);
    expect(updated).toEqual({ ...coin, trackingEnabled: false,
      updatedAt: expect.any(String), lastPriceReceivedAt: second.body.receivedAt });
    expect(updated!.updatedAt >= second.body.receivedAt).toBe(true);
    expect(get).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      params: { id: '1027', convert: 'USD', skip_invalid: 'true' }, timeout: 5000,
    }));
    await database.close();
    const reopened = await fixture.open();
    const saved = await new PriceHistoryRepository(reopened).findLatest(coin.id);
    expect(saved).toEqual({ id: 3, cryptocurrencyId: coin.id, price: 2600, currency: 'USD',
      receivedAt: second.body.receivedAt, sourceUpdatedAt: SOURCE });
    expect(await new CryptocurrencyRepository(reopened).findByCmcId(1027)).toEqual(updated);
  });

  it('reads the latest stored price with original timestamps while upstream is unavailable, without writes or requests', async () => {
    const coin = await seed();
    await history.saveSnapshot(coin.id, { price: 0, receivedAt: '2026-10-07T10:01:00.000Z' });
    const before = await coins.findById(coin.id);
    const snapshots = await history.list(coin.id);
    get.mockRejectedValue(upstreamError(503, 0));
    const response = await request(app).get(`${BASE}/1027/price`).auth(KEY, { type: 'bearer' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ cmcId: 1027, symbol: 'ETH', price: 0, currency: 'USD',
      receivedAt: '2026-10-07T10:01:00.000Z', sourceUpdatedAt: null });
    expect(await coins.findById(coin.id)).toEqual(before);
    expect(await history.list(coin.id)).toEqual(snapshots);
    expect(get).not.toHaveBeenCalled();
  });

  it('uses UCID for all price routes when it equals another coin internal ID', async () => {
    const other = await seed(1027);
    const target = await seed(1);
    expect(other.id).toBe(target.cmcId);
    await history.saveSnapshot(target.id, { price: 60000, receivedAt: FIRST });
    const read = await request(app).get(`${BASE}/1/price`).auth(KEY, { type: 'bearer' });
    expect(read.body.price).toBe(60000);
    const page = await request(app).get(`${BASE}/1/history`).auth(KEY, { type: 'bearer' });
    expect(page.body.pagination.total).toBe(2);
    expect(page.body.items[0].price).toBe(60000);
    get.mockResolvedValueOnce(quoteResponse(1));
    const refreshed = await request(app).post(`${BASE}/1/price/refresh`).auth(KEY, { type: 'bearer' });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.cmcId).toBe(1);
    expect((await history.list(target.id)).pagination.total).toBe(3);
    expect((await history.list(other.id)).pagination.total).toBe(1);
    expect(await coins.findById(other.id)).toEqual(other);
    expect(get).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      params: expect.objectContaining({ id: '1' }),
    }));
  });

  it.each([
    ['post', 'price/refresh'], ['get', 'price'], ['get', 'history'],
  ] as const)('returns 404 for an untracked UCID in %s /%s without calling CMC', async (method, suffix) => {
    const coin = await seed();
    expect(coin.id).toBe(1);
    const response = await request(app)[method](`${BASE}/1/${suffix}`).auth(KEY, { type: 'bearer' });
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('CRYPTOCURRENCY_NOT_FOUND');
    expect(get).not.toHaveBeenCalled();
    expect((await history.list(coin.id)).pagination.total).toBe(1);
  });

  it.each([
    ['timeout', () => { get.mockRejectedValueOnce(new AxiosError(CMC_KEY, 'ECONNABORTED')); }, 504, 'CMC_TIMEOUT'],
    ['quota', () => { get.mockRejectedValueOnce(upstreamError(429, 1010)); }, 503, 'CMC_RATE_LIMITED'],
    ['network', () => { get.mockRejectedValueOnce(new AxiosError(CMC_KEY, 'ENOTFOUND')); }, 502, 'CMC_NETWORK_ERROR'],
    ['missing quote', () => {
      const result = quoteResponse(); result.data.data = []; get.mockResolvedValueOnce(result);
    }, 404, 'CMC_COIN_NOT_FOUND'],
  ] as const)('rejects refresh on %s, preserving all data and allowing offline reads', async (_name, configure, status, code) => {
    const coin = await seed();
    const before = await history.list(coin.id);
    configure();
    const response = await request(app).post(`${BASE}/1027/price/refresh`).auth(KEY, { type: 'bearer' });
    expect(response.status).toBe(status);
    expect(response.body).toEqual({ error: { code, message: expect.any(String) } });
    expect(response.text).not.toContain(CMC_KEY);
    expect(response.text).not.toContain(KEY);
    expect(await coins.findById(coin.id)).toEqual(coin);
    expect(await history.list(coin.id)).toEqual(before);
    const read = await request(app).get(`${BASE}/1027/price`).auth(KEY, { type: 'bearer' });
    expect(read.status).toBe(200);
    expect(read.body.price).toBe(2500);
    expect(read.body.receivedAt).toBe(FIRST);
    const page = await request(app).get(`${BASE}/1027/history`).auth(KEY, { type: 'bearer' });
    expect(page.status).toBe(200);
    expect(page.body.items).toEqual([read.body]);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('rolls back a saved snapshot if updating the coin fails, returning safe 500', async () => {
    const coin = await seed();
    const before = await history.list(coin.id);
    await database.exec(`CREATE TRIGGER fail_price_update BEFORE UPDATE ON cryptocurrencies
      BEGIN SELECT RAISE(ABORT, 'private storage detail'); END;`);
    get.mockResolvedValueOnce(quoteResponse());
    const response = await request(app).post(`${BASE}/1027/price/refresh`).auth(KEY, { type: 'bearer' });
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected internal error occurred.' } });
    expect(await coins.findById(coin.id)).toEqual(coin);
    expect(await history.list(coin.id)).toEqual(before);
  });

  it('does not attach an in-flight quote to a new record after deletion and re-addition', async () => {
    const original = await seed();
    const requested = deferred();
    const release = deferred();
    get.mockImplementationOnce(async () => {
      requested.resolve(); await release.promise; return quoteResponse();
    });
    const pending = request(app).post(`${BASE}/1027/price/refresh`).auth(KEY, { type: 'bearer' }).then(r => r);
    await requested.promise;
    try {
      const deleted = await request(app).delete(`${BASE}/1027`).auth(KEY, { type: 'bearer' });
      expect(deleted.status).toBe(204);
      const replacement = await seed();
      expect(replacement.id).not.toBe(original.id);
      release.resolve();
      const response = await pending;
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('CRYPTOCURRENCY_NOT_FOUND');
      expect(await coins.findById(replacement.id)).toEqual(replacement);
      expect((await history.list(replacement.id)).pagination.total).toBe(1);
      expect((await history.list(original.id)).pagination.total).toBe(0);
    } finally { release.resolve(); await pending; }
  });

  it('filters by receipt time inclusively, normalizes zones and paginates with stable ties', async () => {
    const coin = await seed();
    await seed(1);
    await history.saveSnapshot(coin.id, { price: 2600, receivedAt: '2026-10-07T10:01:00.000Z', sourceUpdatedAt: SOURCE });
    await history.saveSnapshot(coin.id, { price: 2700, receivedAt: '2026-10-07T10:01:00.000Z', sourceUpdatedAt: SOURCE });
    await history.saveSnapshot(coin.id, { price: 2800, receivedAt: '2026-10-07T10:02:00.000Z', sourceUpdatedAt: SOURCE });
    const before = await history.list(coin.id);
    const response = await request(app).get(`${BASE}/1027/history`).query({
      from: '2026-10-07T12:00:00+02:00', to: '2026-10-07T12:01:00+02:00', limit: 2, offset: 1,
    }).auth(KEY, { type: 'bearer' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ items: [
      { cmcId: 1027, symbol: 'ETH', price: 2600, currency: 'USD', receivedAt: '2026-10-07T10:01:00.000Z', sourceUpdatedAt: SOURCE },
      { cmcId: 1027, symbol: 'ETH', price: 2500, currency: 'USD', receivedAt: FIRST, sourceUpdatedAt: SOURCE },
    ], pagination: { limit: 2, offset: 1, total: 3 } });
    const tied = await request(app).get(`${BASE}/1027/history`).query({
      from: '2026-10-07T10:01:00Z', to: '2026-10-07T10:01:00Z',
    }).auth(KEY, { type: 'bearer' });
    expect(tied.body.items.map((item: { price: number }) => item.price)).toEqual([2700, 2600]);
    const empty = await request(app).get(`${BASE}/1027/history`).query({ from: '2026-10-08T00:00:00Z' })
      .auth(KEY, { type: 'bearer' });
    expect(empty.body).toEqual({ items: [], pagination: { limit: 50, offset: 0, total: 0 } });
    expect(await history.list(coin.id)).toEqual(before);
    expect(get).not.toHaveBeenCalled();
  });

  it('rejects an impossible calendar date at the HTTP boundary', async () => {
    await seed();
    const response = await request(app).get(`${BASE}/1027/history`).query({ from: '2026-02-30T10:00:00Z' })
      .auth(KEY, { type: 'bearer' });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_REQUEST');
    expect(get).not.toHaveBeenCalled();
  });

  it('rejects a reversed range after timezone normalization', async () => {
    await seed();
    const response = await request(app).get(`${BASE}/1027/history`).query({
      from: '2026-10-07T10:00:00Z', to: '2026-10-07T11:00:00+02:00',
    }).auth(KEY, { type: 'bearer' });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_REQUEST');
  });

  it('rejects ambiguous repeated history bounds', async () => {
    await seed();
    const response = await request(app).get(`${BASE}/1027/history?from=${FIRST}&from=${FIRST}`)
      .auth(KEY, { type: 'bearer' });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_REQUEST');
  });

  it('rejects a refresh body with unsupported fields before requesting a quote', async () => {
    const coin = await seed();
    const response = await request(app).post(`${BASE}/1027/price/refresh`).auth(KEY, { type: 'bearer' })
      .send({ price: 1 });
    expect(response.status).toBe(400);
    expect(get).not.toHaveBeenCalled();
    expect((await history.list(coin.id)).pagination.total).toBe(1);
  });

  it('rejects an unsupported price query rather than treating a read as a refresh', async () => {
    const response = await request(app).get(`${BASE}/1027/price?refresh=true`).auth(KEY, { type: 'bearer' });
    expect(response.status).toBe(400);
    expect(get).not.toHaveBeenCalled();
  });

  it('rejects an unparsed refresh body with an unsupported content type', async () => {
    const coin = await seed();
    const response = await request(app).post(`${BASE}/1027/price/refresh`).auth(KEY, { type: 'bearer' })
      .set('Content-Type', 'text/plain').send('unexpected data');
    expect(response.status).toBe(400);
    expect(get).not.toHaveBeenCalled();
    expect((await history.list(coin.id)).pagination.total).toBe(1);
  });

  it.each([
    ['post', 'price/refresh'], ['get', 'price'], ['get', 'history'],
  ] as const)('protects %s /%s with Bearer authentication', async (method, suffix) => {
    const response = await request(app)[method](`${BASE}/1027/${suffix}`);
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
    expect(get).not.toHaveBeenCalled();
  });
});
