import assert from 'node:assert/strict';
import { mapTzzbCaptureToReview } from '../tools/tzzb-review-mapper.mjs';

const raw = [
  {
    capturedAt: '2026-07-03T02:00:00.000Z',
    url: 'https://tzzb.10jqka.com.cn/api/caishen_fund/pc/asset/v1/stock_position',
    responseText: JSON.stringify({
      ex_data: {
        total_asset: '10000',
        total_value: '7000',
        position: [{ name: '样本持仓', value: '7000', count: '100', price: '70' }]
      }
    })
  },
  {
    capturedAt: '2026-07-03T02:01:00.000Z',
    url: 'https://tzzb.10jqka.com.cn/api/caishen_fund/pc/asset/v1/get_money_history',
    responseText: JSON.stringify({
      ex_data: {
        list: [{
          entry_date: '2026-07-03',
          entry_time: '10:01:00',
          name: '样本交易',
          op_name: '买入',
          entry_price: '10',
          entry_count: '100',
          entry_money: '1000'
        }]
      }
    })
  },
  {
    capturedAt: '2026-07-03T02:02:00.000Z',
    url: 'https://tzzb.10jqka.com.cn/api/caishen_fund/pc/asset/v1/time_share',
    responseText: JSON.stringify({ ex_data: { data: [{ yk: '88.5' }] } })
  }
];
const mapped = mapTzzbCaptureToReview(raw, { targetDate: '2026-07-03' });

assert.equal(mapped.source, 'tzzb');
assert.match(mapped.date, /^\d{4}-\d{2}-\d{2}$/);
assert.ok(Number(mapped.basic.capital) > 0, 'capital should be derived');
assert.ok(mapped.basic.position.endsWith('成') || mapped.basic.position === '满仓' || mapped.basic.position === '空仓');
assert.match(mapped.basic.pnl, /^[+-]?\d/);
assert.ok(mapped.trades.length >= 1, 'trades should be derived');

const first = mapped.trades[0];
assert.ok(first.time, 'trade time should be present');
assert.ok(first.name, 'trade name should be present');
assert.ok(['买入', '卖出'].includes(first.side), 'trade side should be normalized');
assert.ok(first.price, 'trade price should be present');
assert.ok(first.qty, 'trade quantity should be present');
assert.ok(first.amount, 'trade amount should be present');
assert.equal(first.reason, '');
assert.equal(first.planScore, 1);
assert.equal(first.lineScore, 1);
assert.equal(first.riskScore, 1);
assert.equal(first.timingScore, undefined);
assert.equal(first.sizeScore, undefined);

assert.ok(mapped.importSummary.includes('同花顺'));
assert.ok(mapped.tzzb.holdings.length >= 1, 'holdings should be preserved');
assert.ok(mapped.holdings.length >= 1, 'holdings should be exposed for review planning');
assert.ok(mapped.holdings[0].name, 'holding name should be normalized');
assert.equal(mapped.holdings[0].tomorrowAction, '观察');
assert.equal(mapped.holdings[0].isCore, '待判断');

const mixedDatePayload = [
  {
    capturedAt: '2026-07-03T09:31:00.000Z',
    url: 'https://tzzb.10jqka.com.cn/api/caishen_fund/pc/asset/v1/get_money_history',
    responseText: JSON.stringify({
      ex_data: {
        list: [
          {
            entry_date: '2026-07-02',
            entry_time: '10:01:00',
            name: '昨日股票',
            op_name: '买入',
            entry_price: '10',
            entry_count: '100',
            entry_money: '1000'
          },
          {
            entry_date: '2026-07-03',
            entry_time: '10:02:00',
            name: '今日股票',
            op_name: '卖出',
            entry_price: '20',
            entry_count: '200',
            entry_money: '4000'
          }
        ]
      }
    })
  },
  {
    capturedAt: '2026-07-03T09:32:00.000Z',
    url: 'https://tzzb.10jqka.com.cn/api/caishen_fund/pc/asset/v1/stock_position',
    responseText: JSON.stringify({
      ex_data: {
        money_remain: '1000',
        position: [{ name: '今日持仓', value: '9000', count: '100', price: '90' }]
      }
    })
  }
];
const todayOnly = mapTzzbCaptureToReview(mixedDatePayload, { targetDate: '2026-07-03' });
assert.equal(todayOnly.date, '2026-07-03');
assert.deepEqual(todayOnly.trades.map((trade) => trade.name), ['今日股票']);
assert.equal(todayOnly.trades[0].time, '10:02:00');
assert.equal(todayOnly.basic.capital, '10000.00');
assert.equal(todayOnly.tzzb.holdingCount, 1);
assert.equal(todayOnly.holdings[0].name, '今日持仓');
assert.equal(todayOnly.holdings[0].value, '9000.00');
assert.equal(todayOnly.holdings[0].weight, '90.0%');

