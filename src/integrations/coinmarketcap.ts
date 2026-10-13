import axios from 'axios';
import { AppConfig } from '../config';
import { utcTimestamp } from '../repositories/validation';
import { CoinMarketCapError, CoinMarketCapErrorDetails } from './coinmarketcap-error';
import { CoinQuote, QuoteIssue, QuoteRequestOptions, QuotesBatch } from './coinmarketcap-types';

const QUOTES_URL = 'https://pro-api.coinmarketcap.com/v3/cryptocurrency/quotes/latest';
const USD_ID = 2781;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function providerCode(body: unknown): number | undefined {
  if (!isRecord(body) || !isRecord(body.status)) return undefined;
  const raw = body.status.error_code;
  if (typeof raw !== 'number' && (typeof raw !== 'string' || !/^(0|[1-9]\d*)$/.test(raw))) {
    return undefined;
  }
  const code = Number(raw);
  return Number.isSafeInteger(code) && code >= 0 ? code : undefined;
}

function retryAfterMs(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const text = String(value).trim();
  if (/^\d+$/.test(text)) {
    const milliseconds = Number(text) * 1000;
    return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
  }
  // Only accept the HTTP-date form, never return arbitrary provider header text.
  if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text)) {
    return undefined;
  }
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined;
}

function providerError(body: unknown, httpStatus?: number, retryAfter?: unknown): CoinMarketCapError {
  const code = providerCode(body);
  const details: CoinMarketCapErrorDetails = {
    providerHttpStatus: httpStatus,
    providerCode: code,
  };
  if (httpStatus === 429 || (code !== undefined && code >= 1008 && code <= 1011)) {
    const rateLimit = code === 1008 ? 'minute' : code === 1009 ? 'day' :
      code === 1010 ? 'month' : code === 1011 ? 'ip' : 'unknown';
    return new CoinMarketCapError('RATE_LIMITED', {
      ...details, rateLimit, retryAfterMs: retryAfterMs(retryAfter),
    });
  }
  if (httpStatus !== undefined && httpStatus >= 500) {
    return new CoinMarketCapError('PROVIDER_UNAVAILABLE', details);
  }
  if (httpStatus === 401 || httpStatus === 402 || httpStatus === 403 ||
      (code !== undefined && code >= 1001 && code <= 1007)) {
    return new CoinMarketCapError('PROVIDER_AUTH_ERROR', details);
  }
  return new CoinMarketCapError('PROVIDER_ERROR', details);
}

function transportError(error: unknown, signal?: AbortSignal): CoinMarketCapError {
  if (signal?.aborted || axios.isCancel(error)) return new CoinMarketCapError('CANCELLED');
  if (!axios.isAxiosError(error)) return new CoinMarketCapError('NETWORK_ERROR');
  if (error.code === 'ERR_CANCELED') return new CoinMarketCapError('CANCELLED');
  if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
    return new CoinMarketCapError('TIMEOUT');
  }
  if (error.response) {
    return providerError(error.response.data, error.response.status, error.response.headers['retry-after']);
  }
  return new CoinMarketCapError('NETWORK_ERROR');
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Invalid timestamp.');
  return utcTimestamp(value);
}

function validText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(value);
}

function parseQuote(coin: Record<string, unknown>, cmcId: number, receivedAt: string): CoinQuote | undefined {
  if (!validText(coin.name) || !validText(coin.symbol) || !Array.isArray(coin.quote)) return undefined;
  // USD's ID and symbol must agree when both are present; either alone can identify it.
  const candidates = coin.quote.filter((quote: unknown) =>
    isRecord(quote) && (quote.id === USD_ID || quote.symbol === 'USD'));
  if (candidates.length !== 1) return undefined;
  const usd: unknown = candidates[0];
  if (!isRecord(usd) || (usd.id !== undefined && usd.id !== USD_ID) ||
      (usd.symbol !== undefined && usd.symbol !== 'USD') ||
      typeof usd.price !== 'number' || !Number.isFinite(usd.price) || usd.price < 0) return undefined;
  try {
    if (coin.last_updated !== undefined) timestamp(coin.last_updated);
    return {
      cmcId, name: coin.name.trim(), symbol: coin.symbol.trim(), price: usd.price,
      currency: 'USD', receivedAt, sourceUpdatedAt: timestamp(usd.last_updated),
    };
  } catch {
    return undefined;
  }
}

