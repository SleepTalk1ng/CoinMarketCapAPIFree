import axios from 'axios';
import { EventEmitter } from 'node:events';
import { Agent, request as httpRequest, Server } from 'node:http';
import { Socket } from 'node:net';
import request from 'supertest';
import { AppConfig } from '../src/config';
import { Database } from '../src/db/database';
import { CryptocurrencyRepository } from '../src/repositories/cryptocurrencies';
import { PriceHistoryRepository } from '../src/repositories/price-history';
import { RunningServer, startServer } from '../src/server';
import { installShutdown } from '../src/shutdown';
import { deferred, FileDatabaseFixture } from './helpers/file-database';

const FIRST = '2026-10-07T10:00:00.000Z';
const KEY = 'mock-only-service-key';
const get = jest.spyOn(axios, 'get');

function response(cmcId = 1) {
  return { status: 200, headers: {}, data: { status: { error_code: 0, timestamp: FIRST },
    data: [{ id: cmcId, symbol: 'BTC', name: 'Bitcoin',
      quote: [{ id: 2781, symbol: 'USD', price: 65000, last_updated: FIRST }] }],
  } };
}

describe('Server background wiring and signal lifecycle', () => {
  let fixture: FileDatabaseFixture;
  let server: RunningServer | undefined;
  let signals: EventEmitter;
  let config: AppConfig;
  let info: jest.SpyInstance;
  let error: jest.SpyInstance;
  let close: jest.SpyInstance;
  let saved: ReturnType<typeof deferred>;
  let save: jest.SpyInstance;
  let oldExitCode: number | undefined;

  beforeEach(async () => {
    oldExitCode = process.exitCode;
    info = jest.spyOn(console, 'info').mockImplementation(() => {});
    error = jest.spyOn(console, 'error').mockImplementation(() => {});
    signals = new EventEmitter();
    fixture = await FileDatabaseFixture.create();
    const database = await fixture.open();
    await new CryptocurrencyRepository(database).createWithFirstSnapshot(
      { cmcId: 1, symbol: 'BTC', name: 'Bitcoin' }, { price: 60000, receivedAt: FIRST },
    );
    await database.close();
    config = { serviceApiKey: KEY, cmcApiKey: 'mock-only-provider-key', port: 0,
      databasePath: fixture.filename, cmcTimeoutMs: 5000, syncIntervalMs: 60_000, shutdownTimeoutMs: 5000 };
    saved = deferred();
    const original = PriceHistoryRepository.prototype.saveTrackingSnapshot;
    save = jest.spyOn(PriceHistoryRepository.prototype, 'saveTrackingSnapshot').mockImplementation(async function (this: PriceHistoryRepository, ...args) {
      const result = await original.apply(this, args);
      saved.resolve();
      return result;
    });
    close = jest.spyOn(Database.prototype, 'close');
    get.mockReset().mockResolvedValue(response());
  });

  afterEach(async () => {
    await server?.shutdown();
    server = undefined;
    save.mockRestore(); close.mockRestore();
    await fixture.dispose();
    info.mockRestore(); error.mockRestore();
    process.exitCode = oldExitCode;
  });

  it('starts background sync and SIGINT closes resources once, preserving snapshots for HTTP and reopen', async () => {
    server = await startServer(config, { signals });
    await saved.promise;
    const read = await request(server).get('/api/v1/cryptocurrencies/1/price').set('Authorization', `Bearer ${KEY}`);
    expect(read.status).toBe(200);
    expect(read.body.price).toBe(65000);
    expect(get).toHaveBeenCalledTimes(1);
    signals.emit('SIGINT'); signals.emit('SIGINT'); signals.emit('SIGTERM');
    await server.shutdown();
    expect(server.listening).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
    expect(signals.listenerCount('SIGINT') + signals.listenerCount('SIGTERM')).toBe(0);
    const database = await fixture.open();
    const coin = (await new CryptocurrencyRepository(database).findByCmcId(1))!;
    expect((await new PriceHistoryRepository(database).list(coin.id)).pagination.total).toBe(2);
    expect(error).not.toHaveBeenCalled();
  });

  it('SIGTERM aborts both HTTP creation and refresh, waits for their completion and leaves SQLite unchanged', async () => {
    server = await startServer(config, { signals }); await saved.promise;
    const entered = deferred(); const aborted = deferred(); const release = deferred();
    let requests = 0; let cancellations = 0;
    get.mockImplementation(async (_url, options) => {
      if (++requests === 2) entered.resolve();
      options!.signal!.addEventListener!('abort', () => { if (++cancellations === 2) aborted.resolve(); });
      await release.promise;
      return response(Number((options!.params as { id: string }).id));
    });
    const creation = request(server).post('/api/v1/cryptocurrencies').set('Authorization', `Bearer ${KEY}`)
      .send({ cmcId: 1027 }).then(result => result);
    const refresh = request(server).post('/api/v1/cryptocurrencies/1/price/refresh').set('Authorization', `Bearer ${KEY}`)
      .then(result => result);
    await entered.promise;
    signals.emit('SIGTERM'); signals.emit('SIGTERM');
    await aborted.promise;
    expect(close).not.toHaveBeenCalled();
    release.resolve();
    const results = await Promise.all([creation, refresh]);
    expect(results.map(result => result.body.error.code)).toEqual(['CMC_CANCELLED', 'CMC_CANCELLED']);
    await server.shutdown();
    expect(close).toHaveBeenCalledTimes(1);
    const database = await fixture.open();
    const coins = new CryptocurrencyRepository(database);
    expect(await coins.findByCmcId(1027)).toBeUndefined();
    const coin = (await coins.findByCmcId(1))!;
    expect((await new PriceHistoryRepository(database).list(coin.id)).pagination.total).toBe(2);
    expect(get).toHaveBeenCalledTimes(3);
  });

  it('shutdown waits for an accepted background SQLite transaction before closing the database', async () => {
    const entered = deferred(); const release = deferred();
    const transaction = Database.prototype.transaction;
    const spy = jest.spyOn(Database.prototype, 'transaction').mockImplementation(function (this: Database, operation) {
      return transaction.call(this, async sql => {
        const result = await operation(sql);
        if (save.mock.calls.length > 0) { entered.resolve(); await release.promise; }
        return result;
      });
    });
    try {
      server = await startServer(config, { signals });
      await entered.promise;
      const stopping = server.shutdown();
      expect(close).not.toHaveBeenCalled();
      release.resolve(); await stopping;
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve(); spy.mockRestore();
    }
  });

  it('closes keep-alive connections after active responses finish without reaching the deadline', async () => {
    const terminate = jest.fn();
    server = await startServer(config, { signals, terminate }); await saved.promise;
    const entered = deferred(); const release = deferred();
    get.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return response(); });
    const agent = new Agent({ keepAlive: true });
    try {
      const received = new Promise<number>((resolve, reject) => {
        const call = httpRequest({ hostname: '127.0.0.1', port: (server!.address() as { port: number }).port,
          path: '/api/v1/cryptocurrencies/1/price/refresh', method: 'POST', agent,
          headers: { Authorization: `Bearer ${KEY}` },
        }, response => {
          response.resume(); response.once('end', () => resolve(response.statusCode!));
        });
        call.once('error', reject); call.end();
      });
      await entered.promise;
      signals.emit('SIGTERM'); release.resolve();
      expect(await received).toBe(502);
      await server.shutdown();
      expect(terminate).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledTimes(1);
      expect(error).not.toHaveBeenCalled();
    } finally { release.resolve(); agent.destroy(); }
  });
});

