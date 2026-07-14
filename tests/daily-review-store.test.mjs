import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  buildLegacyRollbackPayload,
  createDailyReviewStore
} from '../cloud/daily-review-store.mjs';
import { mapTzzbCaptureToReview } from '../tools/tzzb-review-mapper.mjs';

class FakeD1 {
  constructor() {
    this.candidates = new Map();
    this.revisions = new Map();
    this.audits = new Map();
    this.latestPointer = null;
    this.legacyRow = null;
    this.inBatch = false;
    this.failBatchAt = null;
    this.nextRowid = 1;
  }

  prepare(sql) {
    const statements = String(sql)
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean);
    assert.equal(statements.length, 1, `prepare must receive exactly one statement: ${sql}`);

    const db = this;
    let values = [];
    return {
      bind(...nextValues) {
        values = nextValues;
        return this;
      },
      async first() {
        if (/state <> 'verified'/.test(sql)) {
          const latestRevision = db.latestPointer
            ? db.revisions.get(`${db.latestPointer.review_date}:${db.latestPointer.revision}`)
            : null;
          return [...db.candidates.values()]
            .filter((row) => (
              row.state !== 'verified'
              && (
                !latestRevision
                || row.review_date > db.latestPointer.review_date
                || (
                  row.review_date === db.latestPointer.review_date
                  && Date.parse(row.captured_at) > Date.parse(latestRevision.captured_at)
                )
              )
            ))
            .sort((left, right) => right.captured_at.localeCompare(left.captured_at) || right.rowid - left.rowid)[0]
            || null;
        }
        if (/WHERE revision\.idempotency_key = \?/.test(sql)) {
          const [idempotencyKey, contentHash] = values;
          const revision = [...db.revisions.values()]
            .filter((row) => row.idempotency_key === idempotencyKey && row.content_hash === contentHash)
            .sort((left, right) => right.review_date.localeCompare(left.review_date) || right.revision - left.revision)[0];
          if (!revision) return null;
          const audit = db.audits.get(`${revision.review_date}:${revision.revision}`);
          return audit ? {
            daily_review_json: revision.daily_review_json,
            audit_json: audit.audit_json
          } : null;
        }
        if (/MAX\(revision\)/.test(sql) && /FROM daily_review_revisions/.test(sql)) {
          const [reviewDate] = values;
          const revisions = [...db.revisions.values()]
            .filter((row) => row.review_date === reviewDate)
            .map((row) => row.revision);
          return { current_revision: revisions.length ? Math.max(...revisions) : 0 };
        }
        if (/FROM latest_verified_pointer/.test(sql)) {
          if (!db.latestPointer) return null;
          const key = `${db.latestPointer.review_date}:${db.latestPointer.revision}`;
          const revision = db.revisions.get(key);
          const audit = db.audits.get(key);
          return revision && audit ? {
            daily_review_json: revision.daily_review_json,
            audit_json: audit.audit_json
          } : null;
        }
        if (/FROM daily_review_candidates/.test(sql)) {
          return db.candidates.get(values[0]) || null;
        }
        throw new Error(`Unexpected first SQL: ${sql}`);
      },
      async run() {
        if (/INSERT INTO daily_review_candidates/.test(sql)) {
          const [
            idempotencyKey,
            contentHash,
            capturedAt,
            captureDate,
            reviewDate,
            state,
            normalizedEvidenceJson,
            attemptAuditJson
          ] = values;
          if (db.candidates.has(idempotencyKey)) {
            const error = new Error('UNIQUE constraint failed: daily_review_candidates.idempotency_key');
            error.code = 'SQLITE_CONSTRAINT';
            throw error;
          }
          db.candidates.set(idempotencyKey, {
            rowid: db.nextRowid++,
            idempotency_key: idempotencyKey,
            content_hash: contentHash,
            captured_at: capturedAt,
            capture_date: captureDate,
            review_date: reviewDate,
            state,
            normalized_evidence_json: normalizedEvidenceJson,
            attempt_audit_json: attemptAuditJson
          });
          return { success: true, meta: { changes: 1 } };
        }
        if (/INSERT INTO daily_review_revisions/.test(sql)) {
          assert.equal(db.inBatch, true, 'verified revisions must be written through D1 batch');
          const [reviewDate, revision, idempotencyKey, contentHash, capturedAt, dailyReviewJson, verifiedAt] = values;
          const key = `${reviewDate}:${revision}`;
          if (db.revisions.has(key)) throw new Error('duplicate daily review revision');
          db.revisions.set(key, {
            review_date: reviewDate,
            revision,
            idempotency_key: idempotencyKey,
            content_hash: contentHash,
            captured_at: capturedAt,
            daily_review_json: dailyReviewJson,
            verified_at: verifiedAt
          });
          return { success: true, meta: { changes: 1 } };
        }
        if (/INSERT INTO reconciliation_audits/.test(sql)) {
          assert.equal(db.inBatch, true, 'reconciliation audits must be written through D1 batch');
          const [reviewDate, revision, auditJson] = values;
          const key = `${reviewDate}:${revision}`;
          if (db.audits.has(key)) throw new Error('duplicate reconciliation audit');
          db.audits.set(key, {
            review_date: reviewDate,
            revision,
            audit_json: auditJson
          });
          return { success: true, meta: { changes: 1 } };
        }
        if (/INSERT INTO latest_verified_pointer/.test(sql)) {
          assert.equal(db.inBatch, true, 'latest verified pointer must be written through D1 batch');
          const [reviewDate, revision, verifiedAt, capturedAt] = values;
          const current = db.latestPointer;
          const currentRevision = current
            ? db.revisions.get(`${current.review_date}:${current.revision}`)
            : null;
          if (
            !current
            || reviewDate > current.review_date
            || (
              reviewDate === current.review_date
              && revision > current.revision
              && Date.parse(capturedAt) >= Date.parse(currentRevision.captured_at)
            )
          ) {
            db.latestPointer = {
              id: 1,
              review_date: reviewDate,
              revision,
              verified_at: verifiedAt
            };
          }
          return { success: true, meta: { changes: 1 } };
        }
        if (/INSERT INTO tzzb_latest_sync/.test(sql)) {
          assert.equal(db.inBatch, true, 'the v12 compatibility row must share the verified D1 batch');
          const [targetDate, receivedAt, payloadJson] = values;
          const current = db.legacyRow;
          const currentPayload = current ? JSON.parse(current.payload_json) : null;
          const currentIsSynthetic = currentPayload?.source === 'daily-review-verified-compat';
          const shouldWrite = !current
            || targetDate > current.target_date
            || (
              targetDate === current.target_date
              && (
                !currentIsSynthetic
                || Date.parse(receivedAt) >= Date.parse(current.received_at)
              )
            );
          if (shouldWrite) {
            db.legacyRow = {
              target_date: targetDate,
              received_at: receivedAt,
              payload_json: payloadJson
            };
          }
          return { success: true, meta: { changes: shouldWrite ? 1 : 0 } };
        }
        if (/DELETE FROM daily_review_candidates/.test(sql)) {
          const [beforeDate] = values;
          let changes = 0;
          for (const [key, candidate] of db.candidates) {
            if (candidate.capture_date < beforeDate) {
              db.candidates.delete(key);
              changes += 1;
            }
          }
          return { success: true, meta: { changes } };
        }
        throw new Error(`Unexpected run SQL: ${sql}`);
      }
    };
  }

  async batch(statements) {
    const snapshot = {
      candidates: new Map(this.candidates),
      nextRowid: this.nextRowid,
      revisions: new Map(this.revisions),
      audits: new Map(this.audits),
      latestPointer: this.latestPointer ? { ...this.latestPointer } : null,
      legacyRow: this.legacyRow ? { ...this.legacyRow } : null
    };
    this.inBatch = true;
    try {
      const results = [];
      for (let index = 0; index < statements.length; index += 1) {
        if (index === this.failBatchAt) throw new Error('forced batch failure');
        results.push(await statements[index].run());
      }
      return results;
    } catch (error) {
      this.candidates = snapshot.candidates;
      this.nextRowid = snapshot.nextRowid;
      this.revisions = snapshot.revisions;
      this.audits = snapshot.audits;
      this.latestPointer = snapshot.latestPointer;
      this.legacyRow = snapshot.legacyRow;
      throw error;
    } finally {
      this.inBatch = false;
    }
  }
}

