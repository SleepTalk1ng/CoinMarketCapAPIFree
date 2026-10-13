import { PaginationInput, SnapshotInput } from './models';

export function positiveId(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError('ID must be a positive safe integer.');
}

export function nonEmptyText(value: string): void {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new TypeError('Name and symbol must be non-empty text without NUL.');
  }
}

export function booleanFlag(value: boolean): void {
  if (typeof value !== 'boolean') throw new TypeError('trackingEnabled must be boolean.');
}

/** Reject calendar rollover, missing timezones and sub-millisecond precision; store canonical UTC. */
export function utcTimestamp(value: string): string {
  if (typeof value !== 'string') throw new TypeError('Timestamp must be an ISO 8601 string with a timezone.');
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw new TypeError('Timestamp must be an ISO 8601 string with a timezone.');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  const milliseconds = Date.parse(value);
  if (monthDays === undefined || day < 1 || day > monthDays || Number(match[4]) > 23 ||
      Number(match[5]) > 59 || Number(match[6]) > 59 || !Number.isFinite(milliseconds)) {
    throw new TypeError('Timestamp must contain a valid calendar date and time.');
  }
  const canonical = new Date(milliseconds).toISOString();
  if (canonical.length !== 24) throw new TypeError('Timestamp year must be between 0000 and 9999 in UTC.');
  return canonical;
}

export function snapshotInput(input: SnapshotInput): Required<SnapshotInput> {
  if (typeof input.price !== 'number' || !Number.isFinite(input.price) || input.price < 0) {
    throw new TypeError('Price must be a finite non-negative number.');
  }
  return {
    price: input.price,
    receivedAt: utcTimestamp(input.receivedAt),
    sourceUpdatedAt: input.sourceUpdatedAt == null ? null : utcTimestamp(input.sourceUpdatedAt),
  };
}

export function pagination(input: PaginationInput): { limit: number; offset: number } {
  const limit = input.limit === undefined ? 50 : input.limit;
  const offset = input.offset === undefined ? 0 : input.offset;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) {
    throw new TypeError('Pagination requires limit 1–100 and a non-negative safe integer offset.');
  }
  return { limit, offset };
}