const mergeDayWithoutTime = mapTzzbCaptureToReview([
  {
    capturedAt: '2026-07-09T01:30:00.000Z',
    url: 'https://tzzb.10jqka.com.cn/api/caishen_fund/pc/account/v1/merge_day_trading',
    responseText: JSON.stringify({
      ex_data: {
        data: [
          { zqmc: '无时间A', czlx: '买入', cjjg: '10', cjsl: '100', moneychg: '-1000' },
          { zqmc: '无时间B', czlx: '卖出', cjjg: '20', cjsl: '100', moneychg: '2000' }
        ]
      }
    })
  },
  {
    capturedAt: '2026-07-09T01:31:00.000Z',
    url: 'https://tzzb.10jqka.com.cn/api/caishen_fund/pc/asset/v1/stock_position',
    responseText: JSON.stringify({
      ex_data: {
        total_asset: '20000',
        total_value: '1000',
        position: [{ name: '留仓', value: '1000', count: '100', price: '10' }]
      }
    })
  }
], { targetDate: '2026-07-09' });
assert.deepEqual(mergeDayWithoutTime.trades.map((trade) => trade.time), ['', '']);
assert.ok(
  mergeDayWithoutTime.tzzb.importAudit.warnings.some((warning) => warning.includes('真实成交时间')),
  'summary trades without matching details should report missing real timestamps'
);

const enrichedDayTrades = mapTzzbCaptureToReview([
  {
    capturedAt: '2026-07-10T08:00:00.000Z',
    url: 'https://tzzb.10jqka.com.cn/api/caishen_fund/pc/account/v1/merge_day_trading',
    responseText: JSON.stringify({
      ex_data: {
        data: [
          { zqdm: '002384', zqmc: '东山精密', czlx: '买入', cjjg: '252.680', cjsl: '100', moneychg: '-25268' },
          { zqdm: '002038', zqmc: '双鹭药业', czlx: '买入', cjjg: '6.220', cjsl: '400', moneychg: '-2488' },
          { zqdm: '688362', zqmc: '甬矽电子', czlx: '买入', cjjg: '118.010', cjsl: '89', moneychg: '-10502.89' },
          { zqdm: '300489', zqmc: '光智科技', czlx: '卖出', cjjg: '266.600', cjsl: '100', moneychg: '26660' }
        ]
      }
    })
  },
  {
    capturedAt: '2026-07-10T08:00:01.000Z',
    url: 'https://tzzb.10jqka.com.cn/api/caishen_fund/pc/account/v2/get_money_history',
    responseText: JSON.stringify({
      ex_data: {
        list: [
          { code: '204001', entry_date: '2026-07-10', entry_time: '15:02:07', name: 'GC001', op_name: '买入', entry_price: '0.910', entry_count: '170', entry_money: '170000' },
          { code: '002384', entry_date: '2026-07-10', entry_time: '14:11:01', name: '东山精密', op_name: '买入', entry_price: '252.680', entry_count: '100', entry_money: '25268' },
          { code: '002038', entry_date: '2026-07-10', entry_time: '09:49:06', name: '双鹭药业', op_name: '买入', entry_price: '6.220', entry_count: '400', entry_money: '2488' },
          { code: '688362', entry_date: '2026-07-10', entry_time: '09:33:26', name: '甬矽电子', op_name: '买入', entry_price: '118.010', entry_count: '89', entry_money: '10502.89' },
          { code: '300489', entry_date: '2026-07-10', entry_time: '09:30:59', name: '光智科技', op_name: '卖出', entry_price: '266.600', entry_count: '100', entry_money: '26660' }
        ]
      }
    })
  }
], { targetDate: '2026-07-10' });
assert.deepEqual(
  enrichedDayTrades.trades.map((trade) => `${trade.time} ${trade.name}`),
  [
    '09:30:59 光智科技',
    '09:33:26 甬矽电子',
    '09:49:06 双鹭药业',
    '14:11:01 东山精密'
  ],
  'summary-authorized trades should be enriched and sorted by real second-level timestamps'
);
assert.doesNotMatch(
  enrichedDayTrades.trades.map((trade) => trade.name).join(','),
  /GC001/,
  'detail-only cash-management rows should not enter the review trade list'
);