const firstAttempt = {
  idempotencyKey: 'capture:2026-07-14:001',
  contentHash: 'sha256:first',
  capturedAt: '2026-07-15T00:08:12+08:00',
  captureDate: '2026-07-15',
  reviewDate: '2026-07-14',
  state: 'verified',
  normalizedEvidence: {
    totalAsset: '100000.00',
    trades: [{ code: '600000', side: 'buy', quantity: '100' }]
  },
  audit: {
    status: 'verified',
    reviewDate: '2026-07-14',
    checkedAt: '2026-07-14T15:30:00+08:00',
    verifiedAt: '2026-07-14T15:30:00+08:00',
    issues: [],
    warnings: []
  }
};

const attemptDb = new FakeD1();
const attemptStore = createDailyReviewStore(attemptDb);

assert.equal(await attemptStore.readAttempt('missing'), null);
assert.deepEqual(await attemptStore.saveAttempt(firstAttempt), {
  status: 'stored',
  attempt: firstAttempt
});
assert.deepEqual(await attemptStore.readAttempt(firstAttempt.idempotencyKey), firstAttempt);
assert.deepEqual(await attemptStore.saveAttempt(firstAttempt), {
  status: 'duplicate',
  attempt: firstAttempt
});

await assert.rejects(
  () => attemptStore.saveAttempt({ ...firstAttempt, contentHash: 'sha256:conflict' }),
  (error) => error?.code === 'IDEMPOTENCY_CONFLICT'
);

