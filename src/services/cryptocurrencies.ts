import { CoinMarketCapClient } from '../integrations/coinmarketcap';
import { CryptocurrencyRepository } from '../repositories/cryptocurrencies';
import { Cryptocurrency, Page, PaginationInput } from '../repositories/models';
import { HttpError } from '../http/errors';

function notFound(): HttpError {
  return new HttpError(404, 'CRYPTOCURRENCY_NOT_FOUND', 'Cryptocurrency was not found.');
}

function duplicate(): HttpError {
  return new HttpError(409, 'CRYPTOCURRENCY_ALREADY_EXISTS', 'This CoinMarketCap ID is already tracked.');
}

export class CryptocurrencyService {
  constructor(
    private readonly repository: CryptocurrencyRepository,
    private readonly quotes: Pick<CoinMarketCapClient, 'getQuote'>,
  ) {}

  async create(cmcId: number): Promise<Cryptocurrency> {
    if (await this.repository.findByCmcId(cmcId)) throw duplicate();
    // Do not hold the SQLite transaction open while waiting for the provider.
    const quote = await this.quotes.getQuote(cmcId);
    try {
      const created = await this.repository.createWithFirstSnapshot(
        { cmcId, name: quote.name, symbol: quote.symbol },
        { price: quote.price, receivedAt: quote.receivedAt, sourceUpdatedAt: quote.sourceUpdatedAt },
      );
      return created.cryptocurrency;
    } catch (error: unknown) {
      // UNIQUE remains the authority when concurrent creates pass the pre-check.
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'SQLITE_CONSTRAINT' &&
          'message' in error && typeof error.message === 'string' &&
          error.message.includes('UNIQUE constraint failed: cryptocurrencies.cmc_id')) {
        throw duplicate();
      }
      throw error;
    }
  }

  list(query: PaginationInput): Promise<Page<Cryptocurrency>> {
    return this.repository.list(query);
  }

  async get(cmcId: number): Promise<Cryptocurrency> {
    const coin = await this.repository.findByCmcId(cmcId);
    if (!coin) throw notFound();
    return coin;
  }

  async patch(cmcId: number, trackingEnabled: boolean): Promise<Cryptocurrency> {
    const coin = await this.repository.setTrackingEnabledByCmcId(cmcId, trackingEnabled);
    if (!coin) throw notFound();
    return coin;
  }

  async delete(cmcId: number): Promise<void> {
    if (!await this.repository.deleteByCmcId(cmcId)) throw notFound();
  }
}
