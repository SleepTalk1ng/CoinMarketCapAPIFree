import { Database } from '../db/database';
import {
  CreateCryptocurrencyInput, Cryptocurrency, CryptocurrencyRow, Page, PaginationInput,
  PriceSnapshot, SnapshotInput, toCryptocurrency,
} from './models';
import { insertSnapshot } from './price-history';
import { booleanFlag, nonEmptyText, pagination, positiveId, snapshotInput, utcTimestamp } from './validation';

export class CryptocurrencyRepository {
  constructor(private readonly database: Database) {}

  async createWithFirstSnapshot(
    input: CreateCryptocurrencyInput, firstSnapshot: SnapshotInput,
  ): Promise<{ cryptocurrency: Cryptocurrency; snapshot: PriceSnapshot }> {
    const { cmcId, symbol, name } = input;
    positiveId(cmcId);
    nonEmptyText(symbol);
    nonEmptyText(name);
    const trackingEnabled = input.trackingEnabled === undefined ? true : input.trackingEnabled;
    booleanFlag(trackingEnabled);
    const first = snapshotInput(firstSnapshot);
    return this.database.transaction(async (sql) => {
      const inserted = await sql.run(
        `INSERT INTO cryptocurrencies
         (cmc_id, symbol, name, tracking_enabled, created_at, updated_at, last_price_received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [cmcId, symbol, name, trackingEnabled ? 1 : 0, first.receivedAt, first.receivedAt, first.receivedAt],
      );
      const snapshot = await insertSnapshot(sql, inserted.lastID, first);
      const row = await sql.get<CryptocurrencyRow>('SELECT * FROM cryptocurrencies WHERE id = ?', [inserted.lastID]);
      return { cryptocurrency: toCryptocurrency(row!), snapshot };
    });
  }

  async findById(id: number): Promise<Cryptocurrency | undefined> {
    positiveId(id);
    const row = await this.database.get<CryptocurrencyRow>('SELECT * FROM cryptocurrencies WHERE id = ?', [id]);
    return row && toCryptocurrency(row);
  }

  async findByCmcId(cmcId: number): Promise<Cryptocurrency | undefined> {
    positiveId(cmcId);
    const row = await this.database.get<CryptocurrencyRow>('SELECT * FROM cryptocurrencies WHERE cmc_id = ?', [cmcId]);
    return row && toCryptocurrency(row);
  }

  async list(query: PaginationInput = {}): Promise<Page<Cryptocurrency>> {
    const { limit, offset } = pagination(query);
    return this.database.transaction(async (sql) => {
      const count = await sql.get<{ total: number }>('SELECT COUNT(*) AS total FROM cryptocurrencies');
      const rows = await sql.all<CryptocurrencyRow>('SELECT * FROM cryptocurrencies ORDER BY id ASC LIMIT ? OFFSET ?', [limit, offset]);
      return { items: rows.map(toCryptocurrency), pagination: { limit, offset, total: count!.total } };
    });
  }

  async listTrackingEnabled(): Promise<Cryptocurrency[]> {
    const rows = await this.database.all<CryptocurrencyRow>(
      'SELECT * FROM cryptocurrencies WHERE tracking_enabled = ? ORDER BY id ASC', [1],
    );
    return rows.map(toCryptocurrency);
  }

  async setTrackingEnabled(id: number, enabled: boolean, updatedAt = new Date().toISOString()): Promise<Cryptocurrency | undefined> {
    positiveId(id);
    booleanFlag(enabled);
    const timestamp = utcTimestamp(updatedAt);
    return this.database.transaction(async (sql) => {
      const changed = await sql.run(
        'UPDATE cryptocurrencies SET tracking_enabled = ?, updated_at = MAX(updated_at, ?) WHERE id = ?',
        [enabled ? 1 : 0, timestamp, id],
      );
      if (!changed.changes) return undefined;
      const row = await sql.get<CryptocurrencyRow>('SELECT * FROM cryptocurrencies WHERE id = ?', [id]);
      return toCryptocurrency(row!);
    });
  }

  async deleteById(id: number): Promise<boolean> {
    positiveId(id);
    // A single SQLite DELETE atomically removes the parent and its cascading history.
    const deleted = await this.database.run('DELETE FROM cryptocurrencies WHERE id = ?', [id]);
    return deleted.changes === 1;
  }

  async setTrackingEnabledByCmcId(
    cmcId: number, enabled: boolean, updatedAt = new Date().toISOString(),
  ): Promise<Cryptocurrency | undefined> {
    positiveId(cmcId);
    booleanFlag(enabled);
    const timestamp = utcTimestamp(updatedAt);
    return this.database.transaction(async (sql) => {
      const changed = await sql.run(
        'UPDATE cryptocurrencies SET tracking_enabled = ?, updated_at = MAX(updated_at, ?) WHERE cmc_id = ?',
        [enabled ? 1 : 0, timestamp, cmcId],
      );
      if (!changed.changes) return undefined;
      const row = await sql.get<CryptocurrencyRow>('SELECT * FROM cryptocurrencies WHERE cmc_id = ?', [cmcId]);
      return toCryptocurrency(row!);
    });
  }

  async deleteByCmcId(cmcId: number): Promise<boolean> {
    positiveId(cmcId);
    // Cascade still runs atomically; the public identifier selects the parent directly.
    const deleted = await this.database.run('DELETE FROM cryptocurrencies WHERE cmc_id = ?', [cmcId]);
    return deleted.changes === 1;
  }
}
