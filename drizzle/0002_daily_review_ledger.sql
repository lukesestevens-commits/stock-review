CREATE TABLE IF NOT EXISTS daily_review_candidates (
  idempotency_key TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  capture_date TEXT NOT NULL,
  review_date TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('verified', 'stored-unverified')),
  normalized_evidence_json TEXT NOT NULL,
  attempt_audit_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS daily_review_candidates_capture_date_idx
  ON daily_review_candidates (capture_date);

CREATE TABLE IF NOT EXISTS daily_review_revisions (
  review_date TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  idempotency_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  daily_review_json TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  PRIMARY KEY (review_date, revision)
);

CREATE TABLE IF NOT EXISTS reconciliation_audits (
  review_date TEXT NOT NULL,
  revision INTEGER NOT NULL,
  audit_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (review_date, revision),
  FOREIGN KEY (review_date, revision)
    REFERENCES daily_review_revisions (review_date, revision)
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS latest_verified_pointer (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  review_date TEXT NOT NULL,
  revision INTEGER NOT NULL,
  verified_at TEXT NOT NULL,
  FOREIGN KEY (review_date, revision)
    REFERENCES daily_review_revisions (review_date, revision)
    ON DELETE RESTRICT
);

-- Keep the last v12 row intact until the first new verified DailyReview is
-- committed. The Worker then atomically replaces it with a synthetic,
-- de-identified compatibility payload so Sites v12 remains a safe rollback.
