import { PaginationInput } from '../repositories/models';
import { HistoryQuery } from '../repositories/price-history';
import { utcTimestamp } from '../repositories/validation';
import { HttpError } from './errors';

function invalid(message: string): never {
  throw new HttpError(400, 'INVALID_REQUEST', message);
}

export function cmcIdParameter(raw: unknown): number {
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) invalid('cmcId (UCID) must be a positive safe integer.');
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) invalid('cmcId (UCID) must be a positive safe integer.');
  return value;
}

function bodyField(body: unknown, field: string): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body) ||
      Object.keys(body).length !== 1 || !Object.hasOwn(body, field)) {
    invalid(`The JSON body must contain only ${field}.`);
  }
  return (body as Record<string, unknown>)[field];
}

export function createBody(body: unknown): number {
  const cmcId = bodyField(body, 'cmcId');
  if (typeof cmcId !== 'number' || !Number.isSafeInteger(cmcId) || cmcId < 1) {
    invalid('cmcId must be a positive safe integer.');
  }
  return cmcId;
}

export function patchBody(body: unknown): boolean {
  const enabled = bodyField(body, 'trackingEnabled');
  if (typeof enabled !== 'boolean') invalid('trackingEnabled must be boolean.');
  return enabled;
}

export function queryFields(query: object, allowed: readonly string[] = []): void {
  if (Object.keys(query).some(key => !allowed.includes(key))) invalid('The query contains unsupported parameters.');
}

export function listQuery(query: Record<string, unknown>): PaginationInput {
  queryFields(query, ['limit', 'offset']);
  const integer = (raw: unknown, fallback: number): number => {
    if (raw === undefined) return fallback;
    if (typeof raw !== 'string' || !/^\d+$/.test(raw)) invalid('Pagination parameters must be integers.');
    const value = Number(raw);
    if (!Number.isSafeInteger(value)) invalid('Pagination parameters must be safe integers.');
    return value;
  };
  const limit = integer(query.limit, 50);
  const offset = integer(query.offset, 0);
  if (limit < 1 || limit > 100 || offset < 0) invalid('Pagination requires limit 1–100 and offset >= 0.');
  return { limit, offset };
}

export function refreshBody(body: unknown): void {
  if (body !== undefined && (typeof body !== 'object' || body === null || Array.isArray(body) ||
      Object.keys(body).length !== 0)) invalid('Refresh accepts no body or an empty JSON object.');
}

export function historyQuery(query: Record<string, unknown>): HistoryQuery {
  queryFields(query, ['from', 'to', 'limit', 'offset']);
  const page = listQuery({ limit: query.limit, offset: query.offset });
  const date = (raw: unknown): string | undefined => {
    if (raw === undefined) return undefined;
    if (typeof raw !== 'string') invalid('History dates must be supplied once each.');
    try { return utcTimestamp(raw); }
    catch { invalid('History dates must be valid ISO 8601 timestamps with a timezone and at most millisecond precision.'); }
  };
  const from = date(query.from);
  const to = date(query.to);
  if (from !== undefined && to !== undefined && from > to) invalid('History requires from <= to.');
  return { ...page, from, to };
}
