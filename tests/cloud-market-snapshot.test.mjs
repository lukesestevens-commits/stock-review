import assert from 'node:assert/strict';
import { createCloudWorker } from '../cloud/worker.mjs';
import { MARKET_ALGORITHM_VERSION } from '../tools/market-public-data.mjs';

class FakeD1 {
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
        if (/WHERE trade_date = \?/.test(sql)) return db.marketRows.get(values[0]) || null;
        if (/ORDER BY trade_date DESC/.test(sql)) {
          return [...db.marketRows.values()].sort((a, b) => b.trade_date.localeCompare(a.trade_date))[0] || null;
        }
        throw new Error(`Unexpected first SQL: ${sql}`);
      },
      async run() {
        if (/CREATE TABLE IF NOT EXISTS market_snapshots/.test(sql)) return { success: true };
        if (/INSERT INTO market_snapshots/.test(sql)) {
          const [tradeDate, updatedAt, finalizedAt, payloadJson] = values;
          const current = db.marketRows.get(tradeDate);
          const force = !/WHERE market_snapshots\.finalized_at IS NULL/.test(sql);
          if (force || !current?.finalized_at) {
            db.marketRows.set(tradeDate, {
              trade_date: tradeDate,
              updated_at: updatedAt,
              finalized_at: finalizedAt || null,
              payload_json: payloadJson
            });
          }
          return { success: true };
        }
        throw new Error(`Unexpected run SQL: ${sql}`);
      }
    };
  }
}

function tencentRow(market, code, quoteStamp, changePercent) {
  const fields = Array(33).fill('0');
  fields[1] = code;
  fields[2] = code;
  fields[3] = '3900';
  fields[30] = quoteStamp;
  fields[31] = String(changePercent * 10);
  fields[32] = String(changePercent);
  return `v_${market}${code}="${fields.join('~')}";`;
}

function tencentPayload(quoteStamp) {
  return [
    tencentRow('sh', '000001', quoteStamp, -1.1),
    tencentRow('sz', '399001', quoteStamp, -1.4),
    tencentRow('sz', '399006', quoteStamp, -1.8)
  ].join('\n');
}

function createMarketFetch(state) {
  return async (url) => {
    const value = String(url);
    if (state.fail) throw new Error('upstream unavailable');
    if (value.includes('qt.gtimg.cn')) {
      state.tencentCalls += 1;
      return new Response(tencentPayload(state.quoteStamp), { status: 200 });
    }
    if (value.includes('q.stock.sohu.com')) {
      return new Response(`<script>PEAK_ODIA(['pllist',
        ['7741','医药电商','49','14.35','+0.24','3.00%','11596032','116650884','cn_600129','太极集团','17.94','+1.36','8.20%'],
        ['7970','GPU','13','177.62','+1.96','2.80%','13196240','597412349','cn_688802','沐曦股份-U','972.86','+63.51','6.98%'],
        ['4485','人工智能','120','20.00','+0.30','2.60%','20000000','800000000','cn_000001','样本股','10.00','+0.10','1.00%'],
        ['7582','中药概念','131','17.38','+0.02','2.40%','37254681','375952915','cn_300534','陇神戎发','9.00','+1.50','20.00%'],
        ['4445','华为概念','200','18.00','+0.20','2.20%','50000000','900000000','cn_000002','样本股2','20.00','+0.20','1.00%']]);</script>`, { status: 200 });
    }
    return new Response('unavailable', { status: 502 });
  };
}

async function read(app, db) {
  const response = await app.fetch(new Request('https://review.example.com/api/market-snapshot'), { DB: db });
  return { response, body: await response.json() };
}

let now = new Date('2026-07-13T06:59:30.000Z');
const state = { fail: false, quoteStamp: '20260713145930', tencentCalls: 0 };
const db = new FakeD1();
const app = createCloudWorker({
  fetchImpl: createMarketFetch(state),
  now: () => new Date(now)
});

const first = await read(app, db);
assert.equal(first.response.status, 200);
assert.equal(first.body.cache.finalized, false);
assert.equal(first.body.cache.stale, false);
assert.equal(first.body.cache.tradeDate, '2026-07-13');
assert.match(first.body.market.mainLines, /^概念：/);
assert.equal(first.body.market.algorithmVersion, MARKET_ALGORITHM_VERSION);
assert.equal(state.tencentCalls, 1);

