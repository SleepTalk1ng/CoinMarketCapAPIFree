import { ErrorRequestHandler } from 'express';
import { CoinMarketCapError } from '../integrations/coinmarketcap-error';

export class HttpError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

export const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, next) => {
  if (response.headersSent) { next(error); return; }
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'An unexpected internal error occurred.';
  if (error instanceof HttpError) {
    status = error.statusCode;
    code = error.code;
    message = error.message;
  } else if (error instanceof CoinMarketCapError) {
    status = error.code === 'TIMEOUT' ? 504 : error.code === 'RATE_LIMITED' ? 503 :
      error.code === 'COIN_NOT_FOUND' ? 404 : 502;
    code = `CMC_${error.code}`;
    // Use the fixed catalog, never an upstream payload or mutable error message.
    message = new CoinMarketCapError(error.code).message;
  } else if (error instanceof URIError) {
    status = 400; code = 'INVALID_REQUEST'; message = 'The request path contains invalid encoding.';
  } else if (typeof error === 'object' && error !== null && 'type' in error) {
    if (error.type === 'entity.parse.failed') {
      status = 400; code = 'INVALID_JSON'; message = 'The request body must contain valid JSON.';
    } else if (error.type === 'entity.too.large' || error.type === 'encoding.unsupported' ||
               error.type === 'charset.unsupported' || error.type === 'request.aborted' ||
               error.type === 'request.size.invalid') {
      status = 400; code = 'INVALID_REQUEST'; message = 'The request body could not be read.';
    }
  }
  response.status(status).json({ error: { code, message } });
};
