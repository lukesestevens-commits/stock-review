const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS market_snapshots (
  trade_date TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL,
  finalized_at TEXT,
  payload_json TEXT NOT NULL
)`;

const READ_DATE_SQL = `
SELECT trade_date, updated_at, finalized_at, payload_json
FROM market_snapshots
WHERE trade_date = ?`;

const READ_LATEST_SQL = `
SELECT trade_date, updated_at, finalized_at, payload_json
FROM market_snapshots
ORDER BY trade_date DESC
LIMIT 1`;

const WRITE_SQL = `
INSERT INTO market_snapshots (trade_date, updated_at, finalized_at, payload_json)
VALUES (?, ?, ?, ?)
ON CONFLICT(trade_date) DO UPDATE SET
  updated_at = excluded.updated_at,
  finalized_at = excluded.finalized_at,
  payload_json = excluded.payload_json
WHERE market_snapshots.finalized_at IS NULL`;

function decode(row) {
  if (!row || !row.payload_json) return null;
  return {
    tradeDate: row.trade_date,
    updatedAt: row.updated_at,
    finalizedAt: row.finalized_at || '',
    market: JSON.parse(row.payload_json)
  };
}

export function createMarketSnapshotStore(db) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('D1 binding DB is required');
  }

  let schemaPromise;
  async function ensureSchema() {
    if (!schemaPromise) schemaPromise = db.prepare(CREATE_TABLE_SQL).run();
    await schemaPromise;
  }

  return {
    async read(tradeDate) {
      await ensureSchema();
      return decode(await db.prepare(READ_DATE_SQL).bind(tradeDate).first());
    },

    async readLatest() {
      await ensureSchema();
      return decode(await db.prepare(READ_LATEST_SQL).first());
    },

    async write(record) {
      await ensureSchema();
      await db.prepare(WRITE_SQL)
        .bind(
          record.tradeDate,
          record.updatedAt,
          record.finalizedAt || null,
          JSON.stringify(record.market)
        )
        .run();
      return this.read(record.tradeDate);
    }
  };
}