now = new Date('2026-07-13T06:59:50.000Z');
const cached = await read(app, db);
assert.equal(cached.response.status, 200);
assert.equal(cached.body.cache.source, 'cloud-cache');
assert.equal(state.tencentCalls, 1, 'fresh cloud cache should avoid another upstream request');

now = new Date('2026-07-13T07:01:00.000Z');
state.quoteStamp = '20260713150018';
const finalized = await read(app, db);
assert.equal(finalized.response.status, 200);
assert.equal(finalized.body.cache.finalized, true);
assert.ok(finalized.body.cache.finalizedAt);
assert.equal(state.tencentCalls, 2);

now = new Date('2026-07-13T08:00:00.000Z');
state.fail = true;
const frozen = await read(app, db);
assert.equal(frozen.response.status, 200);
assert.equal(frozen.body.cache.finalized, true);
assert.equal(frozen.body.market.updatedAt, finalized.body.market.updatedAt);
assert.equal(state.tencentCalls, 2, 'finalized snapshot should never re-fetch upstream');

let staleNow = new Date('2026-07-14T06:30:00.000Z');
const staleState = { fail: false, quoteStamp: '20260714143000', tencentCalls: 0 };
const staleDb = new FakeD1();
const staleApp = createCloudWorker({
  fetchImpl: createMarketFetch(staleState),
  now: () => new Date(staleNow)
});
const staleSeed = await read(staleApp, staleDb);
staleNow = new Date('2026-07-14T06:31:01.000Z');
staleState.fail = true;
const staleFallback = await read(staleApp, staleDb);
assert.equal(staleFallback.response.status, 200);
assert.equal(staleFallback.body.cache.stale, true);
assert.equal(staleFallback.body.market.updatedAt, staleSeed.body.market.updatedAt);

let upgradeNow = new Date('2026-07-13T07:10:00.000Z');
const upgradeState = { fail: false, quoteStamp: '20260713150030', tencentCalls: 0 };
const upgradeDb = new FakeD1();
upgradeDb.marketRows.set('2026-07-13', {
  trade_date: '2026-07-13',
  updated_at: '2026-07-13T07:00:00.000Z',
  finalized_at: '2026-07-13T07:00:00.000Z',
  payload_json: JSON.stringify({
    mainLines: '抗跌板块：传媒、非银金融、机械设备',
    marketOne: '旧算法市场判断',
    updatedAt: '2026-07-13T07:00:00.000Z'
  })
});
const upgradeApp = createCloudWorker({
  fetchImpl: createMarketFetch(upgradeState),
  now: () => new Date(upgradeNow)
});
const upgraded = await read(upgradeApp, upgradeDb);
assert.equal(upgraded.response.status, 200);
assert.equal(upgraded.body.market.algorithmVersion, MARKET_ALGORITHM_VERSION);
assert.match(upgraded.body.market.mainLines, /^概念：/);
assert.doesNotMatch(upgraded.body.market.mainLines, /传媒|非银金融|机械设备/);
assert.equal(upgraded.body.cache.finalized, true);
assert.equal(upgradeState.tencentCalls, 1, 'old finalized cache should be rebuilt once');

const mismatchedDb = new FakeD1();
const mismatchedState = { fail: false, quoteStamp: '20260715150030', tencentCalls: 0 };
const mismatchedApp = createCloudWorker({
  fetchImpl: createMarketFetch(mismatchedState),
  now: () => new Date('2026-07-15T07:10:00.000Z')
});
const mismatchedResponse = await mismatchedApp.fetch(
  new Request('https://review.example.com/api/market-snapshot?date=2026-07-14'),
  { DB: mismatchedDb }
);
const mismatchedBody = await mismatchedResponse.json();
assert.equal(mismatchedResponse.status, 404, 'an exact-date request must not return a snapshot from another trading day');
assert.equal(mismatchedBody.ok, false);
assert.equal(mismatchedBody.requestedDate, '2026-07-14');
assert.equal(mismatchedBody.availableTradeDate, '2026-07-15');
assert.ok(mismatchedDb.marketRows.has('2026-07-15'), 'the valid upstream snapshot should still be cached under its real trade date');

console.log('PASS cloud market snapshot');