const activeHoldingOnly = mapTzzbCaptureToReview([
  {
    capturedAt: '2026-07-09T10:00:00.000Z',
    url: 'https://tzzb.10jqka.com.cn/api/caishen_fund/pc/asset/v1/stock_position',
    responseText: JSON.stringify({
      ex_data: {
        total_asset: '30000',
        total_value: '11000',
        position: [
          { code: '300489', name: '光智科技', value: '10000', count: '100', price: '100' },
          { code: '000566', name: '海南海药', value: '0.00', count: '0', price: '4.73' }
        ]
      }
    })
  },
  {
    capturedAt: '2026-07-09T10:01:00.000Z',
    url: 'https://tzzb.10jqka.com.cn/api/caishen_fund/pc/asset/v1/stock_position',
    responseText: JSON.stringify({
      ex_data: {
        total_asset: '30000',
        total_value: '11000',
        position: [
          { code: '300489', name: '光智科技', value: '10000', count: '100', price: '100' },
          { code: '733456', name: '宝钛发债', value: '1000', count: '10', price: '100' }
        ]
      }
    })
  }
], { targetDate: '2026-07-09' });
assert.deepEqual(activeHoldingOnly.holdings.map((holding) => holding.name), ['光智科技', '宝钛发债']);
assert.equal(activeHoldingOnly.tzzb.holdingCount, 2);

const latestPositionSnapshotOnly = mapTzzbCaptureToReview([
  {
    capturedAt: '2026-07-10T01:00:00.000Z',
    url: 'https://tzzb.10jqka.com.cn/api/caishen_fund/pc/asset/v1/stock_position',
    responseText: JSON.stringify({
      ex_data: {
        total_asset: '10000',
        total_value: '5000',
        position: [
          { code: '000001', name: '已经清仓', value: '2000', count: '100', price: '20', position_rate: '0.2' },
          { code: '000002', name: '当前持仓', value: '3000', count: '100', price: '30', position_rate: '0.3' }
        ]
      }
    })
  },
  {
    capturedAt: '2026-07-10T02:00:00.000Z',
    url: 'https://tzzb.10jqka.com.cn/api/caishen_fund/pc/asset/v1/stock_position',
    responseText: JSON.stringify({
      ex_data: {
        total_asset: '12000',
        total_value: '3600',
        position: [
          { code: '000001', name: '已经清仓', value: '0', count: '0', price: '20', position_rate: '0' },
          { code: '000002', name: '当前持仓', value: '3600', count: '120', price: '30', position_rate: '0.3' },
          { code: '888880', name: '新标准券', value: '8000', count: '8', price: '1000', position_rate: '0.8' }
        ]
      }
    })
  }
], { targetDate: '2026-07-10' });
assert.deepEqual(
  latestPositionSnapshotOnly.holdings.map((holding) => `${holding.code} ${holding.name} ${holding.qty} ${holding.value} ${holding.weight}`),
  ['000002 当前持仓 120 3600.00 30.0%'],
  'only active reviewable holdings from the latest position snapshot should be kept'
);
assert.equal(latestPositionSnapshotOnly.tzzb.rawHoldings.length, 3, 'raw holdings should come from the latest snapshot only');
assert.equal(latestPositionSnapshotOnly.basic.capital, '12000.00');
assert.equal(latestPositionSnapshotOnly.basic.position, '3成');

const latestDayTradingSnapshotOnly = mapTzzbCaptureToReview([
  {
    capturedAt: '2026-07-10T01:10:00.000Z',
    url: 'https://tzzb.10jqka.com.cn/api/caishen_fund/pc/account/v1/merge_day_trading',
    responseText: JSON.stringify({
      ex_data: { data: [
        { zqmc: '旧成交', czlx: '买入', cjjg: '10', cjsl: '100', moneychg: '-1000' },
        { zqmc: '保留成交', czlx: '买入', cjjg: '20', cjsl: '100', moneychg: '-2000' }
      ] }
    })
  },
  {
    capturedAt: '2026-07-10T02:10:00.000Z',
    url: 'https://tzzb.10jqka.com.cn/api/caishen_fund/pc/account/v1/merge_day_trading',
    responseText: JSON.stringify({
      ex_data: { data: [
        { zqmc: '保留成交', czlx: '买入', cjjg: '20', cjsl: '100', moneychg: '-2000' },
        { zqmc: '新增成交', czlx: '卖出', cjjg: '30', cjsl: '100', moneychg: '3000' }
      ] }
    })
  }
], { targetDate: '2026-07-10' });
assert.deepEqual(
  latestDayTradingSnapshotOnly.trades.map((trade) => trade.name),
  ['保留成交', '新增成交'],
  'merge_day_trading should use the latest full-day snapshot instead of accumulating repeated snapshots'
);

