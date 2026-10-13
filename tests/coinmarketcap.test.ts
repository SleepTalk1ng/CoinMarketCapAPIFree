import { inspect } from 'node:util';
import axios, { AxiosError, AxiosHeaders, CanceledError } from 'axios';
import { CoinMarketCapClient } from '../src/integrations/coinmarketcap';
import { CoinMarketCapError } from '../src/integrations/coinmarketcap-error';
import { CmcCryptocurrencyV3, CmcQuotesResponseV3 } from '../src/integrations/coinmarketcap-types';

// No transformer/hoisting: replace get directly before any client request.
const get = jest.spyOn(axios, 'get');
const TEST_KEY = 'mock-only-cmc-key';
const RECEIVED = '2026-10-07T12:00:00.000Z';
const SOURCE = '2026-10-07T11:59:00.000Z';
const BTC: CmcCryptocurrencyV3 = {
  id: 1, name: 'Bitcoin', symbol: 'BTC', last_updated: SOURCE,
  quote: [{ id: 2781, symbol: 'USD', price: 60000, last_updated: SOURCE }],
};
const ETH: CmcCryptocurrencyV3 = {
  id: 1027, name: 'Ethereum', symbol: 'ETH', last_updated: SOURCE,
  quote: [{ id: 2781, symbol: 'USD', price: 2500, last_updated: SOURCE }],
};

function envelope(data: readonly CmcCryptocurrencyV3[], errorCode: number | string = 0): CmcQuotesResponseV3 {
  return { status: { error_code: errorCode, timestamp: RECEIVED }, data };
}

function respond(body: unknown): void {
  get.mockResolvedValueOnce({ data: body, status: 200, headers: {} });
}

function rejectHttp(status: number, body: unknown, headers: Record<string, string> = {}): void {
  const config = { headers: new AxiosHeaders({ 'X-CMC_PRO_API_KEY': TEST_KEY }) };
  get.mockRejectedValueOnce(new AxiosError(`Unsafe upstream text: ${TEST_KEY}`, 'ERR_BAD_RESPONSE', config, {}, {
    status, statusText: TEST_KEY, data: body, headers, config,
  }));
}

