import { CoinMarketCapClient } from '../integrations/coinmarketcap';
import { CoinMarketCapError } from '../integrations/coinmarketcap-error';
import { QuoteIssue, QuoteRequestOptions } from '../integrations/coinmarketcap-types';
import { HttpError } from '../http/errors';
import { CryptocurrencyRepository } from '../repositories/cryptocurrencies';
import { Cryptocurrency, CryptocurrencyNotFoundError, Page, PriceSnapshot } from '../repositories/models';
import { HistoryQuery, PriceHistoryRepository } from '../repositories/price-history';

export interface Price {
  readonly cmcId: number;
  readonly symbol: string;
  readonly price: number;
  readonly currency: 'USD';
  readonly receivedAt: string;
  readonly sourceUpdatedAt: string | null;
}

function toPrice(coin: Cryptocurrency, snapshot: PriceSnapshot): Price {
  return {
    cmcId: coin.cmcId, symbol: coin.symbol, price: snapshot.price, currency: snapshot.currency,
    receivedAt: snapshot.receivedAt, sourceUpdatedAt: snapshot.sourceUpdatedAt,
  };
}

/** Shared loading and transactional storage, usable with one coin or a batch. */
export class PriceUpdater {
  constructor(
    private readonly history: PriceHistoryRepository,
    private readonly quotes: Pick<CoinMarketCapClient, 'getQuotes'>,
  ) {}

  async refresh(coins: readonly Cryptocurrency[], options: QuoteRequestOptions & { trackingOnly?: boolean } = {}): Promise<{
    prices: Price[]; issues: readonly QuoteIssue[]; skipped: number[];
  }> {
    // Provider I/O precedes SQLite transactions; these arrays live only for this call.
    const batch = await this.quotes.getQuotes(coins.map(coin => coin.cmcId), options);
    const prices: Price[] = [];
    const skipped: number[] = [];
    for (const coin of coins) {
      if (options.signal?.aborted) throw new CoinMarketCapError('CANCELLED');
      const quote = batch.quotes.find(item => item.cmcId === coin.cmcId);
      if (!quote) continue;
      // Bind to the original record ID: deleting/re-adding a UCID cannot receive an old request's quote.
      const saved = options.trackingOnly ?
        await this.history.saveTrackingSnapshot(coin.id, quote, options.signal) :
        await this.history.saveSnapshot(coin.id, quote);
      if (!saved) { skipped.push(coin.cmcId); continue; }
      prices.push(toPrice(coin, saved));
    }
    return { prices, issues: batch.issues, skipped };
  }
}

function notFound(): HttpError {
  return new HttpError(404, 'CRYPTOCURRENCY_NOT_FOUND', 'Cryptocurrency was not found.');
}

export class PriceService {
  constructor(
    private readonly coins: CryptocurrencyRepository,
    private readonly history: PriceHistoryRepository,
    private readonly updater: PriceUpdater,
  ) {}

  private async coin(cmcId: number): Promise<Cryptocurrency> {
    const coin = await this.coins.findByCmcId(cmcId);
    if (!coin) throw notFound();
    return coin;
  }

  async refresh(cmcId: number): Promise<Price> {
    const coin = await this.coin(cmcId);
    try {
      // A paused coin still permits an explicit refresh; missing/invalid quotes are errors.
      const result = await this.updater.refresh([coin]);
      if (result.issues[0]) throw new CoinMarketCapError(result.issues[0].code);
      if (!result.prices[0]) throw new CoinMarketCapError('COIN_NOT_FOUND');
      return result.prices[0];
    } catch (error) {
      if (error instanceof CryptocurrencyNotFoundError) throw notFound();
      throw error;
    }
  }

  async latest(cmcId: number): Promise<Price> {
    const coin = await this.coin(cmcId);
    const snapshot = await this.history.findLatest(coin.id);
    if (!snapshot) throw new HttpError(404, 'PRICE_NOT_FOUND', 'No saved price was found.');
    return toPrice(coin, snapshot);
  }

  async list(cmcId: number, query: HistoryQuery): Promise<Page<Price>> {
    const coin = await this.coin(cmcId);
    const page = await this.history.list(coin.id, query);
    return { items: page.items.map(snapshot => toPrice(coin, snapshot)), pagination: page.pagination };
  }
}
