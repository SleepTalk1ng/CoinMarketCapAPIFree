/** Minimal v3 fields consumed by the client; all incoming JSON is still unknown. */
export interface CmcQuoteV3 {
  readonly id: number;
  readonly symbol: string;
  readonly price: number;
  readonly last_updated: string;
}

export interface CmcCryptocurrencyV3 {
  readonly id: number;
  readonly name: string;
  readonly symbol: string;
  readonly last_updated?: string;
  readonly quote: readonly CmcQuoteV3[];
}

export interface CmcQuotesResponseV3 {
  readonly status: {
    readonly error_code: number | string;
    readonly timestamp: string;
  };
  readonly data: readonly CmcCryptocurrencyV3[];
}

export interface CoinQuote {
  readonly cmcId: number;
  readonly name: string;
  readonly symbol: string;
  readonly price: number;
  readonly currency: 'USD';
  readonly receivedAt: string;
  readonly sourceUpdatedAt: string;
}

export interface QuoteIssue {
  readonly cmcId: number;
  readonly code: 'COIN_NOT_FOUND' | 'INVALID_QUOTE';
}

export interface QuotesBatch {
  readonly quotes: readonly CoinQuote[];
  readonly issues: readonly QuoteIssue[];
}

export interface QuoteRequestOptions {
  readonly signal?: AbortSignal;
}
