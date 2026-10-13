import { timingSafeEqual } from 'node:crypto';
import { RequestHandler } from 'express';
import { HttpError } from './errors';

export function bearerAuthentication(serviceApiKey: string): RequestHandler {
  const expected = Buffer.from(serviceApiKey);
  return (request, response, next) => {
    const authorization = request.get('authorization');
    const match = typeof authorization === 'string' ? /^Bearer ([\x21-\x7e]+)$/i.exec(authorization) : null;
    let headerCount = 0;
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      if (request.rawHeaders[index]?.toLowerCase() === 'authorization') headerCount++;
    }
    const supplied = Buffer.from(match?.[1] ?? '');
    if (headerCount !== 1 || !match || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      response.set('WWW-Authenticate', 'Bearer');
      next(new HttpError(401, 'UNAUTHORIZED', 'A valid Bearer token is required.'));
      return;
    }
    next();
  };
}
