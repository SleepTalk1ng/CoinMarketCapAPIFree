import { CoinMarketCapError } from '../integrations/coinmarketcap-error';
import { CryptocurrencyRepository } from '../repositories/cryptocurrencies';
import { PriceUpdater } from '../services/prices';

const MAX_TIMER_MS = 2_147_483_647;

/** One pass at startup, then a timeout scheduled only after the previous pass settles. */
export class PriceSync {
  private stopped = false;
  private started = false;
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private readonly cancellation = new AbortController();

  constructor(
    private readonly coins: Pick<CryptocurrencyRepository, 'listTrackingEnabled'>,
    private readonly updater: Pick<PriceUpdater, 'refresh'>,
    private readonly intervalMs: number,
    private readonly quota: { readonly waitMs: number },
  ) {}

  start(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.started) return this.running ?? Promise.resolve();
    this.started = true;
    return this.run();
  }

  private schedule(notBefore: number): void {
    if (this.stopped) return;
    // A monthly cooldown exceeds Node's timer range; never let it overflow to 1 ms.
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const next = Math.max(notBefore, Date.now() + this.quota.waitMs);
      if (next > Date.now()) this.schedule(next);
      else void this.run();
    }, Math.min(MAX_TIMER_MS, Math.max(1, notBefore - Date.now())));
  }

  private run(): Promise<void> {
    this.running = this.pass().finally(() => {
      this.running = undefined;
      this.schedule(Date.now() + Math.max(this.intervalMs, this.quota.waitMs));
    });
    return this.running;
  }

  private async pass(): Promise<void> {
    try {
      if (this.stopped || this.quota.waitMs > 0) return;
      const coins = await this.coins.listTrackingEnabled();
      if (this.stopped || coins.length === 0) return;
      const result = await this.updater.refresh(coins, {
        signal: this.cancellation.signal, trackingOnly: true,
      });
      for (const issue of result.issues) console.warn(`Price sync skipped UCID ${issue.cmcId}: ${issue.code}.`);
      for (const skipped of result.skipped) console.info(`Price sync skipped UCID ${skipped}: tracking changed.`);
    } catch (error) {
      if (this.stopped) return;
      // Never pass upstream/SQLite objects, messages, headers or stacks to a logger.
      console.warn(error instanceof CoinMarketCapError ? `Price sync failed: ${error.code}.` : 'Price sync failed: INTERNAL_ERROR.');
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.cancellation.abort();
    await this.running;
  }
}