const currentEasternRecords = [
  {
    capturedAt: '2026-07-09T01:31:00.000Z',
    url: 'https://tzzb.10jqka.com.cn/api/caishen_fund/pc/asset/v1/stock_position',
    responseText: JSON.stringify({
      ex_data: {
        total_asset: '30000',
        total_value: '11000',
        position: [
          { code: '300489', name: '光智科技', value: '10604', count: '100', price: '106.04', position_rate: '0.964' },
          { code: '733456', name: '宝钛发债', value: '396', count: '10', price: '39.6', position_rate: '0.036' },
          { code: '000566', name: '海南海药', value: '0', count: '0', price: '4.73', position_rate: '0' }
        ]
      }
    })
  },
  {
    capturedAt: '2026-07-09T01:32:00.000Z',
    url: 'https://tzzb.10jqka.com.cn/api/caishen_fund/pc/asset/v1/get_money_history',
    responseText: JSON.stringify({
      ex_data: {
        list: [
          { entry_date: '2026-07-09', entry_time: '10:06:00', name: '光智科技', op_name: '卖出', entry_price: '101', entry_count: '50', entry_money: '5050' },
          { entry_date: '2026-07-09', entry_time: '09:33:00', name: '海南海药', op_name: '卖出', entry_price: '4.72', entry_count: '100', entry_money: '472' },
          { entry_date: '2026-07-09', entry_time: '09:37:00', name: '光智科技', op_name: '买入', entry_price: '100', entry_count: '100', entry_money: '10000' },
          { entry_date: '2026-07-09', entry_time: '09:33:00', name: '海南海药', op_name: '卖出', entry_price: '4.73', entry_count: '200', entry_money: '946' }
        ]
      }
    })
  }
];
const currentEasternMapped = mapTzzbCaptureToReview(currentEasternRecords, { targetDate: '2026-07-09' });
assert.deepEqual(
  currentEasternMapped.trades.map((trade) => `${trade.time} ${trade.name} ${trade.side}`),
  [
    '09:33:00 海南海药 卖出',
    '09:33:00 海南海药 卖出',
    '09:37:00 光智科技 买入',
    '10:06:00 光智科技 卖出'
  ],
  'current-day trades should be sorted from earliest to latest'
);
assert.deepEqual(
  currentEasternMapped.holdings.map((holding) => `${holding.name} ${holding.weight}`),
  ['光智科技 96.4%', '宝钛发债 3.6%'],
  'holding weight should use investment-ledger position_rate when available and exclude cleared positions'
);
assert.doesNotMatch(
  currentEasternMapped.holdings.map((holding) => holding.name).join(','),
  /海南海药/,
  'cleared positions with count=0 should not enter holding review'
);

const stockCardOnly = mapTzzbCaptureToReview([
  {
    capturedAt: '2026-07-03T10:00:00.000Z',
    url: 'https://tzzb.10jqka.com.cn/api/caishen_fund/pc/asset/v1/stock_card',
    responseText: JSON.stringify({
      ex_data: {
        asset: '25000.00',
        now_profit: '-120.5',
        position: [
          { name: '自动持仓', value: '15000', count: '300', price: '50' }
        ]
      }
    })
  }
], { targetDate: '2026-07-03' });
assert.equal(stockCardOnly.basic.capital, '25000.00');
assert.equal(stockCardOnly.basic.position, '6成');
assert.equal(stockCardOnly.basic.pnl, '-120.50');
assert.equal(stockCardOnly.tzzb.holdingCount, 1);

const stockPositionShouldWin = mapTzzbCaptureToReview([
  {
    capturedAt: '2026-07-03T10:00:00.000Z',
    url: 'https://tzzb.10jqka.com.cn/api/caishen_fund/pc/asset/v1/stock_card',
    responseText: JSON.stringify({
      ex_data: {
        asset: '999999.00',
        position: [
          { name: '卡片持仓', value: '1000', count: '100', price: '10' }
        ]
      }
    })
  },
  {
    capturedAt: '2026-07-03T10:01:00.000Z',
    url: 'https://tzzb.10jqka.com.cn/api/caishen_fund/pc/asset/v1/stock_position',
    responseText: JSON.stringify({
      ex_data: {
        money_remain: '5000',
        total_asset: '25000.00',
        total_value: '20000.00',
        position: [
          { name: '明确持仓', value: '20000', count: '200', price: '100' }
        ]
      }
    })
  }
], { targetDate: '2026-07-03' });
assert.equal(stockPositionShouldWin.basic.capital, '25000.00');
assert.equal(stockPositionShouldWin.basic.position, '8成');
assert.equal(stockPositionShouldWin.tzzb.holdingCount, 1);
assert.equal(stockPositionShouldWin.tzzb.importAudit.capitalSource, 'stock_position.total_asset');
assert.equal(stockPositionShouldWin.tzzb.importAudit.holdingSource, 'stock_position.position');
assert.equal(stockPositionShouldWin.tzzb.importAudit.trustLevel, 'warning');
assert.ok(stockPositionShouldWin.tzzb.importAudit.warnings.some((warning) => warning.includes('交易记录')));

console.log('PASS tzzb review mapper');
