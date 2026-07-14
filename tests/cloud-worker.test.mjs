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

const app = createCloudWorker({
  indexHtml: '<!doctype html><h1>今日复盘工作台</h1>',
  fetchImpl: marketFetch,
  dailyReviewSyncFactory: () => sync
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
