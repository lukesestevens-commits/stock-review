import assert from 'node:assert/strict';
import { createCloudWorker } from '../cloud/worker.mjs';

class MarketD1 {
  constructor() {
    this.marketRows = new Map();
  }

  prepare(sql) {
    const db = this;
    let values = [];
    return {
      bind(...nextValues) {
        values = nextValues;
        return this;
      },
      async first() {
        if (/FROM market_snapshots/.test(sql) && /WHERE trade_date = \?/.test(sql)) {
          return db.marketRows.get(values[0]) || null;
        }
        if (/FROM market_snapshots/.test(sql) && /ORDER BY trade_date DESC/.test(sql)) {
          return [...db.marketRows.values()].sort((a, b) => b.trade_date.localeCompare(a.trade_date))[0] || null;
        }
        throw new Error(`Unexpected first SQL: ${sql}`);
      },
      async run() {
        if (/CREATE TABLE IF NOT EXISTS market_snapshots/.test(sql)) return { success: true };
        if (/INSERT INTO market_snapshots/.test(sql)) {
          const [tradeDate, updatedAt, finalizedAt, payloadJson] = values;
          db.marketRows.set(tradeDate, {
            trade_date: tradeDate,
            updated_at: updatedAt,
            finalized_at: finalizedAt || null,
            payload_json: payloadJson
          });
          return { success: true };
        }
        throw new Error(`Unexpected run SQL: ${sql}`);
      }
    };
  }
}

function request(path, options = {}) {
  return new Request(`https://review.example.com${path}`, options);
}

async function marketFetch(url) {
  const value = String(url);
  if (value.includes('/ulist.np/')) {
    return new Response(JSON.stringify({
      data: {
        diff: [
          { f12: '000001', f14: '上证指数', f2: 3000, f3: 1.1, f4: 32 },
          { f12: '399001', f14: '深证成指', f2: 9800, f3: 0.9, f4: 88 },
          { f12: '399006', f14: '创业板指', f2: 2000, f3: 0.8, f4: 16 }
        ]
      }
    }), { status: 200 });
  }
  if (value.includes('/clist/get')) {
    return new Response(JSON.stringify({
      data: { diff: [{ f12: 'BK1', f14: '云计算', f3: 3.2, f62: 1000000 }] }
    }), { status: 200 });
  }
  return new Response('not found', { status: 404 });
}

const submitted = [];
let latest = { dailyReview: null, audit: null, pendingAttempt: null };
const sync = {
  async submitCapture(input) {
    submitted.push(input);
    latest = {
      dailyReview: null,
      audit: null,
      pendingAttempt: {
        state: 'stored-unverified',
        capturedAt: input.capturedAt,
        captureDate: input.captureDate,
        reviewDate: '2026-07-14',
        normalizedEvidence: input.evidence,
        audit: { status: 'held', reviewDate: '2026-07-14', issueCodes: ['ASSET_TREND_MISSING'] }
      }
    };
    return { state: 'stored-unverified', reviewDate: '2026-07-14', audit: latest.pendingAttempt.audit };
  },
  async readLatestVerified() {
    return structuredClone(latest);
  }
};

class MemoryDraftStore {
  constructor() {
    this.drafts = new Map();
  }

  async read(reviewDate) {
    return structuredClone(this.drafts.get(reviewDate) || null);
  }

  async save({ reviewDate, record, expectedVersion, updatedAt }) {
    const current = this.drafts.get(reviewDate) || null;
    const currentVersion = Number(current?.version || 0);
    if (expectedVersion !== currentVersion) {
      const error = new Error('draft version conflict');
      error.code = 'DRAFT_VERSION_CONFLICT';
      error.current = structuredClone(current);
      throw error;
    }
    const draft = { reviewDate, version: currentVersion + 1, updatedAt, record: structuredClone(record) };
    this.drafts.set(reviewDate, draft);
    return structuredClone(draft);
  }

