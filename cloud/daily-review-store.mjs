const READ_ATTEMPT_SQL = `
SELECT
  idempotency_key,
  content_hash,
  captured_at,
  capture_date,
  review_date,
  state,
  normalized_evidence_json,
  attempt_audit_json
FROM daily_review_candidates
WHERE idempotency_key = ?`;

const INSERT_ATTEMPT_SQL = `
INSERT INTO daily_review_candidates (
  idempotency_key,
  content_hash,
  captured_at,
  capture_date,
  review_date,
  state,
  normalized_evidence_json,
  attempt_audit_json
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

const READ_LATEST_VERIFIED_SQL = `
SELECT
  revision.daily_review_json,
  audit.audit_json
FROM latest_verified_pointer AS pointer
JOIN daily_review_revisions AS revision
  ON revision.review_date = pointer.review_date
  AND revision.revision = pointer.revision
JOIN reconciliation_audits AS audit
  ON audit.review_date = pointer.review_date
  AND audit.revision = pointer.revision
WHERE pointer.id = 1`;

const READ_CURRENT_REVISION_SQL = `
SELECT COALESCE(MAX(revision), 0) AS current_revision
FROM daily_review_revisions
WHERE review_date = ?`;

const READ_VERIFIED_ATTEMPT_SQL = `
SELECT
  revision.daily_review_json,
  audit.audit_json
FROM daily_review_revisions AS revision
JOIN reconciliation_audits AS audit
  ON audit.review_date = revision.review_date
  AND audit.revision = revision.revision
WHERE revision.idempotency_key = ?
  AND revision.content_hash = ?
ORDER BY revision.review_date DESC, revision.revision DESC
LIMIT 1`;

const READ_LATEST_PENDING_SQL = `
SELECT
  idempotency_key,
  content_hash,
  captured_at,
  capture_date,
  review_date,
  state,
  normalized_evidence_json,
  attempt_audit_json
FROM daily_review_candidates AS candidate
WHERE candidate.state <> 'verified'
  AND (
    NOT EXISTS (SELECT 1 FROM latest_verified_pointer WHERE id = 1)
    OR candidate.review_date > (SELECT review_date FROM latest_verified_pointer WHERE id = 1)
    OR (
      candidate.review_date = (SELECT review_date FROM latest_verified_pointer WHERE id = 1)
      AND julianday(candidate.captured_at) > julianday((
        SELECT revision.captured_at
        FROM latest_verified_pointer AS pointer
        JOIN daily_review_revisions AS revision
          ON revision.review_date = pointer.review_date
          AND revision.revision = pointer.revision
        WHERE pointer.id = 1
      ))
    )
  )
ORDER BY candidate.captured_at DESC, candidate.rowid DESC
LIMIT 1`;

const INSERT_DAILY_REVIEW_SQL = `
INSERT INTO daily_review_revisions (
  review_date,
  revision,
  idempotency_key,
  content_hash,
  captured_at,
  daily_review_json,
  verified_at
)
VALUES (?, ?, ?, ?, ?, ?, ?)`;

const INSERT_RECONCILIATION_AUDIT_SQL = `
INSERT INTO reconciliation_audits (
  review_date,
  revision,
  audit_json
)
VALUES (?, ?, ?)`;

const ADVANCE_LATEST_VERIFIED_SQL = `
INSERT INTO latest_verified_pointer (id, review_date, revision, verified_at)
VALUES (1, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  review_date = excluded.review_date,
  revision = excluded.revision,
  verified_at = excluded.verified_at
WHERE excluded.review_date > latest_verified_pointer.review_date
  OR (
    excluded.review_date = latest_verified_pointer.review_date
    AND excluded.revision > latest_verified_pointer.revision
    AND julianday(?) >= julianday((
      SELECT revision.captured_at
      FROM daily_review_revisions AS revision
      WHERE revision.review_date = latest_verified_pointer.review_date
        AND revision.revision = latest_verified_pointer.revision
    ))
  )`;

const LEGACY_COMPAT_SOURCE = 'daily-review-verified-compat';

const UPSERT_LEGACY_COMPAT_SQL = `
INSERT INTO tzzb_latest_sync (id, target_date, received_at, payload_json)
VALUES (1, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  target_date = excluded.target_date,
  received_at = excluded.received_at,
  payload_json = excluded.payload_json
WHERE excluded.target_date > tzzb_latest_sync.target_date
  OR (
    excluded.target_date = tzzb_latest_sync.target_date
    AND (
      instr(tzzb_latest_sync.payload_json, '"source":"daily-review-verified-compat"') = 0
      OR julianday(excluded.received_at) >= julianday(tzzb_latest_sync.received_at)
    )
  )`;

const PRUNE_CANDIDATES_SQL = `
DELETE FROM daily_review_candidates
WHERE capture_date < ?`;

function requiredString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${field} is required`);
  }
  return value;
}

