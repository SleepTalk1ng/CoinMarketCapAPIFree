import { Database, SqlExecutor, SqlParameters } from '../db/database';
import {
  CryptocurrencyNotFoundError, Page, PaginationInput, PriceSnapshot, PriceSnapshotRow,
  SnapshotInput, toPriceSnapshot,
} from './models';
import { pagination, positiveId, snapshotInput, utcTimestamp } from './validation';

export interface HistoryQuery extends PaginationInput {
  readonly from?: string;
  readonly to?: string;
}

export async function insertSnapshot(sql: SqlExecutor, id: number, input: Required<SnapshotInput>): Promise<PriceSnapshot> {
  const inserted = await sql.run(
    `INSERT INTO price_history (cryptocurrency_id, price, received_at, source_updated_at)
     VALUES (?, ?, ?, ?)`,
    [id, input.price, input.receivedAt, input.sourceUpdatedAt],
  );
  return {
    id: inserted.lastID, cryptocurrencyId: id, price: input.price, currency: 'USD',
    receivedAt: input.receivedAt, sourceUpdatedAt: input.sourceUpdatedAt,
  };
}

export class PriceHistoryRepository {
  constructor(private readonly database: Database) {}

  async saveSnapshot(id: number, input: SnapshotInput): Promise<PriceSnapshot> {
    const saved = await this.save(id, input, false);
    if (!saved) throw new CryptocurrencyNotFoundError();
    return saved;
  }

  /** Background eligibility and persistence share one transaction, closing the PATCH/DELETE race. */
  saveTrackingSnapshot(id: number, input: SnapshotInput, signal?: AbortSignal): Promise<PriceSnapshot | undefined> {
    return this.save(id, input, true, signal);
  }

  private async save(id: number, input: SnapshotInput, trackingOnly: boolean, signal?: AbortSignal): Promise<PriceSnapshot | undefined> {
    positiveId(id);
    const snapshot = snapshotInput(input);
    return this.database.transaction(async (sql) => {
      if (signal?.aborted) return undefined;
      const coin = await sql.get<{ tracking_enabled: number }>(
        'SELECT tracking_enabled FROM cryptocurrencies WHERE id = ?', [id],
      );
      if (!coin) {
        if (trackingOnly) return undefined;
        throw new CryptocurrencyNotFoundError();
      }
      if (trackingOnly && (coin.tracking_enabled !== 1 || signal?.aborted)) return undefined;
      const saved = await insertSnapshot(sql, id, snapshot);
      await sql.run(
        `UPDATE cryptocurrencies
         SET updated_at = MAX(updated_at, ?),
             last_price_received_at = MAX(COALESCE(last_price_received_at, ?), ?)
         WHERE id = ?`,
        [snapshot.receivedAt, snapshot.receivedAt, snapshot.receivedAt, id],
      );
      return saved;
    });
  }

  async findLatest(id: number): Promise<PriceSnapshot | undefined> {
    positiveId(id);
    const row = await this.database.get<PriceSnapshotRow>(
      `SELECT * FROM price_history WHERE cryptocurrency_id = ?
       ORDER BY received_at DESC, id DESC LIMIT 1`, [id],
    );
    return row && toPriceSnapshot(row);
  }

  async list(id: number, query: HistoryQuery = {}): Promise<Page<PriceSnapshot>> {
    positiveId(id);
    const { limit, offset } = pagination(query);
    const from = query.from === undefined ? undefined : utcTimestamp(query.from);
    const to = query.to === undefined ? undefined : utcTimestamp(query.to);
    if (from !== undefined && to !== undefined && from > to) throw new TypeError('History requires from <= to.');
    // Only fixed SQL fragments are composed. Every value is a bound parameter.
    let where = 'cryptocurrency_id = ?';
    const parameters: (SqlParameters[number])[] = [id];
    if (from !== undefined) { where += ' AND received_at >= ?'; parameters.push(from); }
    if (to !== undefined) { where += ' AND received_at <= ?'; parameters.push(to); }
    return this.database.transaction(async (sql) => {
      const count = await sql.get<{ total: number }>(`SELECT COUNT(*) AS total FROM price_history WHERE ${where}`, parameters);
      const rows = await sql.all<PriceSnapshotRow>(
        `SELECT * FROM price_history WHERE ${where} ORDER BY received_at DESC, id DESC LIMIT ? OFFSET ?`,
        [...parameters, limit, offset],
      );
      return { items: rows.map(toPriceSnapshot), pagination: { limit, offset, total: count!.total } };
    });
  }
}