function parseBatch(body: unknown, ids: readonly number[], receivedAt: string, httpStatus: number, retryAfter?: unknown): QuotesBatch {
  const code = providerCode(body);
  if (code === undefined) throw new CoinMarketCapError('INVALID_RESPONSE');
  if (code !== 0) throw providerError(body, httpStatus, retryAfter);
  if (!isRecord(body) || !isRecord(body.status) || !Array.isArray(body.data)) {
    throw new CoinMarketCapError('INVALID_RESPONSE');
  }
  try {
    timestamp(body.status.timestamp);
  } catch {
    throw new CoinMarketCapError('INVALID_RESPONSE');
  }

  // These collections exist only for this response, never as application storage.
  const requested = new Set(ids);
  const returned = new Map<number, Record<string, unknown>>();
  for (const coin of body.data as unknown[]) {
    if (!isRecord(coin) || typeof coin.id !== 'number' || !Number.isSafeInteger(coin.id) ||
        !requested.has(coin.id) || returned.has(coin.id)) {
      // An unexpected or ambiguous identity makes the entire envelope untrustworthy.
      throw new CoinMarketCapError('INVALID_RESPONSE');
    }
    returned.set(coin.id, coin);
  }
  const quotes: CoinQuote[] = [];
  const issues: QuoteIssue[] = [];
  for (const cmcId of ids) {
    const coin = returned.get(cmcId);
    if (!coin) {
      issues.push({ cmcId, code: 'COIN_NOT_FOUND' });
      continue;
    }
    const quote = parseQuote(coin, cmcId, receivedAt);
    if (quote) quotes.push(quote);
    else issues.push({ cmcId, code: 'INVALID_QUOTE' });
  }
  return { quotes, issues };
}

export class CoinMarketCapClient {
  // Native private fields keep the key out of serialization and object inspection.
  readonly #apiKey: string;
  readonly #timeoutMs: number;

  constructor(config: Pick<AppConfig, 'cmcApiKey' | 'cmcTimeoutMs'>) {
    if (typeof config.cmcApiKey !== 'string' || !/^[\x21-\x7e]+$/.test(config.cmcApiKey) ||
        !Number.isSafeInteger(config.cmcTimeoutMs) || config.cmcTimeoutMs < 1 || config.cmcTimeoutMs > 2_147_483_647) {
      throw new TypeError('CoinMarketCap requires a key and a positive timer-safe timeout.');
    }
    this.#apiKey = config.cmcApiKey;
    this.#timeoutMs = config.cmcTimeoutMs;
  }

  /** One request for all unique IDs; no invented provider batch cap, retries or cache. */
  async getQuotes(cmcIds: readonly number[], options: QuoteRequestOptions = {}): Promise<QuotesBatch> {
    if (!Array.isArray(cmcIds)) {
      throw new TypeError('CoinMarketCap IDs must be positive safe integers.');
    }
    const ids = [...new Set(cmcIds)];
    if (ids.some(id => !Number.isSafeInteger(id) || id <= 0)) {
      throw new TypeError('CoinMarketCap IDs must be positive safe integers.');
    }
    if (options.signal?.aborted) throw new CoinMarketCapError('CANCELLED');
    if (ids.length === 0) return { quotes: [], issues: [] };

    let response;
    try {
      response = await axios.get<unknown>(QUOTES_URL, {
        params: { id: ids.join(','), convert: 'USD', skip_invalid: 'true' },
        headers: { Accept: 'application/json', 'X-CMC_PRO_API_KEY': this.#apiKey },
        timeout: this.#timeoutMs,
        signal: options.signal,
        maxRedirects: 0,
      });
    } catch (error: unknown) {
      throw transportError(error, options.signal);
    }
    if (options.signal?.aborted) throw new CoinMarketCapError('CANCELLED');
    if (response.status < 200 || response.status >= 300) {
      throw providerError(response.data, response.status, response.headers['retry-after']);
    }
    return parseBatch(response.data, ids, new Date().toISOString(), response.status, response.headers['retry-after']);
  }

  /** Single-coin operations must not silently accept a missing or invalid quote. */
  async getQuote(cmcId: number, options: QuoteRequestOptions = {}): Promise<CoinQuote> {
    const batch = await this.getQuotes([cmcId], options);
    const quote = batch.quotes[0];
    if (quote) return quote;
    throw new CoinMarketCapError(batch.issues[0]?.code ?? 'COIN_NOT_FOUND');
  }
}
