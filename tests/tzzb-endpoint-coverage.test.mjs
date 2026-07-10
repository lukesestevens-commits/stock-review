import assert from 'node:assert/strict';
import {
  analyzeTzzbEndpointCoverage,
  mergeCaptureRecords
} from '../tools/tzzb-endpoint-coverage.mjs';

const today = '2026-07-06';
const stockPosition = {
  capturedAt: `${today}T09:30:00.000Z`,
  method: 'POST',
  status: 200,
  url: 'https://tzzb.10jqka.com.cn/caishen_httpserver/tzzb/caishen_fund/pc/asset/v1/stock_position',
  responseText: '{"ex_data":{"position":[{"name":"持仓A","value":"1000"}]}}'
};
const trade = {
  capturedAt: `${today}T09:31:00.000Z`,
  method: 'POST',
  status: 200,
  url: 'https://tzzb.10jqka.com.cn/caishen_httpserver/tzzb/caishen_fund/pc/asset/v1/get_money_history',
  responseText: '{"ex_data":{"list":[{"entry_date":"2026-07-06","name":"交易A"}]}}'
};
const quote = {
  capturedAt: `${today}T09:32:00.000Z`,
  method: 'GET',
  status: 200,
  url: 'https://tzzb.10jqka.com.cn/caishen_httpserver/tzzb/caishen_fund/pc/quote/v1/pass_quotes',
  responseText: '{"ok":true}'
};

const partial = analyzeTzzbEndpointCoverage([quote]);
assert.equal(partial.hasFundsOrHoldings, false);
assert.equal(partial.hasTradeEndpoint, false);
assert.equal(partial.readyForReview, false);
assert.deepEqual(partial.missing, ['资金/持仓', '交易记录']);
assert.equal(partial.quoteEndpoints, 1);

const ready = analyzeTzzbEndpointCoverage([stockPosition, trade, quote]);
assert.equal(ready.hasFundsOrHoldings, true);
assert.equal(ready.hasTradeEndpoint, true);
assert.equal(ready.readyForReview, true);
assert.deepEqual(ready.missing, []);
assert.equal(ready.fundsOrHoldingEndpoints, 1);
assert.equal(ready.tradeEndpoints, 1);

const merged = mergeCaptureRecords([stockPosition, trade], [quote, stockPosition], { targetDate: today });
assert.equal(merged.length, 3, 'merge should keep existing useful records and append later quote records');
assert.deepEqual(
  analyzeTzzbEndpointCoverage(merged),
  ready,
  'quote-only later payload should not erase readiness'
);

console.log('PASS tzzb endpoint coverage');
