import { CoinMarketCapClient } from './coinmarketcap';
import { CoinMarketCapError } from './coinmarketcap-error';
import { CoinQuote, QuoteRequestOptions, QuotesBatch } from './coinmarketcap-types';

/** Per-process quota waiting and cancellation, shared by HTTP and background calls. */
export class ManagedQuotes {
  private stopping = false;
  private readonly controllers = new Set<AbortController>();
  private readonly requests = new Set<Promise<unknown>>();
  private blockedUntil = 0;
  private limit?: CoinMarketCapError['rateLimit'];

  constructor(private readonly client: Pick<CoinMarketCapClient, 'getQuote' | 'getQuotes'>) {}

  get waitMs(): number { return Math.max(0, this.blockedUntil - Date.now()); }

  private observe(error: unknown): void {
    if (!(error instanceof CoinMarketCapError) || error.code !== 'RATE_LIMITED') return;
    // No documented reset timestamp in quotes/latest. These are conservative waiting
    // periods, NOT a claim about the provider's calendar or billing reset time.
    const fallback = error.rateLimit === 'day' ? 86_400_000 :
      error.rateLimit === 'month' ? 31 * 86_400_000 : 60_000;
    const delay = Math.max(60_000, error.retryAfterMs ?? fallback);
    const until = Math.min(Number.MAX_SAFE_INTEGER, Date.now() + delay);
    if (until > this.blockedUntil) {
      this.blockedUntil = until;
      this.limit = error.rateLimit;
    }
  }

  private async request<T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.stopping || signal?.aborted) throw new CoinMarketCapError('CANCELLED');
    if (this.waitMs > 0) {
      throw new CoinMarketCapError('RATE_LIMITED', { rateLimit: this.limit, retryAfterMs: this.waitMs });
    }
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    this.controllers.add(controller);
    signal?.addEventListener('abort', abort, { once: true });
    const request = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new CoinMarketCapError('CANCELLED');
      return operation(controller.signal);
    });
    this.requests.add(request);
    try {
      const result = await request;
      if (controller.signal.aborted) throw new CoinMarketCapError('CANCELLED');
      return result;
    } catch (error) {
      this.observe(error);
      throw error;
    } finally {
      this.requests.delete(request);
      this.controllers.delete(controller);
      signal?.removeEventListener('abort', abort);
    }
  }

  getQuote(cmcId: number, options: QuoteRequestOptions = {}): Promise<CoinQuote> {
    return this.request(signal => this.client.getQuote(cmcId, { signal }), options.signal);
  }

  getQuotes(cmcIds: readonly number[], options: QuoteRequestOptions = {}): Promise<QuotesBatch> {
    return this.request(signal => this.client.getQuotes(cmcIds, { signal }), options.signal);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled([...this.requests]);
  }
}
