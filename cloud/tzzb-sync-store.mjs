const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS tzzb_latest_sync (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  target_date TEXT NOT NULL,
  received_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
)`;

const READ_LATEST_SQL = `
SELECT payload_json
FROM tzzb_latest_sync
WHERE id = 1`;

const WRITE_LATEST_SQL = `
INSERT INTO tzzb_latest_sync (id, target_date, received_at, payload_json)
VALUES (1, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  target_date = excluded.target_date,
  received_at = excluded.received_at,
  payload_json = excluded.payload_json`;

export function createTzzbSyncStore(db) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('D1 binding DB is required');
  }

  let schemaPromise;

  async function ensureSchema() {
    if (!schemaPromise) {
      schemaPromise = db.prepare(CREATE_TABLE_SQL).run();
    }
    await schemaPromise;
  }

  return {
    async readLatest() {
      await ensureSchema();
      const row = await db.prepare(READ_LATEST_SQL).first();
      if (!row || !row.payload_json) return null;
      return JSON.parse(row.payload_json);
    },

    async writeLatest(payload) {
      await ensureSchema();
      await db.prepare(WRITE_LATEST_SQL)
        .bind(payload.targetDate, payload.receivedAt, JSON.stringify(payload))
        .run();
      return payload;
    }
  };
}