describe('CoinMarketCap v3 client', () => {
  let client: CoinMarketCapClient;

  beforeEach(() => {
    get.mockReset();
    jest.useFakeTimers({ now: new Date(RECEIVED) });
    client = new CoinMarketCapClient({ cmcApiKey: TEST_KEY, cmcTimeoutMs: 5000 });
  });

  afterEach(() => jest.useRealTimers());

  it('loads one USD quote with numeric success, retaining zero price and separate receipt/source times', async () => {
    respond(envelope([{ ...BTC, quote: [{ id: 2781, symbol: 'USD', price: 0, last_updated: SOURCE }] }]));
    await expect(client.getQuote(1)).resolves.toEqual({
      cmcId: 1, name: 'Bitcoin', symbol: 'BTC', price: 0, currency: 'USD',
      receivedAt: RECEIVED, sourceUpdatedAt: SOURCE,
    });
    expect(get).toHaveBeenCalledWith('https://pro-api.coinmarketcap.com/v3/cryptocurrency/quotes/latest',
      expect.objectContaining({
        params: { id: '1', convert: 'USD', skip_invalid: 'true' }, timeout: 5000,
        headers: { Accept: 'application/json', 'X-CMC_PRO_API_KEY': TEST_KEY },
      }));
  });

  it('matches a reordered batch by CMC ID with string success and finds USD within the currency array', async () => {
    respond(envelope([ETH, { ...BTC, quote: [
      { id: 2790, symbol: 'EUR', price: 50000, last_updated: SOURCE }, ...BTC.quote,
    ] }], '0'));
    const result = await client.getQuotes([1, 1027, 1]);
    expect(result.quotes).toEqual([
      { cmcId: 1, name: 'Bitcoin', symbol: 'BTC', price: 60000, currency: 'USD', receivedAt: RECEIVED, sourceUpdatedAt: SOURCE },
      { cmcId: 1027, name: 'Ethereum', symbol: 'ETH', price: 2500, currency: 'USD', receivedAt: RECEIVED, sourceUpdatedAt: SOURCE },
    ]);
    expect(result.issues).toEqual([]);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0]?.[1]?.params).toEqual({ id: '1,1027', convert: 'USD', skip_invalid: 'true' });
  });

  it('reports timeout safely without retrying', async () => {
    get.mockRejectedValueOnce(new AxiosError(TEST_KEY, 'ECONNABORTED'));
    await expect(client.getQuote(1)).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('cancels an in-flight request with AbortController and prevents requests using an already aborted signal', async () => {
    const controller = new AbortController();
    get.mockImplementationOnce((_url, config) => new Promise((_resolve, reject) => {
      config?.signal?.addEventListener?.('abort', () => reject(new CanceledError(TEST_KEY)), { once: true });
    }));
    const request = client.getQuote(1, { signal: controller.signal });
    const rejected = expect(request).rejects.toMatchObject({ code: 'CANCELLED' });
    controller.abort();
    await rejected;
    await expect(client.getQuotes([1], { signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('turns a connection failure into a safe network error', async () => {
    get.mockRejectedValueOnce(new AxiosError(TEST_KEY, 'ECONNRESET'));
    await expect(client.getQuote(1)).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('reports provider 5xx even with a non-JSON body', async () => {
    rejectHttp(503, `<html>${TEST_KEY}</html>`);
    await expect(client.getQuote(1)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', providerHttpStatus: 503 });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('exposes a minute limit and numeric Retry-After for later scheduling without a retry', async () => {
    rejectHttp(429, { status: { error_code: '1008', error_message: TEST_KEY } }, { 'retry-after': '60' });
    await expect(client.getQuotes([1, 1027])).rejects.toMatchObject({
      code: 'RATE_LIMITED', providerHttpStatus: 429, providerCode: 1008, rateLimit: 'minute', retryAfterMs: 60000,
    });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('distinguishes monthly exhaustion in an HTTP 200 error body and parses an HTTP-date Retry-After', async () => {
    get.mockResolvedValueOnce({ status: 200, headers: { 'retry-after': 'Wed, 07 Oct 2026 12:05:00 GMT' },
      data: { status: { error_code: 1010, error_message: TEST_KEY } } });
    await expect(client.getQuote(1)).rejects.toMatchObject({
      code: 'RATE_LIMITED', providerCode: 1010, rateLimit: 'month', retryAfterMs: 300000,
    });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('does not expose the key, axios config, response body or raw cause when credentials are rejected', async () => {
    rejectHttp(401, { status: { error_code: '1001', error_message: TEST_KEY } });
    const error = await client.getQuote(1).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CoinMarketCapError);
    expect(error).toMatchObject({ code: 'PROVIDER_AUTH_ERROR', providerHttpStatus: 401, providerCode: 1001 });
    expect(`${String(error)} ${JSON.stringify(error)} ${inspect(error)}`).not.toContain(TEST_KEY);
    expect(error).not.toHaveProperty('cause');
    expect(inspect(client)).not.toContain(TEST_KEY);
  });

  it('rejects a nonzero status in HTTP 200 instead of accepting otherwise valid quotes', async () => {
    respond(envelope([BTC], '500'));
    await expect(client.getQuote(1)).rejects.toMatchObject({ code: 'PROVIDER_ERROR', providerCode: 500 });
  });

  it('rejects the legacy object-map data envelope', async () => {
    respond({ ...envelope([]), data: { '1': BTC } });
    await expect(client.getQuote(1)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('returns good quotes and reports invalid and missing coins explicitly in a partial batch', async () => {
    respond({ ...envelope([]), data: [BTC, {
      ...ETH, quote: [{ id: 2781, symbol: 'USD', price: null, last_updated: SOURCE }],
    }] });
    const result = await client.getQuotes([1, 1027, 825]);
    expect(result.quotes).toEqual([expect.objectContaining({ cmcId: 1, price: 60000 })]);
    expect(result.issues).toEqual([{ cmcId: 1027, code: 'INVALID_QUOTE' }, { cmcId: 825, code: 'COIN_NOT_FOUND' }]);
  });

  it('fails a single-coin lookup when the provider omits it', async () => {
    respond(envelope([]));
    await expect(client.getQuote(1)).rejects.toMatchObject({ code: 'COIN_NOT_FOUND' });
  });

  it('rejects a response containing an unrequested identity', async () => {
    respond(envelope([BTC, ETH]));
    await expect(client.getQuote(1)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('rejects duplicate returned IDs instead of choosing an ambiguous price', async () => {
    respond(envelope([BTC, { ...BTC, quote: [{ id: 2781, symbol: 'USD', price: 1, last_updated: SOURCE }] }]));
    await expect(client.getQuotes([1, 1027])).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});