function normalizedInstant(value, field) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new TypeError(`${field} must be a valid ISO instant`);
  }
  return new Date(timestamp).toISOString();
}

function validateAttempt(attempt) {
  if (!attempt || typeof attempt !== 'object' || Array.isArray(attempt)) {
    throw new TypeError('attempt is required');
  }
  for (const field of ['idempotencyKey', 'contentHash', 'capturedAt', 'captureDate', 'reviewDate']) {
    requiredString(attempt[field], `attempt.${field}`);
  }
  normalizedInstant(attempt.capturedAt, 'attempt.capturedAt');
  if (!attempt.normalizedEvidence || typeof attempt.normalizedEvidence !== 'object') {
    throw new TypeError('attempt.normalizedEvidence is required');
  }
  if (!['verified', 'stored-unverified'].includes(attempt.state)) {
    throw new TypeError('attempt.state must be verified or stored-unverified');
  }
  if (!attempt.audit || typeof attempt.audit !== 'object') {
    throw new TypeError('attempt.audit is required');
  }
  if (attempt.audit.reviewDate !== attempt.reviewDate) {
    throw new TypeError('attempt.audit must share reviewDate');
  }
  if (Object.hasOwn(attempt, 'records')) {
    throw new TypeError('attempt.records is not accepted; store normalizedEvidence instead');
  }
}

function attemptFromRow(row) {
  if (!row) return null;
  return {
    idempotencyKey: row.idempotency_key,
    contentHash: row.content_hash,
    capturedAt: row.captured_at,
    captureDate: row.capture_date,
    reviewDate: row.review_date,
    state: row.state,
    normalizedEvidence: JSON.parse(row.normalized_evidence_json),
    audit: JSON.parse(row.attempt_audit_json)
  };
}

function idempotencyConflict(idempotencyKey) {
  const error = new Error(`idempotency key already has different content: ${idempotencyKey}`);
  error.code = 'IDEMPOTENCY_CONFLICT';
  return error;
}

function storeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function legacyText(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function positiveMoney(value) {
  const parsed = Number(legacyText(value).replaceAll(',', ''));
  return Number.isFinite(parsed) && parsed > 0;
}

function legacyReverseRepo(row = {}) {
  const code = legacyText(row.code).toUpperCase();
  const name = legacyText(row.name).toUpperCase();
  return /^204\d{3}$/.test(code)
    || /^1318\d{2}$/.test(code)
    || code === '888880'
    || name.startsWith('GC')
    || name.startsWith('R-')
    || name.includes('标准券');
}

function legacyHolding(holding = {}) {
  return {
    code: legacyText(holding.code),
    name: legacyText(holding.name),
    count: legacyText(holding.quantity ?? holding.qty),
    price: legacyText(holding.price),
    value: legacyText(holding.value)
  };
}

function legacyTrade(trade = {}, reviewDate) {
  return {
    entry_date: legacyText(trade.date, reviewDate) || reviewDate,
    entry_time: legacyText(trade.time),
    code: legacyText(trade.code),
    name: legacyText(trade.name),
    op_name: legacyText(trade.side),
    entry_price: legacyText(trade.price),
    entry_count: legacyText(trade.quantity ?? trade.qty),
    entry_money: legacyText(trade.amount),
    fee: legacyText(trade.fee)
  };
}

/**
 * Build the narrow legacy row needed to roll the Worker back to Sites v12.
 * The input seam is deliberately DailyReview-only: normalized evidence,
 * account hashes, request metadata, and raw endpoint responses are never read.
 */
export function buildLegacyRollbackPayload(dailyReview) {
  if (!dailyReview || typeof dailyReview !== 'object' || Array.isArray(dailyReview)) {
    throw new TypeError('dailyReview is required');
  }
  const reviewDate = requiredString(dailyReview.reviewDate || dailyReview.date, 'dailyReview.reviewDate');
  const capturedAt = normalizedInstant(dailyReview.capturedAt, 'dailyReview.capturedAt');
  const capital = dailyReview.capital && typeof dailyReview.capital === 'object'
    ? dailyReview.capital
    : {};
  const ordinaryPositions = (Array.isArray(dailyReview.holdings) ? dailyReview.holdings : [])
    .filter((holding) => !legacyReverseRepo(holding))
    .map(legacyHolding);
  const reverseRepoValue = legacyText(capital.reverseRepoValue, '0.00');
  const positions = [...ordinaryPositions];
  if (positiveMoney(reverseRepoValue)) {
    positions.push({
      code: '888880',
      name: '标准券（逆回购占用）',
      count: '1',
      price: reverseRepoValue,
      value: reverseRepoValue
    });
  }

  const totalAsset = legacyText(capital.totalAsset ?? dailyReview.basic?.capital, '0.00');
  const totalValue = legacyText(capital.investedMarketValue, '0.00');
  const cash = legacyText(capital.cash, '0.00');
  const pnl = legacyText(dailyReview.pnl ?? dailyReview.basic?.pnl, '0.00');
  const record = (endpoint, data) => ({
    capturedAt,
    method: 'GET',
    status: 200,
    url: `/daily-review-compat/${endpoint}`,
    data
  });

  return {
    source: LEGACY_COMPAT_SOURCE,
    targetDate: reviewDate,
    receivedAt: capturedAt,
    records: [
      record('stock_position', {
        ex_data: {
          total_asset: totalAsset,
          total_value: totalValue,
          money_remain: cash,
          position_rate: legacyText(capital.positionRatio),
          position: positions
        }
      }),
      record('stock_card', {
        ex_data: {
          asset: totalAsset,
          now_profit: pnl
        }
      }),
      record('get_money_history', {
        ex_data: {
          list: (Array.isArray(dailyReview.trades) ? dailyReview.trades : [])
            .filter((trade) => !legacyReverseRepo(trade))
            .map((trade) => legacyTrade(trade, reviewDate))
        }
      })
    ]
  };
}

function validateVerifiedInput(input) {
  if (!input || typeof input !== 'object') throw new TypeError('verified input is required');
  const { attempt, dailyReview, audit } = input;
  validateAttempt(attempt);
  if (!dailyReview || typeof dailyReview !== 'object') throw new TypeError('dailyReview is required');
  if (!audit || typeof audit !== 'object') throw new TypeError('audit is required');

  if (dailyReview.reviewDate !== attempt.reviewDate || audit.reviewDate !== attempt.reviewDate) {
    throw new TypeError('attempt, dailyReview, and audit must share reviewDate');
  }
  if (attempt.state !== 'verified' || audit.status !== 'verified') {
    throw storeError('ATTEMPT_NOT_VERIFIED', 'only verified reviews can advance latest verified');
  }
  requiredString(audit.verifiedAt || audit.checkedAt, 'audit.verifiedAt or audit.checkedAt');
}

export function createDailyReviewStore(db) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('D1 binding DB is required');
  }

  async function readAttempt(idempotencyKey) {
    requiredString(idempotencyKey, 'idempotencyKey');
    const row = await db.prepare(READ_ATTEMPT_SQL).bind(idempotencyKey).first();
    return attemptFromRow(row);
  }

  async function saveAttempt(attempt) {
    validateAttempt(attempt);
    const existing = await readAttempt(attempt.idempotencyKey);
    if (existing) {
      if (existing.contentHash !== attempt.contentHash) {
        throw idempotencyConflict(attempt.idempotencyKey);
      }
      return { status: 'duplicate', attempt: existing };
    }

    try {
      await db.prepare(INSERT_ATTEMPT_SQL)
        .bind(
          attempt.idempotencyKey,
          attempt.contentHash,
          attempt.capturedAt,
          attempt.captureDate,
          attempt.reviewDate,
          attempt.state,
          JSON.stringify(attempt.normalizedEvidence),
          JSON.stringify(attempt.audit)
        )
        .run();
    } catch (error) {
      const raced = await readAttempt(attempt.idempotencyKey);
      if (!raced) throw error;
      if (raced.contentHash !== attempt.contentHash) {
        throw idempotencyConflict(attempt.idempotencyKey);
      }
      return { status: 'duplicate', attempt: raced };
    }

    return { status: 'stored', attempt };
  }

  async function readLatestVerified() {
    const [row, pendingRow] = await Promise.all([
      db.prepare(READ_LATEST_VERIFIED_SQL).first(),
      db.prepare(READ_LATEST_PENDING_SQL).first()
    ]);
    return {
      dailyReview: row ? JSON.parse(row.daily_review_json) : null,
      audit: row ? JSON.parse(row.audit_json) : null,
      pendingAttempt: attemptFromRow(pendingRow)
    };
  }

  async function saveVerified(input) {
    validateVerifiedInput(input);
    if (typeof db.batch !== 'function') {
      throw new Error('D1 binding DB.batch is required for atomic verified writes');
    }

    const { attempt, dailyReview, audit } = input;
    const savedAttempt = await readAttempt(attempt.idempotencyKey);
    if (savedAttempt && savedAttempt.contentHash !== attempt.contentHash) {
      throw idempotencyConflict(attempt.idempotencyKey);
    }

    const alreadyVerified = await db.prepare(READ_VERIFIED_ATTEMPT_SQL)
      .bind(attempt.idempotencyKey, attempt.contentHash)
      .first();
    if (alreadyVerified) {
      return {
        dailyReview: JSON.parse(alreadyVerified.daily_review_json),
        audit: JSON.parse(alreadyVerified.audit_json)
      };
    }

    const revisionRow = await db.prepare(READ_CURRENT_REVISION_SQL)
      .bind(attempt.reviewDate)
      .first();
    const revision = Number(revisionRow?.current_revision || 0) + 1;
    const verifiedAt = audit.verifiedAt || audit.checkedAt;
    const storedDailyReview = { ...dailyReview, revision };
    const storedAudit = { ...audit, revision };
    const legacyPayload = buildLegacyRollbackPayload(storedDailyReview);
    const statements = [];
    if (!savedAttempt) {
      statements.push(
        db.prepare(INSERT_ATTEMPT_SQL).bind(
          attempt.idempotencyKey,
          attempt.contentHash,
          attempt.capturedAt,
          attempt.captureDate,
          attempt.reviewDate,
          attempt.state,
          JSON.stringify(attempt.normalizedEvidence),
          JSON.stringify(attempt.audit)
        )
      );
    }
    statements.push(
      db.prepare(INSERT_DAILY_REVIEW_SQL).bind(
        attempt.reviewDate,
        revision,
        attempt.idempotencyKey,
        attempt.contentHash,
        attempt.capturedAt,
        JSON.stringify(storedDailyReview),
        verifiedAt
      ),
      db.prepare(INSERT_RECONCILIATION_AUDIT_SQL).bind(
        attempt.reviewDate,
        revision,
        JSON.stringify(storedAudit)
      ),
      db.prepare(ADVANCE_LATEST_VERIFIED_SQL).bind(
        attempt.reviewDate,
        revision,
        verifiedAt,
        normalizedInstant(attempt.capturedAt, 'attempt.capturedAt')
      ),
      db.prepare(UPSERT_LEGACY_COMPAT_SQL).bind(
        legacyPayload.targetDate,
        legacyPayload.receivedAt,
        JSON.stringify(legacyPayload)
      )
    );
    await db.batch(statements);

    return { dailyReview: storedDailyReview, audit: storedAudit };
  }

  async function pruneCandidates(beforeDate) {
    requiredString(beforeDate, 'beforeDate');
    const result = await db.prepare(PRUNE_CANDIDATES_SQL).bind(beforeDate).run();
    return { deleted: Number(result?.meta?.changes || result?.changes || 0) };
  }

  return { readAttempt, saveAttempt, readLatestVerified, saveVerified, pruneCandidates };
}
