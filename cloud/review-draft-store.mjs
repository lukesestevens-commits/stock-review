const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS review_drafts (
  review_date TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  record_json TEXT NOT NULL
)`;

const READ_SQL = `
SELECT review_date, version, updated_at, record_json
FROM review_drafts
WHERE review_date = ?`;

const LIST_SQL = `
SELECT review_date, version, updated_at, record_json
FROM review_drafts
WHERE review_date >= ? AND review_date <= ?
ORDER BY review_date DESC
LIMIT ?`;

const INSERT_SQL = `
INSERT INTO review_drafts (review_date, version, updated_at, record_json)
VALUES (?, 1, ?, ?)`;

const UPDATE_SQL = `
UPDATE review_drafts
SET version = version + 1,
    updated_at = ?,
    record_json = ?
WHERE review_date = ? AND version = ?`;

function validReviewDate(value) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new TypeError('reviewDate must use YYYY-MM-DD');
  return text;
}

function validListLimit(value) {
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError('limit must be an integer between 1 and 100');
  }
  return limit;
}

function draftFromRow(row) {
  if (!row) return null;
  return {
    reviewDate: row.review_date,
    version: Number(row.version),
    updatedAt: row.updated_at,
    record: JSON.parse(row.record_json)
  };
}

function versionConflict(current) {
  const error = new Error('review draft version conflict');
  error.code = 'DRAFT_VERSION_CONFLICT';
  error.current = current;
  return error;
}

function changedRows(result) {
  return Number(result?.meta?.changes ?? result?.changes ?? 0);
}

export function createReviewDraftStore(db) {
  if (!db || typeof db.prepare !== 'function') throw new Error('D1 binding DB is required');
  let schemaPromise;

  async function ensureSchema() {
    if (!schemaPromise) schemaPromise = db.prepare(CREATE_TABLE_SQL).run();
    await schemaPromise;
  }

  async function read(reviewDate) {
    await ensureSchema();
    const row = await db.prepare(READ_SQL).bind(validReviewDate(reviewDate)).first();
    return draftFromRow(row);
  }

  async function list({ from, to, limit = 62 } = {}) {
    await ensureSchema();
    const start = validReviewDate(from);
    const end = validReviewDate(to);
    if (start > end) throw new TypeError('date range must be ascending');
    const result = await db.prepare(LIST_SQL).bind(start, end, validListLimit(limit)).all();
    return (result?.results || []).map(draftFromRow);
  }

  async function save({ reviewDate, record, expectedVersion, updatedAt }) {
    await ensureSchema();
    const date = validReviewDate(reviewDate);
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new TypeError('record is required');
    const version = Number(expectedVersion);
    if (!Number.isSafeInteger(version) || version < 0) throw new TypeError('expectedVersion must be a non-negative integer');
    const instant = new Date(updatedAt);
    if (Number.isNaN(instant.getTime())) throw new TypeError('updatedAt must be a valid instant');
    const normalizedUpdatedAt = instant.toISOString();
    const recordJson = JSON.stringify(record);
    if (new TextEncoder().encode(recordJson).byteLength > 512 * 1024) {
      throw new TypeError('review draft is too large');
    }

    const current = await read(date);
    if (Number(current?.version || 0) !== version) throw versionConflict(current);
    if (!current) {
      try {
        await db.prepare(INSERT_SQL).bind(date, normalizedUpdatedAt, recordJson).run();
      } catch (error) {
        const raced = await read(date);
        if (raced) throw versionConflict(raced);
        throw error;
      }
    } else {
      const result = await db.prepare(UPDATE_SQL)
        .bind(normalizedUpdatedAt, recordJson, date, version)
        .run();
      if (changedRows(result) !== 1) throw versionConflict(await read(date));
    }
    return {
      reviewDate: date,
      version: version + 1,
      updatedAt: normalizedUpdatedAt,
      record: structuredClone(record)
    };
  }

  return { read, list, save };
}
