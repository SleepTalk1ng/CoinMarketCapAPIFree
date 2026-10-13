import { NextFunction, Request, Response, Router } from 'express';
import { CryptocurrencyService } from '../services/cryptocurrencies';
import { cmcIdParameter, createBody, listQuery, patchBody, queryFields } from './validation';

function asyncRoute(handler: (request: Request, response: Response) => Promise<void>) {
  return (request: Request, response: Response, next: NextFunction): void => {
    void handler(request, response).catch(next);
  };
}

export function cryptocurrencyRouter(service: CryptocurrencyService): Router {
  const router = Router();
  router.post('/', asyncRoute(async (request, response) => {
    queryFields(request.query);
    const coin = await service.create(createBody(request.body));
    response.location(`/api/v1/cryptocurrencies/${coin.cmcId}`).status(201).json(coin);
  }));
  router.get('/', asyncRoute(async (request, response) => {
    response.json(await service.list(listQuery(request.query)));
  }));
  router.get('/:cmcId', asyncRoute(async (request, response) => {
    queryFields(request.query);
    response.json(await service.get(cmcIdParameter(request.params.cmcId)));
  }));
  router.patch('/:cmcId', asyncRoute(async (request, response) => {
    queryFields(request.query);
    response.json(await service.patch(cmcIdParameter(request.params.cmcId), patchBody(request.body)));
  }));
  router.delete('/:cmcId', asyncRoute(async (request, response) => {
    queryFields(request.query);
    await service.delete(cmcIdParameter(request.params.cmcId));
    response.status(204).end();
  }));
  return router;
}
