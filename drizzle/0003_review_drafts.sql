CREATE TABLE IF NOT EXISTS review_drafts (
  review_date TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  record_json TEXT NOT NULL
);