it('enforces the shutdown deadline, destroys sockets and initiates database closure once', async () => {
  jest.useFakeTimers();
  const oldExitCode = process.exitCode;
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});
  const server = new EventEmitter() as Server;
  let finishHttp!: () => void;
  server.close = jest.fn(callback => { finishHttp = () => callback!(); return server; });
  server.closeIdleConnections = jest.fn();
  const work = deferred(); const closing = deferred();
  const database = { close: jest.fn(() => closing.promise) };
  const job = { stop: jest.fn(() => work.promise) };
  const quotes = { stop: jest.fn(async () => {}) };
  const signals = new EventEmitter(); const terminate = jest.fn();
  const lifecycle = installShutdown(server, database, job, quotes, 1000, { signals, terminate });
  const socket = new Socket(); const destroy = jest.spyOn(socket, 'destroy');
  server.emit('connection', socket);
  try {
    signals.emit('SIGTERM'); signals.emit('SIGINT');
    expect(job.stop).toHaveBeenCalledTimes(1);
    expect(quotes.stop).toHaveBeenCalledTimes(1);
    expect(database.close).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1000);
    expect(terminate).toHaveBeenCalledWith(1);
    expect(destroy).toHaveBeenCalled();
    expect(database.close).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith('Server shutdown timed out.');
    work.resolve(); finishHttp(); closing.resolve(); await lifecycle.stop();
    expect(database.close).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    work.resolve(); closing.resolve(); finishHttp();
    await lifecycle.stop(); socket.destroy();
    error.mockRestore(); process.exitCode = oldExitCode;
    jest.useRealTimers();
  }
});
