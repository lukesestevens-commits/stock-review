import assert from 'node:assert/strict';
import { createCloudWorker } from '../cloud/worker.mjs';

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
          if (!current?.finalized_at) {
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
      return new Response(`
        <td class="e1">1</td><td class="e2"><a href="bk_3098.shtml">Media</a></td>
        <td class="e1">2</td><td class="e2"><a href="bk_3100.shtml">Medicine</a></td>
      `, { status: 200 });
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
assert.match(first.body.market.mainLines, /Media/);
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

console.log('PASS cloud market snapshot');
