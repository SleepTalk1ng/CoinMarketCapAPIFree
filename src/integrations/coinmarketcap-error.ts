export type CoinMarketCapErrorCode =
  | 'TIMEOUT' | 'CANCELLED' | 'NETWORK_ERROR' | 'PROVIDER_UNAVAILABLE'
  | 'RATE_LIMITED' | 'PROVIDER_AUTH_ERROR' | 'PROVIDER_ERROR'
  | 'INVALID_RESPONSE' | 'COIN_NOT_FOUND' | 'INVALID_QUOTE';

export interface CoinMarketCapErrorDetails {
  readonly providerHttpStatus?: number;
  readonly providerCode?: number;
  readonly rateLimit?: 'minute' | 'day' | 'month' | 'ip' | 'unknown';
  readonly retryAfterMs?: number;
}

const messages: Record<CoinMarketCapErrorCode, string> = {
  TIMEOUT: 'CoinMarketCap request timed out.',
  CANCELLED: 'CoinMarketCap request was cancelled.',
  NETWORK_ERROR: 'CoinMarketCap could not be reached.',
  PROVIDER_UNAVAILABLE: 'CoinMarketCap is temporarily unavailable.',
  RATE_LIMITED: 'CoinMarketCap request quota or rate limit was reached.',
  PROVIDER_AUTH_ERROR: 'CoinMarketCap rejected the credentials or API plan.',
  PROVIDER_ERROR: 'CoinMarketCap rejected the request.',
  INVALID_RESPONSE: 'CoinMarketCap returned an invalid response.',
  COIN_NOT_FOUND: 'CoinMarketCap did not return the requested cryptocurrency.',
  INVALID_QUOTE: 'CoinMarketCap returned an invalid cryptocurrency quote.',
};

/** Never retain an axios error, its cause, request config, headers or provider text. */
export class CoinMarketCapError extends Error {
  readonly providerHttpStatus?: number;
  readonly providerCode?: number;
  readonly rateLimit?: CoinMarketCapErrorDetails['rateLimit'];
  readonly retryAfterMs?: number;

  constructor(readonly code: CoinMarketCapErrorCode, details: CoinMarketCapErrorDetails = {}) {
    super(messages[code]);
    this.name = 'CoinMarketCapError';
    this.providerHttpStatus = details.providerHttpStatus;
    this.providerCode = details.providerCode;
    this.rateLimit = details.rateLimit;
    this.retryAfterMs = details.retryAfterMs;
  }
}
