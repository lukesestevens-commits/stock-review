CREATE TABLE IF NOT EXISTS market_snapshots (
  trade_date TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL,
  finalized_at TEXT,
  payload_json TEXT NOT NULL
);