console.log('PASS daily review store attempts');

function verifiedData(attempt, revision, label) {
  return {
    attempt,
    dailyReview: {
      reviewDate: attempt.reviewDate,
      captureDate: attempt.captureDate,
      capturedAt: attempt.capturedAt,
      label,
      capital: { totalAsset: attempt.normalizedEvidence.totalAsset || '0' }
    },
    audit: {
      reviewDate: attempt.reviewDate,
      status: 'verified',
      checkedAt: `${attempt.reviewDate}T15:30:00+08:00`,
      verifiedAt: `${attempt.reviewDate}T15:30:00+08:00`,
      checks: [{ code: 'capital', outcome: 'pass' }]
    }
  };
}

function storedVerified(value, revision) {
  return {
    dailyReview: { ...value.dailyReview, revision },
    audit: { ...value.audit, revision }
  };
}

function latestResult(value = null, pendingAttempt = null) {
  return {
    dailyReview: value?.dailyReview || null,
    audit: value?.audit || null,
    pendingAttempt
  };
}

const verifiedDb = new FakeD1();
const verifiedStore = createDailyReviewStore(verifiedDb);
assert.deepEqual(await verifiedStore.readLatestVerified(), latestResult());

await verifiedStore.saveAttempt(firstAttempt);
const firstVerified = verifiedData(firstAttempt, 1, 'first verified');
await verifiedStore.saveVerified(firstVerified);
assert.deepEqual(await verifiedStore.readLatestVerified(), latestResult(storedVerified(firstVerified, 1)));

const newerUnverifiedAttempt = {
  ...firstAttempt,
  idempotencyKey: 'capture:2026-07-15:001',
  contentHash: 'sha256:newer-unverified',
  capturedAt: '2026-07-15T15:10:00+08:00',
  reviewDate: '2026-07-15',
  state: 'stored-unverified',
  audit: {
    status: 'held',
    reviewDate: '2026-07-15',
    checkedAt: '2026-07-15T15:30:00+08:00',
    issues: [{ code: 'PNL_MISMATCH' }],
    warnings: []
  }
};
await verifiedStore.saveAttempt(newerUnverifiedAttempt);
await assert.rejects(
  () => verifiedStore.saveVerified({
    ...verifiedData(newerUnverifiedAttempt, 1, 'not verified'),
    audit: {
      ...verifiedData(newerUnverifiedAttempt, 1, 'not verified').audit,
      status: 'held'
    }
  }),
  (error) => error?.code === 'ATTEMPT_NOT_VERIFIED'
);
assert.deepEqual(
  await verifiedStore.readLatestVerified(),
  latestResult(storedVerified(firstVerified, 1), newerUnverifiedAttempt)
);