  async list({ from, to, limit }) {
    return [...this.drafts.values()]
      .filter((draft) => draft.reviewDate >= from && draft.reviewDate <= to)
      .sort((left, right) => right.reviewDate.localeCompare(left.reviewDate))
      .slice(0, limit)
      .map((draft) => structuredClone(draft));
  }
}

const draftStore = new MemoryDraftStore();

const app = createCloudWorker({
  indexHtml: '<!doctype html><h1>今日复盘工作台</h1>',
  fetchImpl: marketFetch,
  dailyReviewSyncFactory: () => sync,
  reviewDraftStoreFactory: () => draftStore
});
const env = {
  DB: new MarketD1(),
  TZZB_SYNC_WRITE_KEY: 'write-only-secret',
  TZZB_OWNER_EMAIL: 'owner@example.com'
};
const ownerHeaders = { 'oai-authenticated-user-email': 'owner@example.com' };

const home = await app.fetch(request('/'), env);
assert.equal(home.status, 200);
assert.match(await home.text(), /今日复盘工作台/);

const preflight = await app.fetch(request('/api/sync/tzzb', {
  method: 'OPTIONS',
  headers: { Origin: 'https://review.example.com' }
}), env);
assert.equal(preflight.status, 204);
assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://review.example.com');
assert.match(preflight.headers.get('access-control-allow-headers'), /X-TZZB-Sync-Key/i);

assert.equal((await app.fetch(request('/api/sync/latest'), env)).status, 401);
assert.equal((await app.fetch(request('/api/sync/latest?key=write-only-secret'), env)).status, 401);
assert.equal((await app.fetch(request('/api/sync/latest', {
  headers: { 'oai-authenticated-user-email': 'other@example.com' }
}), env)).status, 403);
assert.equal((await app.fetch(request('/api/sync/latest', { headers: ownerHeaders }), env)).status, 404);

assert.equal((await app.fetch(request('/api/review-draft?date=2026-07-14'), env)).status, 401);
assert.equal((await app.fetch(request('/api/review-draft?date=2026-07-14', { headers: ownerHeaders }), env)).status, 404);

const savedDraftResponse = await app.fetch(request('/api/review-draft', {
  method: 'PUT',
  headers: { ...ownerHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    reviewDate: '2026-07-14',
    expectedVersion: 0,
    record: { date: '2026-07-14', reflection: { rightThing: '按计划执行' } }
  })
}), env);
const savedDraft = await savedDraftResponse.json();
assert.equal(savedDraftResponse.status, 200);
assert.equal(savedDraft.draft.version, 1);

const readDraftResponse = await app.fetch(request('/api/review-draft?date=2026-07-14', {
  headers: ownerHeaders
}), env);
const readDraft = await readDraftResponse.json();
assert.equal(readDraftResponse.status, 200);
assert.equal(readDraft.draft.record.reflection.rightThing, '按计划执行');

assert.equal((await app.fetch(request('/api/review-drafts?from=2026-07-01&to=2026-07-31'), env)).status, 401);
assert.equal((await app.fetch(request('/api/review-drafts?from=2026-07-01&to=2026-07-31', {
  headers: { 'oai-authenticated-user-email': 'other@example.com' }
}), env)).status, 403);
const listedDraftsResponse = await app.fetch(request('/api/review-drafts?from=2026-07-01&to=2026-07-31&limit=20', {
  headers: ownerHeaders
}), env);
const listedDrafts = await listedDraftsResponse.json();
assert.equal(listedDraftsResponse.status, 200);
assert.equal(listedDrafts.drafts.length, 1);
assert.equal(listedDrafts.drafts[0].reviewDate, '2026-07-14');
assert.equal((await app.fetch(request('/api/review-drafts?from=bad&to=2026-07-31', { headers: ownerHeaders }), env)).status, 400);
assert.equal((await app.fetch(request('/api/review-drafts?from=2026-08-01&to=2026-07-31', { headers: ownerHeaders }), env)).status, 400);

