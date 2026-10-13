import express, { Express, RequestHandler } from 'express';
import swaggerUi from 'swagger-ui-express';
import { bearerAuthentication } from './http/auth';
import { cryptocurrencyRouter } from './http/cryptocurrencies';
import { errorHandler, HttpError } from './http/errors';
import { openapi } from './http/openapi';
import { priceRouter } from './http/prices';
import { CryptocurrencyService } from './services/cryptocurrencies';
import { PriceService } from './services/prices';

export interface AppDependencies {
  readonly serviceApiKey: string;
  readonly cryptocurrencies: CryptocurrencyService;
  readonly prices: PriceService;
  readonly viewerDirectory?: string;
}

export function createApp(dependencies: AppDependencies): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('query parser', 'simple');

  app.route('/openapi.json')
    .get((_request, response) => { response.json(openapi); })
    .all((_request, response, next) => {
      response.set('Allow', 'GET, HEAD');
      next(new HttpError(405, 'METHOD_NOT_ALLOWED', 'This resource supports GET and HEAD.'));
    });
  const documentationMethods: RequestHandler = (request, response, next) => {
    if (request.method === 'GET' || request.method === 'HEAD') { next(); return; }
    response.set('Allow', 'GET, HEAD');
    next(new HttpError(405, 'METHOD_NOT_ALLOWED', 'This resource supports GET and HEAD.'));
  };
  app.use('/docs', documentationMethods, swaggerUi.serve, swaggerUi.setup(undefined, {
    swaggerOptions: { url: '/openapi.json', persistAuthorization: false },
  }));

  // Authentication precedes JSON parsing, including malformed unauthenticated requests.
  app.use('/api/v1', bearerAuthentication(dependencies.serviceApiKey), express.json({ limit: '16kb' }));
  app.use('/api/v1/cryptocurrencies', cryptocurrencyRouter(dependencies.cryptocurrencies));
  app.use('/api/v1/cryptocurrencies', priceRouter(dependencies.prices));
  if (dependencies.viewerDirectory) {
    app.use('/viewer', express.static(dependencies.viewerDirectory, { index: 'index.html', etag: false, maxAge: 0 }));
  }
  app.use((_request, _response, next) => {
    next(new HttpError(404, 'NOT_FOUND', 'The requested route was not found.'));
  });
  app.use(errorHandler);
  return app;
}