const olderAttempt = {
  ...firstAttempt,
  idempotencyKey: 'capture:2026-07-13:001',
  contentHash: 'sha256:older',
  capturedAt: '2026-07-13T15:10:00+08:00',
  captureDate: '2026-07-13',
  reviewDate: '2026-07-13',
  audit: {
    ...firstAttempt.audit,
    reviewDate: '2026-07-13',
    checkedAt: '2026-07-13T15:30:00+08:00',
    verifiedAt: '2026-07-13T15:30:00+08:00'
  }
};
await verifiedStore.saveAttempt(olderAttempt);
await verifiedStore.saveVerified(verifiedData(olderAttempt, 1, 'older verified'));
assert.deepEqual(
  await verifiedStore.readLatestVerified(),
  latestResult(storedVerified(firstVerified, 1), newerUnverifiedAttempt)
);

const revisedAttempt = {
  ...firstAttempt,
  idempotencyKey: 'capture:2026-07-14:002',
  contentHash: 'sha256:revised'
};
await verifiedStore.saveAttempt(revisedAttempt);
const revisedVerified = verifiedData(revisedAttempt, 2, 'same-day revision');
await verifiedStore.saveVerified(revisedVerified);
const storedRevisedVerified = storedVerified(revisedVerified, 2);
assert.deepEqual(
  await verifiedStore.readLatestVerified(),
  latestResult(storedRevisedVerified, newerUnverifiedAttempt)
);

const atomicAttempt = {
  ...firstAttempt,
  idempotencyKey: 'capture:2026-07-16:001',
  contentHash: 'sha256:atomic',
  capturedAt: '2026-07-16T15:10:00+08:00',
  captureDate: '2026-07-16',
  reviewDate: '2026-07-16',
  audit: {
    ...firstAttempt.audit,
    reviewDate: '2026-07-16',
    checkedAt: '2026-07-16T15:30:00+08:00',
    verifiedAt: '2026-07-16T15:30:00+08:00'
  }
};
await verifiedStore.saveAttempt(atomicAttempt);
verifiedDb.failBatchAt = 1;
await assert.rejects(
  () => verifiedStore.saveVerified(verifiedData(atomicAttempt, 1, 'must roll back')),
  /forced batch failure/
);
assert.deepEqual(
  await verifiedStore.readLatestVerified(),
  latestResult(storedRevisedVerified, newerUnverifiedAttempt)
);

console.log('PASS daily review store verified revisions');

const directDb = new FakeD1();
const directStore = createDailyReviewStore(directDb);
const directVerified = verifiedData(firstAttempt, 1, 'direct verified');
const directStoredVerified = storedVerified(directVerified, 1);
assert.deepEqual(
  await directStore.saveVerified(directVerified),
  directStoredVerified
);
assert.deepEqual(await directStore.readAttempt(firstAttempt.idempotencyKey), firstAttempt);
assert.deepEqual(await directStore.readLatestVerified(), latestResult(directStoredVerified));
assert.deepEqual(
  await directStore.saveVerified(directVerified),
  directStoredVerified,
  'retrying the same verified attempt must not create another revision'
);

const directSecondAttempt = {
  ...firstAttempt,
  idempotencyKey: 'capture:2026-07-14:second',
  contentHash: 'sha256:direct-second'
};
const directSecondVerified = verifiedData(directSecondAttempt, 1, 'direct second verified');
assert.deepEqual(
  await directStore.saveVerified(directSecondVerified),
  storedVerified(directSecondVerified, 2),
  'a different same-day attempt should receive the next revision after an idempotent retry'
);

