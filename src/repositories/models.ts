export interface Cryptocurrency {
  readonly id: number;
  readonly cmcId: number;
  readonly symbol: string;
  readonly name: string;
  readonly trackingEnabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastPriceReceivedAt: string | null;
}

export interface PriceSnapshot {
  readonly id: number;
  readonly cryptocurrencyId: number;
  readonly price: number;
  readonly currency: 'USD';
  readonly receivedAt: string;
  readonly sourceUpdatedAt: string | null;
}

export interface SnapshotInput {
  readonly price: number;
  readonly receivedAt: string;
  readonly sourceUpdatedAt?: string | null;
}

export interface CreateCryptocurrencyInput {
  readonly cmcId: number;
  readonly symbol: string;
  readonly name: string;
  readonly trackingEnabled?: boolean;
}

export interface PaginationInput {
  readonly limit?: number;
  readonly offset?: number;
}

export interface Page<T> {
  readonly items: T[];
  readonly pagination: { readonly limit: number; readonly offset: number; readonly total: number };
}

export interface CryptocurrencyRow {
  id: number;
  cmc_id: number;
  symbol: string;
  name: string;
  tracking_enabled: number;
  created_at: string;
  updated_at: string;
  last_price_received_at: string | null;
}

export interface PriceSnapshotRow {
  id: number;
  cryptocurrency_id: number;
  price: number;
  received_at: string;
  source_updated_at: string | null;
}

export function toCryptocurrency(row: CryptocurrencyRow): Cryptocurrency {
  return {
    id: row.id, cmcId: row.cmc_id, symbol: row.symbol, name: row.name,
    trackingEnabled: row.tracking_enabled === 1,
    createdAt: row.created_at, updatedAt: row.updated_at,
    lastPriceReceivedAt: row.last_price_received_at,
  };
}

export function toPriceSnapshot(row: PriceSnapshotRow): PriceSnapshot {
  return {
    id: row.id, cryptocurrencyId: row.cryptocurrency_id, price: row.price, currency: 'USD',
    receivedAt: row.received_at, sourceUpdatedAt: row.source_updated_at,
  };
}

export class CryptocurrencyNotFoundError extends Error {
  constructor() {
    super('Cryptocurrency was not found.');
    this.name = 'CryptocurrencyNotFoundError';
  }
}
