import assert from 'node:assert/strict';
import { createMarketSnapshotStore } from '../cloud/market-snapshot-store.mjs';

class FakeD1 {
  constructor() {
    this.rows = new Map();
    this.schemaReady = false;
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
        if (/WHERE trade_date = \?/.test(sql)) return db.rows.get(values[0]) || null;
        if (/ORDER BY trade_date DESC/.test(sql)) {
          return [...db.rows.values()].sort((a, b) => b.trade_date.localeCompare(a.trade_date))[0] || null;
        }
        throw new Error(`Unexpected first SQL: ${sql}`);
      },
      async run() {
        if (/CREATE TABLE IF NOT EXISTS market_snapshots/.test(sql)) {
          db.schemaReady = true;
          return { success: true };
        }
        if (/INSERT INTO market_snapshots/.test(sql)) {
          assert.equal(db.schemaReady, true);
          const [tradeDate, updatedAt, finalizedAt, payloadJson] = values;
          const current = db.rows.get(tradeDate);
          const force = !/WHERE market_snapshots\.finalized_at IS NULL/.test(sql);
          if (force || !current?.finalized_at) {
            db.rows.set(tradeDate, {
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

const db = new FakeD1();
const store = createMarketSnapshotStore(db);
const intraday = {
  tradeDate: '2026-07-13',
  updatedAt: '2026-07-13T06:59:00.000Z',
  finalizedAt: '',
  market: { mainLines: '盘中主线', marketOne: '盘中判断' }
};
await store.write(intraday);
assert.deepEqual(await store.read('2026-07-13'), intraday);

const finalSnapshot = {
  ...intraday,
  updatedAt: '2026-07-13T07:05:00.000Z',
  finalizedAt: '2026-07-13T07:05:01.000Z',
  market: { mainLines: '收盘主线', marketOne: '收盘判断' }
};
await store.write(finalSnapshot);
assert.deepEqual(await store.readLatest(), finalSnapshot);

await store.write({
  ...intraday,
  updatedAt: '2026-07-13T08:00:00.000Z',
  market: { mainLines: '错误覆盖', marketOne: '错误覆盖' }
});
assert.deepEqual(await store.read('2026-07-13'), finalSnapshot);

const upgradedSnapshot = {
  ...finalSnapshot,
  updatedAt: '2026-07-13T08:05:00.000Z',
  finalizedAt: '2026-07-13T08:05:01.000Z',
  market: {
    algorithmVersion: 'concept-ranking-v2',
    mainLines: '概念：医药电商、GPU、人工智能、中药概念、华为概念',
    marketOne: '升级后的市场判断'
  }
};
await store.write(upgradedSnapshot, { force: true });
assert.deepEqual(await store.read('2026-07-13'), upgradedSnapshot);
assert.throws(() => createMarketSnapshotStore(null), /D1 binding DB is required/);

console.log('PASS market snapshot store');