console.log('PASS daily review store direct verified write');

const orderedDb = new FakeD1();
const orderedStore = createDailyReviewStore(orderedDb);
const newerGoodAttempt = {
  ...firstAttempt,
  idempotencyKey: 'capture:2026-07-14:newer-good',
  contentHash: 'sha256:newer-good',
  capturedAt: '2026-07-15T00:10:00+08:00'
};
const newerGood = verifiedData(newerGoodAttempt, 1, 'newer good snapshot');
await orderedStore.saveVerified(newerGood);
const newerLegacyRow = structuredClone(orderedDb.legacyRow);

const lateOlderGoodAttempt = {
  ...firstAttempt,
  idempotencyKey: 'capture:2026-07-14:late-older-good',
  contentHash: 'sha256:late-older-good',
  capturedAt: '2026-07-14T16:09:00Z'
};
const lateOlderGood = verifiedData(lateOlderGoodAttempt, 2, 'late older good snapshot');
await orderedStore.saveVerified(lateOlderGood);
assert.deepEqual(
  await orderedStore.readLatestVerified(),
  latestResult(storedVerified(newerGood, 1)),
  'a late verified snapshot with an older normalized capture instant must not roll back latest'
);
assert.equal(orderedDb.revisions.size, 2, 'the late older verified revision must still be retained');
assert.equal(orderedDb.audits.size, 2, 'the late older audit must still be retained');
assert.deepEqual(
  orderedDb.legacyRow,
  newerLegacyRow,
  'a late same-day verified capture with an older capturedAt must not roll back the v12 row'
);

console.log('PASS daily review store verified capture ordering');

assert.deepEqual(await verifiedStore.pruneCandidates('2026-07-16'), { deleted: 4 });
assert.equal(await verifiedStore.readAttempt(revisedAttempt.idempotencyKey), null);
assert.deepEqual(
  await verifiedStore.readLatestVerified(),
  latestResult(storedRevisedVerified),
  'candidate retention must not delete long-lived verified reviews or audits'
);

console.log('PASS daily review store candidate retention');

const pendingDb = new FakeD1();
const firstPendingStore = createDailyReviewStore(pendingDb);
await firstPendingStore.saveAttempt(newerUnverifiedAttempt);
const rebuiltPendingStore = createDailyReviewStore(pendingDb);
assert.deepEqual(await rebuiltPendingStore.readLatestVerified(), {
  dailyReview: null,
  audit: null,
  pendingAttempt: newerUnverifiedAttempt
});

const tiedPendingAttempt = {
  ...newerUnverifiedAttempt,
  idempotencyKey: 'capture:2026-07-15:002',
  contentHash: 'sha256:newer-unverified-tie'
};
await firstPendingStore.saveAttempt(tiedPendingAttempt);
assert.deepEqual((await rebuiltPendingStore.readLatestVerified()).pendingAttempt, tiedPendingAttempt);

const laterInsertedOlderCapture = {
  ...newerUnverifiedAttempt,
  idempotencyKey: 'capture:2026-07-15:003',
  contentHash: 'sha256:older-capture',
  capturedAt: '2026-07-15T15:09:00+08:00'
};
await firstPendingStore.saveAttempt(laterInsertedOlderCapture);
assert.deepEqual(
  (await rebuiltPendingStore.readLatestVerified()).pendingAttempt,
  tiedPendingAttempt,
  'capturedAt wins first and rowid only breaks equal-time ties'
);

console.log('PASS daily review store pending recovery');