const conflictedDraftResponse = await app.fetch(request('/api/review-draft', {
  method: 'PUT',
  headers: { ...ownerHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    reviewDate: '2026-07-14',
    expectedVersion: 0,
    record: { date: '2026-07-14', reflection: { rightThing: '过期写入' } }
  })
}), env);
const conflictedDraft = await conflictedDraftResponse.json();
assert.equal(conflictedDraftResponse.status, 409);
assert.equal(conflictedDraft.current.version, 1, 'a conflicting device receives the current cloud version');

const mismatchedDraftResponse = await app.fetch(request('/api/review-draft', {
  method: 'PUT',
  headers: { ...ownerHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    reviewDate: '2026-07-16',
    expectedVersion: 0,
    record: { date: '2026-07-15', reflection: { rightThing: '错误日期分区' } }
  })
}), env);
assert.equal(mismatchedDraftResponse.status, 400, 'record.date must match the review-date partition');

const invalidUpload = await app.fetch(request('/api/sync/tzzb', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-TZZB-Sync-Key': 'write-only-secret' },
  body: '{'
}), env);
assert.equal(invalidUpload.status, 400);

const deniedBearer = await app.fetch(request('/api/sync/tzzb', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer write-only-secret' },
  body: '{}'
}), env);
assert.equal(deniedBearer.status, 401, 'the independent write key is accepted only in its dedicated header');

const capturedAt = '2026-07-14T16:09:44.269Z';
const legacyUpload = await app.fetch(request('/api/sync/tzzb', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-TZZB-Sync-Key': 'write-only-secret' },
  body: JSON.stringify({
    pushedAt: capturedAt,
    records: [{
      capturedAt,
      status: 200,
      url: 'https://tzzb.10jqka.com.cn/caishen_fund/pc/asset/v1/stock_position',
      requestPostData: 'manual_id=private-account&token=do-not-keep',
      responseText: JSON.stringify({ ex_data: { total_asset: '10000', total_value: '0', money_remain: '10000', position_rate: '0', position: [] } })
    }]
  })
}), env);
const legacyBody = await legacyUpload.json();
assert.equal(legacyUpload.status, 200);
assert.equal(legacyBody.state, 'stored-unverified');
assert.equal(submitted.length, 1);
assert.equal(submitted[0].captureDate, '2026-07-15');
assert.match(submitted[0].idempotencyKey, /^legacy-[a-f0-9]{64}$/);
assert.equal(submitted[0].evidence.records.length, 1);
assert.doesNotMatch(JSON.stringify(submitted[0].evidence), /private-account|do-not-keep/);

const pendingRead = await app.fetch(request('/api/sync/latest', { headers: ownerHeaders }), env);
const pendingBody = await pendingRead.json();
assert.equal(pendingRead.status, 200);
assert.equal(pendingBody.pendingAttempt.reviewDate, '2026-07-14');
assert.equal(Object.hasOwn(pendingBody.pendingAttempt, 'normalizedEvidence'), false, 'candidate evidence must not be returned to the page');

latest = {
  dailyReview: { reviewDate: '2026-07-14', capturedAt, basic: { pnl: '+2462.39' } },
  audit: { status: 'verified', reviewDate: '2026-07-14', capturedAt, issueCodes: [] },
  pendingAttempt: null
};
const health = await app.fetch(request('/api/sync/health', { headers: ownerHeaders }), env);
const healthBody = await health.json();
assert.equal(health.status, 200);
assert.equal(healthBody.reviewDate, '2026-07-14');
assert.equal(healthBody.readyForReview, true);
assert.equal(healthBody.pending, false);

const market = await app.fetch(request('/api/market-snapshot'), env);
const marketBody = await market.json();
assert.equal(market.status, 200);
assert.equal(marketBody.ok, true);
assert.equal(marketBody.market.indexState, '指数强');
assert.match(marketBody.market.mainLines, /云计算/);

console.log('PASS cloud worker');
