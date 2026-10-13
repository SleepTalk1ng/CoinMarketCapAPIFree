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
      quote: [{ id: 2781, symbol: 'USD', price: 2500, last_updated: SOURCE }] }],
  } };
}

function upstreamError(httpStatus: number, providerCode: number): AxiosError {
  const config = { headers: new AxiosHeaders({ 'X-CMC_PRO_API_KEY': CMC_KEY }) };
  return new AxiosError(`unsafe ${CMC_KEY}`, 'ERR_BAD_RESPONSE', config, {}, {
    status: httpStatus, statusText: CMC_KEY, headers: {}, config,
    data: { status: { error_code: providerCode, error_message: CMC_KEY } },
  });
}

describe('Authenticated CRUD HTTP API with file-backed SQLite', () => {
  let fixture: FileDatabaseFixture;
  let database: Database;
  let coins: CryptocurrencyRepository;
  let history: PriceHistoryRepository;
  let app: Express;

  async function seed(cmcId = 1027) {
    return (await coins.createWithFirstSnapshot(
      { cmcId, symbol: 'ETH', name: 'Ethereum' },
      { price: 2500, receivedAt: FIRST, sourceUpdatedAt: SOURCE },
    )).cryptocurrency;
  }

  beforeEach(async () => {
    get.mockReset();
    // A forgotten fixture must fail locally instead of reaching the real API.
    get.mockRejectedValue(new Error('No upstream fixture configured.'));
    fixture = await FileDatabaseFixture.create();
    database = await fixture.open();
    coins = new CryptocurrencyRepository(database);
    history = new PriceHistoryRepository(database);
    app = createApp({ serviceApiKey: KEY,
      cryptocurrencies: new CryptocurrencyService(coins,
        new CoinMarketCapClient({ cmcApiKey: CMC_KEY, cmcTimeoutMs: 5000 })),
      prices: new PriceService(coins, history, new PriceUpdater(history,
        new CoinMarketCapClient({ cmcApiKey: CMC_KEY, cmcTimeoutMs: 5000 }))),
    });
  });

  afterEach(async () => { await fixture.dispose(); });

  it('creates a coin with a first USD snapshot, persisting both across reopen', async () => {
    get.mockResolvedValueOnce(quoteResponse());
    const response = await request(app).post(BASE).auth(KEY, { type: 'bearer' }).send({ cmcId: 1027 });
    expect(response.status).toBe(201);
    expect(response.headers.location).toBe(`${BASE}/1027`);
    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.body).toEqual({ id: 1, cmcId: 1027, name: 'Ethereum', symbol: 'ETH',
      trackingEnabled: true, createdAt: expect.any(String), updatedAt: expect.any(String),
      lastPriceReceivedAt: expect.any(String) });
    const snapshot = await history.findLatest(1);
    expect(snapshot).toEqual({ id: 1, cryptocurrencyId: 1, price: 2500, currency: 'USD',
      receivedAt: response.body.lastPriceReceivedAt, sourceUpdatedAt: SOURCE });
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(expect.any(String),
      expect.objectContaining({ params: expect.objectContaining({ id: '1027' }) }));
    await database.close();
    const reopened = await fixture.open();
    expect(await new CryptocurrencyRepository(reopened).findById(1)).toEqual(response.body);
    expect(await new PriceHistoryRepository(reopened).findLatest(1)).toEqual(snapshot);
  });

  it('rejects a creation body with extra fields before any external request or write', async () => {
    const response = await request(app).post(BASE).auth(KEY, { type: 'bearer' })
      .send({ cmcId: 1027, name: 'Untrusted name' });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_REQUEST');
    expect(get).not.toHaveBeenCalled();
    expect((await coins.list()).pagination.total).toBe(0);
  });

  it('lists a stable page including paused coins without contacting CoinMarketCap', async () => {
    await seed(1);
    const second = await seed(1027);
    await coins.setTrackingEnabled(second.id, false);
    const response = await request(app).get(`${BASE}?limit=1&offset=1`).auth(KEY, { type: 'bearer' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ items: [await coins.findById(second.id)],
      pagination: { limit: 1, offset: 1, total: 2 } });
    expect(get).not.toHaveBeenCalled();
  });

  it('rejects pagination that is not a complete integer', async () => {
    const response = await request(app).get(`${BASE}?limit=12abc`).auth(KEY, { type: 'bearer' });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_REQUEST');
  });

  it('reads a coin by UCID and does not treat its internal ID as a fallback', async () => {
    const coin = await seed();
    const response = await request(app).get(`${BASE}/${coin.cmcId}`).auth(KEY, { type: 'bearer' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual(coin);
    const internalId = await request(app).get(`${BASE}/${coin.id}`).auth(KEY, { type: 'bearer' });
    expect(internalId.status).toBe(404);
    expect(internalId.body.error.code).toBe('CRYPTOCURRENCY_NOT_FOUND');
    expect(get).not.toHaveBeenCalled();
  });

  it('rejects an invalid path ID without parsing its numeric prefix', async () => {
    await seed();
    const response = await request(app).get(`${BASE}/1abc`).auth(KEY, { type: 'bearer' });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_REQUEST');
  });

  it('pauses and resumes tracking by UCID while preserving identity and the complete history', async () => {
    const coin = await seed();
    const before = await history.list(coin.id);
    const pause = await request(app).patch(`${BASE}/${coin.cmcId}`).auth(KEY, { type: 'bearer' })
      .send({ trackingEnabled: false });
    expect(pause.status).toBe(200);
    expect(pause.body).toEqual({ ...coin, trackingEnabled: false, updatedAt: expect.any(String) });
    expect(pause.body.updatedAt >= coin.updatedAt).toBe(true);
    expect(await coins.listTrackingEnabled()).toEqual([]);
    const resume = await request(app).patch(`${BASE}/${coin.cmcId}`).auth(KEY, { type: 'bearer' })
      .send({ trackingEnabled: true });
    expect(resume.status).toBe(200);
    expect(resume.body.trackingEnabled).toBe(true);
    expect(await history.list(coin.id)).toEqual(before);
    expect(get).not.toHaveBeenCalled();
  });

  it('rejects a non-boolean PATCH without changing the coin or history', async () => {
    const coin = await seed();
    const response = await request(app).patch(`${BASE}/${coin.cmcId}`).auth(KEY, { type: 'bearer' })
      .send({ trackingEnabled: 'false' });
    expect(response.status).toBe(400);
    expect(await coins.findById(coin.id)).toEqual(coin);
    expect((await history.list(coin.id)).pagination.total).toBe(1);
  });

  it('returns 404 when PATCH targets an absent coin', async () => {
    const response = await request(app).patch(`${BASE}/999`).auth(KEY, { type: 'bearer' })
      .send({ trackingEnabled: false });
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('CRYPTOCURRENCY_NOT_FOUND');
  });

  it('deletes a coin by UCID with all snapshots while preserving other coins', async () => {
    const coin = await seed(1027);
    const other = await seed(1);
    await history.saveSnapshot(coin.id, { price: 2600, receivedAt: '2026-10-07T10:01:00.000Z' });
    const response = await request(app).delete(`${BASE}/${coin.cmcId}`).auth(KEY, { type: 'bearer' });
    expect(response.status).toBe(204);
    expect(response.text).toBe('');
    expect(await coins.findById(coin.id)).toBeUndefined();
    expect((await history.list(coin.id)).pagination.total).toBe(0);
    expect(await coins.findById(other.id)).toEqual(other);
    expect((await history.list(other.id)).pagination.total).toBe(1);
    expect(get).not.toHaveBeenCalled();
  });

  it('returns 404 when deleting an absent coin', async () => {
    const response = await request(app).delete(`${BASE}/999`).auth(KEY, { type: 'bearer' });
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('CRYPTOCURRENCY_NOT_FOUND');
  });

  it('targets the UCID owner when another coin has the same internal ID', async () => {
    const other = await seed(1027);
    const target = await seed(1);
    expect(other.id).toBe(target.cmcId);
    const read = await request(app).get(`${BASE}/1`).auth(KEY, { type: 'bearer' });
    expect(read.status).toBe(200);
    expect(read.body).toEqual(target);
    const patch = await request(app).patch(`${BASE}/1`).auth(KEY, { type: 'bearer' })
      .send({ trackingEnabled: false });
    expect(patch.status).toBe(200);
    expect(patch.body.cmcId).toBe(target.cmcId);
    expect(patch.body.trackingEnabled).toBe(false);
    expect(await coins.findById(other.id)).toEqual(other);
    expect((await history.list(target.id)).pagination.total).toBe(1);
    const deleted = await request(app).delete(`${BASE}/1`).auth(KEY, { type: 'bearer' });
    expect(deleted.status).toBe(204);
    expect(await coins.findByCmcId(target.cmcId)).toBeUndefined();
    expect((await history.list(target.id)).pagination.total).toBe(0);
    expect(await coins.findById(other.id)).toEqual(other);
    expect((await history.list(other.id)).pagination.total).toBe(1);
    expect(get).not.toHaveBeenCalled();
  });

  it('retains the public UCID address after deleting and tracking the same asset again', async () => {
    get.mockResolvedValue(quoteResponse());
    const first = await request(app).post(BASE).auth(KEY, { type: 'bearer' }).send({ cmcId: 1027 });
    expect(first.status).toBe(201);
    const location = first.headers.location as string;
    expect((await request(app).delete(location).auth(KEY, { type: 'bearer' })).status).toBe(204);
    const second = await request(app).post(BASE).auth(KEY, { type: 'bearer' }).send({ cmcId: 1027 });
    expect(second.status).toBe(201);
    expect(second.body.id).not.toBe(first.body.id);
    expect(second.headers.location).toBe(location);
    const read = await request(app).get(location).auth(KEY, { type: 'bearer' });
    expect(read.status).toBe(200);
    expect(read.body).toEqual(second.body);
    expect((await history.list(first.body.id)).pagination.total).toBe(0);
    expect((await history.list(second.body.id)).pagination.total).toBe(1);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('rejects a missing Bearer token before parsing malformed JSON or calling the provider', async () => {
    const response = await request(app).post(BASE).set('Content-Type', 'application/json').send('{');
    expect(response.status).toBe(401);
    expect(response.headers['www-authenticate']).toBe('Bearer');
    expect(response.body.error.code).toBe('UNAUTHORIZED');
    expect(get).not.toHaveBeenCalled();
    expect((await coins.list()).pagination.total).toBe(0);
  });

  it('rejects an incorrect Bearer token before deleting any stored data', async () => {
    const coin = await seed();
    const response = await request(app).delete(`${BASE}/${coin.cmcId}`).auth('wrong-key', { type: 'bearer' });
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
    expect(await coins.findById(coin.id)).toEqual(coin);
    expect((await history.list(coin.id)).pagination.total).toBe(1);
  });

  it('returns a managed error for malformed authenticated JSON without writing data', async () => {
    const response = await request(app).post(BASE).auth(KEY, { type: 'bearer' })
      .set('Content-Type', 'application/json').send('{"cmcId":');
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: { code: 'INVALID_JSON', message: expect.any(String) } });
    expect(get).not.toHaveBeenCalled();
    expect((await coins.list()).pagination.total).toBe(0);
  });

  it('returns 409 for an already tracked cmcId without spending another provider request', async () => {
    const coin = await seed();
    const response = await request(app).post(BASE).auth(KEY, { type: 'bearer' }).send({ cmcId: coin.cmcId });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('CRYPTOCURRENCY_ALREADY_EXISTS');
    expect(get).not.toHaveBeenCalled();
    expect(await coins.findById(coin.id)).toEqual(coin);
    expect((await history.list(coin.id)).pagination.total).toBe(1);
  });

  it('resolves concurrent duplicate creation to 201 and 409 with exactly one coin and snapshot', async () => {
    const bothRequests = deferred();
    let requested = 0;
    get.mockImplementation(async () => {
      requested++;
      if (requested === 2) bothRequests.resolve();
      await bothRequests.promise;
      return quoteResponse();
    });
    const responses = await Promise.all([
      request(app).post(BASE).auth(KEY, { type: 'bearer' }).send({ cmcId: 1027 }),
      request(app).post(BASE).auth(KEY, { type: 'bearer' }).send({ cmcId: 1027 }),
    ]);
    expect(responses.map(r => r.status).sort()).toEqual([201, 409]);
    expect((await coins.list()).pagination.total).toBe(1);
    expect((await history.list(1)).pagination.total).toBe(1);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('rolls back the new coin when its first snapshot fails, hiding internal SQL details', async () => {
    await database.exec(`CREATE TRIGGER fail_first_snapshot BEFORE INSERT ON price_history
      BEGIN SELECT RAISE(ABORT, 'private storage detail'); END;`);
    get.mockResolvedValueOnce(quoteResponse());
    const response = await request(app).post(BASE).auth(KEY, { type: 'bearer' }).send({ cmcId: 1027 });
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected internal error occurred.' } });
    expect((await coins.list()).pagination.total).toBe(0);
    expect(await database.get('SELECT COUNT(*) AS total FROM price_history')).toEqual({ total: 0 });
    await database.exec('DROP TRIGGER fail_first_snapshot');
    get.mockResolvedValueOnce(quoteResponse());
    expect((await request(app).post(BASE).auth(KEY, { type: 'bearer' }).send({ cmcId: 1027 })).status).toBe(201);
  });

  it.each([
    ['quota', () => upstreamError(429, 1010), 503, 'CMC_RATE_LIMITED'],
  ] as const)('maps %s safely while preserving existing coins and history', async (_name, makeError, status, code) => {
    const coin = await seed(1);
    const snapshots = await history.list(coin.id);
    get.mockRejectedValueOnce(makeError());
    const response = await request(app).post(BASE).auth(KEY, { type: 'bearer' }).send({ cmcId: 1027 });
    expect(response.status).toBe(status);
    expect(response.body).toEqual({ error: { code, message: expect.any(String) } });
    expect(response.text).not.toContain(CMC_KEY);
    expect(response.text).not.toContain(KEY);
    expect(await coins.findById(coin.id)).toEqual(coin);
    expect((await coins.list()).pagination.total).toBe(1);
    expect(await history.list(coin.id)).toEqual(snapshots);
  });

  it('returns 404 for a missing CMC quote without saving a placeholder coin', async () => {
    const result = quoteResponse();
    result.data.data = [];
    get.mockResolvedValueOnce(result);
    const response = await request(app).post(BASE).auth(KEY, { type: 'bearer' }).send({ cmcId: 1027 });
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('CMC_COIN_NOT_FOUND');
    expect((await coins.list()).pagination.total).toBe(0);
  });

  it('serves a public OpenAPI 3.0 contract matching the implemented CRUD and price paths', async () => {
    const response = await request(app).get('/openapi.json');
    expect(response.status).toBe(200);
    expect(response.body.openapi).toBe('3.0.3');
    expect(response.body.security).toEqual([{ serviceBearer: [] }]);
    expect(Object.keys(response.body.paths)).toEqual([BASE, `${BASE}/{cmcId}`,
      `${BASE}/{cmcId}/price/refresh`, `${BASE}/{cmcId}/price`, `${BASE}/{cmcId}/history`, '/openapi.json', '/docs/']);
    expect(response.body.components.parameters.CmcId.name).toBe('cmcId');
    expect(response.body.components.parameters.CmcId.description).toContain('UCID');
    expect(response.body.paths['/openapi.json'].get.security).toEqual([]);
    expect(response.text).not.toContain(KEY);
    expect(response.text).not.toContain(CMC_KEY);
  });

  it('returns a JSON 405 for unsupported methods on the public specification', async () => {
    const response = await request(app).post('/openapi.json');
    expect(response.status).toBe(405);
    expect(response.headers.allow).toBe('GET, HEAD');
    expect(response.body.error.code).toBe('METHOD_NOT_ALLOWED');
  });

  it('serves public Swagger UI HTML and its local assets', async () => {
    const response = await request(app).get('/docs/');
    expect(response.status).toBe(200);
    expect(response.type).toBe('text/html');
    expect(response.text).toContain('swagger-ui');
    const asset = await request(app).get('/docs/swagger-ui-init.js');
    expect(asset.status).toBe(200);
    expect(asset.text).toContain('/openapi.json');
    expect(asset.text).not.toContain(KEY);
    expect(asset.text).not.toContain(CMC_KEY);
  });

  it('returns a JSON 405 for unsupported methods on Swagger UI', async () => {
    const response = await request(app).post('/docs/');
    expect(response.status).toBe(405);
    expect(response.headers.allow).toBe('GET, HEAD');
    expect(response.body.error.code).toBe('METHOD_NOT_ALLOWED');
  });
});
