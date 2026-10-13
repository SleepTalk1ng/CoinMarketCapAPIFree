import { createServer, Server } from 'node:http';
import { join } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { createApp } from './app';
import { AppConfig, ConfigurationError, readConfig } from './config';
import { openDatabase } from './db/database';
import { CoinMarketCapClient } from './integrations/coinmarketcap';
import { ManagedQuotes } from './integrations/managed-quotes';
import { PriceSync } from './jobs/price-sync';
import { CryptocurrencyRepository } from './repositories/cryptocurrencies';
import { PriceHistoryRepository } from './repositories/price-history';
import { CryptocurrencyService } from './services/cryptocurrencies';
import { PriceService, PriceUpdater } from './services/prices';
import { installShutdown, ShutdownOptions } from './shutdown';

export interface RunningServer extends Server {
  /** Await HTTP/background/provider completion and database closure. Idempotent. */
  shutdown(): Promise<void>;
}

export async function startServer(config: AppConfig, options: ShutdownOptions = {}): Promise<RunningServer> {
  const database = await openDatabase(config.databasePath);
  let shutdown: ReturnType<typeof installShutdown> | undefined;
  try {
    const coins = new CryptocurrencyRepository(database);
    const history = new PriceHistoryRepository(database);
    const quotes = new ManagedQuotes(new CoinMarketCapClient(config));
    const cryptocurrencies = new CryptocurrencyService(coins, quotes);
    const updater = new PriceUpdater(history, quotes);
    const prices = new PriceService(coins, history, updater);
    const job = new PriceSync(coins, updater, config.syncIntervalMs, quotes);
    const app = createApp({ serviceApiKey: config.serviceApiKey, cryptocurrencies, prices,
      viewerDirectory: join(__dirname, '..', 'local-view'),
    });
    const server = createServer((request, response) => {
      if (shutdown?.stopping) {
        response.writeHead(503, { 'Content-Type': 'application/json', Connection: 'close' });
        response.end(JSON.stringify({ error: { code: 'SERVER_STOPPING', message: 'Server is stopping.' } }));
      } else app(request, response);
    });
    shutdown = installShutdown(server, database, job, quotes, config.shutdownTimeoutMs, options);
    const running = Object.assign(server, { shutdown: shutdown.stop });
    await new Promise<void>((resolveListening, reject) => {
      const failed = (error: Error): void => reject(error);
      server.once('error', failed);
      server.listen(config.port, () => {
        server.removeListener('error', failed);
        resolveListening();
      });
    });
    server.on('error', () => {
      console.error('HTTP server failed.');
      process.exitCode = 1;
      void running.shutdown();
    });
    console.info(`HTTP server listening on port ${config.port}.`);
    void job.start();
    return running;
  } catch (error) {
    if (shutdown) await shutdown.stop();
    else await database.close();
    throw error;
  }
}

if (require.main === module) {
  try {
    loadEnv({ quiet: true });
    void startServer(readConfig()).catch(() => {
      console.error('Server startup failed.');
      process.exitCode = 1;
    });
  } catch (error: unknown) {
    console.error(error instanceof ConfigurationError ? error.message : 'Server startup failed.');
    process.exitCode = 1;
  }
}
