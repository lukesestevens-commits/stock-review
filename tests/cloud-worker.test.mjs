import assert from 'node:assert/strict';
import { createCloudWorker } from '../cloud/worker.mjs';

class FakeD1 {
  constructor() {
    this.row = null;
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
        if (!/SELECT payload_json/.test(sql)) throw new Error(`Unexpected first SQL: ${sql}`);
        return db.row;
      },
      async run() {
        if (/CREATE TABLE IF NOT EXISTS tzzb_latest_sync/.test(sql)) return { success: true };
        if (/INSERT INTO tzzb_latest_sync/.test(sql)) {
          db.row = {
            target_date: values[0],
            received_at: values[1],
            payload_json: values[2]
          };
          return { success: true };
        }
        throw new Error(`Unexpected run SQL: ${sql}`);
      }
    };
  }
}

const accessKey = 'mobile-sync-secret';
const firstDate = '2026-07-10';
const secondDate = '2026-07-11';

function stockRecord(date, name = '云端持仓') {
  return {
    capturedAt: `${date}T02:01:00.000Z`,
    type: 'fetch',
    method: 'POST',
    status: 200,
    url: 'https://tzzb.10jqka.com.cn/caishen_httpserver/tzzb/caishen_fund/pc/asset/v1/stock_position',
    responseText: JSON.stringify({
      ex_data: {
        total_asset: '10000',
        total_value: '9000',
        position: [{ name, value: '9000', count: '100', price: '90', position_rate: '0.9000' }]
      }
    })
  };
}

function tradeRecord(date, name = '云端交易', time = '10:00:00') {
  return {
    capturedAt: `${date}T02:01:01.000Z`,
    type: 'fetch',
    method: 'POST',
    status: 200,
    url: 'https://tzzb.10jqka.com.cn/caishen_httpserver/tzzb/caishen_fund/pc/asset/v1/get_money_history',
    responseText: JSON.stringify({
      ex_data: {
        list: [{
          entry_date: date,
          entry_time: time,
          name,
          op_name: '买入',
          entry_price: '10',
          entry_count: '100',
          entry_money: '1000'
        }]
      }
    })
  };
}

function payload(date, records) {
  return {
    source: 'edge-extension',
    targetDate: date,
    pageUrl: 'https://tzzb.10jqka.com.cn/pc/index.html#/myAccount/a/cloud',
    pushedAt: `${date}T02:01:00.000Z`,
    records
  };
}

function jsonRequest(path, options = {}) {
  return new Request(`https://review.example.com${path}`, options);
}

async function body(response) {
  return response.json();
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

const app = createCloudWorker({
  indexHtml: '<!doctype html><h1>今日复盘工作台</h1>',
  fetchImpl: marketFetch
});
const env = { DB: new FakeD1(), TZZB_SYNC_ACCESS_KEY: accessKey };

const home = await app.fetch(jsonRequest('/'), env);
assert.equal(home.status, 200);
assert.match(await home.text(), /今日复盘工作台/);
assert.match(home.headers.get('content-type'), /text\/html/);

const preflight = await app.fetch(jsonRequest('/api/sync/tzzb', { method: 'OPTIONS' }), env);
assert.equal(preflight.status, 204);
assert.match(preflight.headers.get('access-control-allow-headers'), /X-TZZB-Sync-Key/i);

const missingServerKey = await app.fetch(jsonRequest('/api/sync/latest'), { DB: new FakeD1() });
assert.equal(missingServerKey.status, 503);

const denied = await app.fetch(jsonRequest('/api/sync/latest'), env);
assert.equal(denied.status, 401);

const wrong = await app.fetch(jsonRequest('/api/sync/latest?key=wrong'), env);
assert.equal(wrong.status, 401);

const empty = await app.fetch(jsonRequest(`/api/sync/latest?key=${accessKey}`), env);
assert.equal(empty.status, 404);

const invalidUpload = await app.fetch(jsonRequest('/api/sync/tzzb', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-TZZB-Sync-Key': accessKey
  },
  body: '{'
}), env);
assert.equal(invalidUpload.status, 400);

const unavailable = await app.fetch(jsonRequest(`/api/sync/latest?key=${accessKey}`), {
  TZZB_SYNC_ACCESS_KEY: accessKey,
  DB: { prepare() { throw new Error('database unavailable'); } }
});
assert.equal(unavailable.status, 503);

const firstUpload = await app.fetch(jsonRequest('/api/sync/tzzb', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-TZZB-Sync-Key': accessKey
  },
  body: JSON.stringify(payload(firstDate, [stockRecord(firstDate), tradeRecord(firstDate)]))
}), env);
const firstUploadBody = await body(firstUpload);
assert.equal(firstUpload.status, 200);
assert.equal(firstUploadBody.ok, true);
assert.equal(firstUploadBody.raw.readyForReview, true);
assert.equal(firstUploadBody.raw.records, 2);

const mergedUpload = await app.fetch(jsonRequest('/api/sync/tzzb', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessKey}`
  },
  body: JSON.stringify(payload(firstDate, [tradeRecord(firstDate, '第二笔交易', '10:05:00')]))
}), env);
const mergedUploadBody = await body(mergedUpload);
assert.equal(mergedUpload.status, 200);
assert.equal(mergedUploadBody.raw.records, 3);
assert.equal(mergedUploadBody.review.trades.length, 2);

const health = await app.fetch(jsonRequest(`/api/sync/health?key=${accessKey}`), env);
const healthBody = await body(health);
assert.equal(health.status, 200);
assert.equal(healthBody.targetDate, firstDate);
assert.equal(healthBody.latestRecordCount, 3);
assert.equal(healthBody.readyForReview, true);

const latest = await app.fetch(jsonRequest(`/api/sync/latest?key=${accessKey}`), env);
const latestBody = await body(latest);
assert.equal(latest.status, 200);
assert.equal(latestBody.review.holdings[0].name, '云端持仓');
assert.equal(latestBody.review.holdings[0].weight, '90.0%');
assert.deepEqual(latestBody.review.trades.map((item) => item.name), ['云端交易', '第二笔交易']);

const sameDaySnapshotReplacement = await app.fetch(jsonRequest('/api/sync/tzzb', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-TZZB-Sync-Key': accessKey
  },
  body: JSON.stringify({
    ...payload(firstDate, [stockRecord(firstDate, '完整快照持仓')]),
    replaceRecords: true
  })
}), env);
const sameDaySnapshotReplacementBody = await body(sameDaySnapshotReplacement);
assert.equal(sameDaySnapshotReplacement.status, 200);
assert.equal(sameDaySnapshotReplacementBody.raw.records, 1);
assert.equal(sameDaySnapshotReplacementBody.review.holdings[0].name, '完整快照持仓');
assert.equal(sameDaySnapshotReplacementBody.review.trades.length, 0);

const replacement = await app.fetch(jsonRequest('/api/sync/tzzb', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-TZZB-Sync-Key': accessKey
  },
  body: JSON.stringify(payload(secondDate, [stockRecord(secondDate, '新交易日持仓')]))
}), env);
const replacementBody = await body(replacement);
assert.equal(replacement.status, 200);
assert.equal(replacementBody.raw.targetDate, secondDate);
assert.equal(replacementBody.raw.records, 1);
assert.equal(replacementBody.raw.readyForReview, false);

const market = await app.fetch(jsonRequest('/api/market-snapshot'), env);
const marketBody = await body(market);
assert.equal(market.status, 200);
assert.equal(marketBody.ok, true);
assert.equal(marketBody.market.indexState, '指数强');
assert.match(marketBody.market.mainLines, /云计算/);

console.log('PASS cloud worker');
