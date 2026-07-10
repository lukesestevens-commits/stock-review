CREATE TABLE IF NOT EXISTS tzzb_latest_sync (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  target_date TEXT NOT NULL,
  received_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