const supersededDb = new FakeD1();
const supersededStore = createDailyReviewStore(supersededDb);
const stalePending = {
  ...newerUnverifiedAttempt,
  idempotencyKey: 'capture:2026-07-15:stale-pending',
  contentHash: 'sha256:stale-pending',
  capturedAt: '2026-07-15T15:10:00+08:00'
};
await supersededStore.saveAttempt(stalePending);
const laterVerifiedAttempt = {
  ...firstAttempt,
  idempotencyKey: 'capture:2026-07-15:verified-later',
  contentHash: 'sha256:verified-later',
  capturedAt: '2026-07-15T15:11:00+08:00',
  reviewDate: '2026-07-15',
  captureDate: '2026-07-15',
  audit: {
    ...firstAttempt.audit,
    reviewDate: '2026-07-15'
  }
};
const laterVerified = verifiedData(laterVerifiedAttempt, 1, 'later complete evidence');
await supersededStore.saveVerified(laterVerified);
assert.deepEqual(
  await supersededStore.readLatestVerified(),
  latestResult(storedVerified(laterVerified, 1)),
  'an older incomplete candidate must not remain pending after newer evidence verifies'
);

console.log('PASS daily review store superseded pending');

const lateOldCandidate = {
  ...newerUnverifiedAttempt,
  idempotencyKey: 'capture:2026-07-14:late-old-candidate',
  contentHash: 'sha256:late-old-candidate',
  reviewDate: '2026-07-14',
  capturedAt: '2026-07-15T16:30:00+08:00',
  audit: {
    ...newerUnverifiedAttempt.audit,
    reviewDate: '2026-07-14'
  }
};
await supersededStore.saveAttempt(lateOldCandidate);
assert.equal(
  (await supersededStore.readLatestVerified()).pendingAttempt,
  null,
  'a late retry for an older review date is not a newer pending review'
);

const compatDb = new FakeD1();
compatDb.legacyRow = {
  target_date: '2026-07-14',
  received_at: '2026-07-14T17:00:00.000Z',
  payload_json: JSON.stringify({
    source: 'edge-extension',
    targetDate: '2026-07-14',
    pageUrl: 'https://private.example/account/secret',
    records: [{ requestPostData: 'token=old-private-token' }]
  })
};
const originalLegacyRow = structuredClone(compatDb.legacyRow);
const compatStore = createDailyReviewStore(compatDb);
const compatAttempt = {
  ...firstAttempt,
  idempotencyKey: 'capture:2026-07-14:compat',
  contentHash: 'sha256:compat',
  capturedAt: '2026-07-14T16:10:00.000Z'
};
await compatStore.saveAttempt(compatAttempt);
const compatVerified = {
  attempt: compatAttempt,
  dailyReview: {
    reviewDate: '2026-07-14',
    captureDate: '2026-07-15',
    capturedAt: compatAttempt.capturedAt,
    pnl: '2462.39',
    basic: { capital: '282113.75', pnl: '+2462.39', position: '8成' },
    capital: {
      totalAsset: '282113.75',
      investedMarketValue: '220000.00',
      reverseRepoValue: '170000.00',
      cash: '62113.75',
      positionRatio: '0.7798'
    },
    holdings: [
      {
        code: '000001',
        name: '样本股票',
        quantity: '1000',
        price: '50.00',
        value: '50000.00',
        privateUrl: 'https://private.example/holding-secret'
      },
      {
        code: '204001',
        name: 'GC001-真实逆回购名称',
        quantity: '170',
        price: '1.23',
        value: '170000.00'
      }
    ],
    trades: [
      {
        code: '000001',
        name: '样本股票',
        side: '买入',
        date: '2026-07-14',
        time: '10:01:02',
        price: '50.00',
        quantity: '1000',
        amount: '50000.00',
        fee: '5.00',
        accountRef: 'private-account-hash',
        sequenceId: 'private-sequence',
        requestPostData: 'token=new-private-token'
      },
      {
        code: '204001',
        name: 'GC001-真实逆回购名称',
        side: '买入',
        date: '2026-07-14',
        time: '15:02:07',
        price: '1.23',
        quantity: '170',
        amount: '170000.00'
      }
    ],
    normalizedEvidence: { cookie: 'private-cookie' },
    syncKey: 'private-write-key'
  },
  audit: {
    reviewDate: '2026-07-14',
    status: 'verified',
    checkedAt: '2026-07-14T17:00:00.000Z',
    verifiedAt: '2026-07-14T17:00:00.000Z'
  }
};

