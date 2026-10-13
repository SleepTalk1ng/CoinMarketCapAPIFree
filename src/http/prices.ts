import { NextFunction, Request, Response, Router } from 'express';
import { PriceService } from '../services/prices';
import { HttpError } from './errors';
import { cmcIdParameter, historyQuery, queryFields, refreshBody } from './validation';

function asyncRoute(handler: (request: Request, response: Response) => Promise<void>) {
  return (request: Request, response: Response, next: NextFunction): void => {
    void handler(request, response).catch(next);
  };
}

export function priceRouter(service: PriceService): Router {
  const router = Router();
  router.post('/:cmcId/price/refresh', asyncRoute(async (request, response) => {
    queryFields(request.query);
    const hasBody = Number(request.headers['content-length'] ?? 0) > 0 ||
      request.headers['transfer-encoding'] !== undefined;
    if (hasBody && !request.is('application/json')) {
      throw new HttpError(400, 'INVALID_REQUEST', 'Refresh accepts only an empty application/json body.');
    }
    refreshBody(request.body);
    response.json(await service.refresh(cmcIdParameter(request.params.cmcId)));
  }));
  router.get('/:cmcId/price', asyncRoute(async (request, response) => {
    queryFields(request.query);
    response.json(await service.latest(cmcIdParameter(request.params.cmcId)));
  }));
  router.get('/:cmcId/history', asyncRoute(async (request, response) => {
    response.json(await service.list(cmcIdParameter(request.params.cmcId), historyQuery(request.query)));
  }));
  return router;
}
