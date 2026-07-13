import assert from 'node:assert/strict';
import {
  isFinalMarketSnapshot,
  isValidMarketSnapshot,
  marketSnapshotTradeDate
} from '../cloud/market-snapshot-policy.mjs';

function snapshot(times, overrides = {}) {
  const codes = ['000001', '399001', '399006'];
  return {
    mainLines: '强势板块：传媒、医药',
    marketOne: '指数弱，市场退潮，收盘以防守为主。',
    indices: codes.map((code, index) => ({
      code,
      name: code,
      quoteTime: times[index]
    })),
    updatedAt: '2026-07-13T07:05:00.000Z',
    ...overrides
  };
}

const finalSnapshot = snapshot([
  '2026-07-13 15:00:02',
  '2026-07-13 15:00:18',
  '2026-07-13 15:00:09'
]);
assert.equal(isValidMarketSnapshot(finalSnapshot), true);
assert.equal(marketSnapshotTradeDate(finalSnapshot), '2026-07-13');
assert.equal(isFinalMarketSnapshot(finalSnapshot), true);

const intraday = snapshot([
  '2026-07-13 14:59:59',
  '2026-07-13 15:00:18',
  '2026-07-13 15:00:09'
]);
assert.equal(isFinalMarketSnapshot(intraday), false);

const crossDay = snapshot([
  '2026-07-12 15:00:02',
  '2026-07-13 15:00:18',
  '2026-07-13 15:00:09'
]);
assert.equal(marketSnapshotTradeDate(crossDay), '');
assert.equal(isFinalMarketSnapshot(crossDay), false);

assert.equal(isValidMarketSnapshot(snapshot(finalSnapshot.indices, { mainLines: '' })), false);
assert.equal(isValidMarketSnapshot(snapshot(finalSnapshot.indices, { marketOne: '' })), false);
assert.equal(isValidMarketSnapshot(snapshot(finalSnapshot.indices, {
  mainLines: '行业/概念板块暂不可用'
})), false);
assert.equal(isFinalMarketSnapshot({ ...finalSnapshot, indices: finalSnapshot.indices.slice(0, 2) }), false);

console.log('PASS market snapshot policy');