compatDb.failBatchAt = 3;
await assert.rejects(
  () => compatStore.saveVerified(compatVerified),
  /forced batch failure/
);
assert.deepEqual(
  compatDb.legacyRow,
  originalLegacyRow,
  'the last raw v12 row stays available until the first new verified transaction commits'
);

compatDb.failBatchAt = null;
await compatStore.saveVerified(compatVerified);
const legacyPayload = JSON.parse(compatDb.legacyRow.payload_json);
assert.deepEqual(
  {
    source: legacyPayload.source,
    targetDate: legacyPayload.targetDate,
    receivedAt: legacyPayload.receivedAt,
    recordCount: legacyPayload.records.length
  },
  {
    source: 'daily-review-verified-compat',
    targetDate: '2026-07-14',
    receivedAt: '2026-07-14T16:10:00.000Z',
    recordCount: 3
  }
);
const legacyJson = JSON.stringify(legacyPayload);
for (const forbidden of [
  'normalizedEvidence',
  'accountRef',
  'sequenceId',
  'requestPostData',
  'private.example',
  'private-account',
  'private-sequence',
  'private-cookie',
  'private-write-key',
  'private-token',
  'GC001-真实逆回购名称'
]) {
  assert.doesNotMatch(legacyJson, new RegExp(forbidden));
}
assert.doesNotMatch(legacyJson, /https?:\/\//, 'compatibility endpoint labels must not contain a private URL');

const compatPosition = legacyPayload.records
  .find((record) => record.url.endsWith('/stock_position'))
  .data.ex_data;
assert.deepEqual(
  compatPosition.position.find((holding) => holding.code === '888880'),
  {
    code: '888880',
    name: '标准券（逆回购占用）',
    count: '1',
    price: '170000.00',
    value: '170000.00'
  },
  'reverse repo remains in total position value through one anonymous hidden placeholder'
);

const v12Mapped = mapTzzbCaptureToReview(legacyPayload.records, {
  targetDate: legacyPayload.targetDate
});
assert.deepEqual(v12Mapped.basic, {
  capital: '282113.75',
  position: '8成',
  pnl: '+2462.39'
});
assert.deepEqual(
  v12Mapped.holdings.map((holding) => [holding.code, holding.name, holding.value, holding.weight]),
  [['000001', '样本股票', '50000.00', '17.7%']],
  'v12 sees ordinary holdings but hides the anonymous reverse-repo placeholder'
);
assert.deepEqual(
  v12Mapped.trades.map((trade) => [trade.time, trade.name, trade.side, trade.price, trade.qty, trade.amount]),
  [['10:01:02', '样本股票', '买入', '50', '1000', '50000.00']]
);
assert.deepEqual(
  buildLegacyRollbackPayload(compatVerified.dailyReview),
  legacyPayload,
  'the persisted row is exactly the DailyReview-only synthetic serializer output'
);

console.log('PASS daily review v12 rollback compatibility');

const migration = fs.readFileSync(
  new URL('../drizzle/0002_daily_review_ledger.sql', import.meta.url),
  'utf8'
);
for (const table of [
  'daily_review_candidates',
  'daily_review_revisions',
  'reconciliation_audits',
  'latest_verified_pointer'
]) {
  assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
}
assert.match(migration, /normalized_evidence_json TEXT NOT NULL/);
assert.match(migration, /state TEXT NOT NULL/);
assert.match(migration, /attempt_audit_json TEXT NOT NULL/);
assert.match(migration, /captured_at TEXT NOT NULL/);
assert.match(migration, /PRIMARY KEY \(review_date, revision\)/);
assert.match(migration, /CHECK \(id = 1\)/);
assert.doesNotMatch(migration, /raw_records|records_json|DROP TABLE[^;]*tzzb_latest_sync/i);
assert.doesNotMatch(
  migration,
  /DELETE FROM tzzb_latest_sync/i,
  'migration must preserve the working v12 row until a new verified transaction replaces it'
);

console.log('PASS daily review ledger migration');
