import assert from 'node:assert/strict';
import { createCloudWorker } from '../cloud/worker.mjs';

const submitted = [];
const latestVerified = {
  dailyReview: {
    reviewDate: '2026-07-14',
    date: '2026-07-14',
    capturedAt: '2026-07-15T00:09:00+08:00',
    basic: { capital: '282113.75', pnl: '+2462.39', position: '2成' },
    capital: { reverseRepoValue: '0.00', positionRatio: '0.2047' },
    holdings: [],
    trades: []
  },
  audit: {
    status: 'verified',
    reviewDate: '2026-07-14',
    capturedAt: '2026-07-15T00:09:00+08:00',
    verifiedAt: '2026-07-15T00:10:00+08:00',
    issueCodes: []
  },
  pendingAttempt: null
};

const sync = {
  async submitCapture(input) {
    submitted.push(input);
    return { state: 'verified', reviewDate: '2026-07-14', audit: latestVerified.audit };
  },
  async readLatestVerified() {
    return latestVerified;
  }
};

const app = createCloudWorker({
  indexHtml: '<!doctype html><h1>今日复盘工作台</h1>',
  dailyReviewSyncFactory: () => sync
});
const env = {
  DB: {},
  TZZB_SYNC_ACCESS_KEY: 'write-only-secret',
  TZZB_OWNER_EMAIL: 'owner@example.com'
};

function request(path, options = {}) {
  return new Request(`https://review.example.com${path}`, options);
}

const anonymous = await app.fetch(request('/api/sync/latest'), env);
assert.equal(anonymous.status, 401, 'anonymous reads should be blocked inside the Worker as defense in depth');

const otherAccount = await app.fetch(request('/api/sync/latest', {
  headers: { 'oai-authenticated-user-email': 'other@example.com' }
}), env);
assert.equal(otherAccount.status, 403, 'only the configured owner account may read review data');

const owner = await app.fetch(request('/api/sync/latest', {
  headers: {
    'oai-authenticated-user-email': 'owner@example.com',
    Origin: 'https://review.example.com'
  }
}), env);
assert.equal(owner.status, 200);
assert.equal(owner.headers.get('access-control-allow-origin'), 'https://review.example.com');
const ownerBody = await owner.json();
assert.equal(ownerBody.ok, true);
assert.equal(ownerBody.dailyReview.basic.pnl, '+2462.39');
assert.equal(ownerBody.audit.status, 'verified');

const hostileOrigin = await app.fetch(request('/api/sync/latest', {
  headers: {
    'oai-authenticated-user-email': 'owner@example.com',
    Origin: 'https://evil.example.com'
  }
}), env);
assert.equal(hostileOrigin.headers.get('access-control-allow-origin'), null, 'CORS must never use a wildcard or reflect another origin');

const deniedUpload = await app.fetch(request('/api/sync/tzzb', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-TZZB-Sync-Key': 'wrong' },
  body: JSON.stringify({ idempotencyKey: 'capture-1' })
}), env);
assert.equal(deniedUpload.status, 401);

const acceptedUpload = await app.fetch(request('/api/sync/tzzb', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-TZZB-Sync-Key': 'write-only-secret' },
  body: JSON.stringify({
    idempotencyKey: 'capture-1',
    capturedAt: '2026-07-14T16:09:00.000Z',
    captureDate: '2026-07-15',
    evidence: { activeAccountRefs: [], records: [] }
  })
}), env);
assert.equal(acceptedUpload.status, 200);
assert.equal((await acceptedUpload.json()).state, 'verified');
assert.equal(submitted.length, 1);

const health = await app.fetch(request('/api/sync/health', {
  headers: { 'oai-authenticated-user-email': 'owner@example.com' }
}), env);
const healthBody = await health.json();
assert.equal(health.status, 200);
assert.equal(healthBody.readyForReview, true);
assert.equal(healthBody.reviewDate, '2026-07-14');
assert.equal(healthBody.pending, false);

console.log('PASS daily review Worker routes');
