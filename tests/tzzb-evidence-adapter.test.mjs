import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeCaptureEvidence } from '../tools/tzzb-evidence-adapter.mjs';

const adapterSource = await readFile(new URL('../tools/tzzb-evidence-adapter.mjs', import.meta.url), 'utf8');
assert.doesNotMatch(adapterSource, /from ['"]node:/, 'the Adapter must run in a browser or Worker');

const capturedAt = '2026-07-14T16:09:44.269Z';
const accountList = {
  capturedAt,
  url: 'https://tzzb.10jqka.com.cn/caishen_fund/pc/account/v1/account_list',
  requestPostData: 'userid=user-secret&token=do-not-keep',
  responseText: JSON.stringify({
    ex_data: {
      common: [
        { access_upload: '1', merge_flag: '1', manual_id: 'manual-A', fund_key: 'fund-A', brokername: 'sensitive-broker' },
        { access_upload: '0', manual_id: 'disabled-upload', fund_key: 'disabled-upload-fund' },
        { merge_flag: '0', manual_id: 'disabled-merge', fund_key: 'disabled-merge-fund' },
        { access_upload: 'future-value', manual_id: 'manual-unknown', fund_key: 'fund-unknown' }
      ],
      future_account_type: [
        { access_upload: '1', manual_id: 'future-type', fund_key: 'future-fund' },
        { access_upload: '1', label: 'not-an-account' }
      ]
    },
    cookie: 'do-not-keep'
  })
};
const accountRequest = 'userid=user-secret&user_id=user-secret&manual_id=manual-A&fund_key=fund-A&token=do-not-keep';
const rawPayload = {
  source: 'edge-extension',
  pageUrl: 'https://example.invalid/private-account',
  records: [
    accountList,
    {
      capturedAt,
      url: 'https://tzzb.10jqka.com.cn/caishen_fund/stock_common/v1/last_trading_day',
      requestPostData: 'userid=user-secret&token=do-not-keep',
      responseText: JSON.stringify({
        ex_data: {
          is_trading_day: 1,
          last_trading_day: '2026-07-15',
          prev_trading_day: '2026-07-14',
          before_prev_trading_day: '2026-07-13',
          system_time: 1784045384264,
          user_name: 'do-not-keep'
        }
      })
    },
    {
      capturedAt,
      url: 'https://tzzb.10jqka.com.cn/caishen_fund/pc/asset/v1/stock_position',
      requestPostData: accountRequest,
      responseText: JSON.stringify({
        ex_data: {
          total_asset: '282113.7500',
          total_liability: '0',
          total_value: '170000.0000',
          position_rate: '0.6026',
          money_remain: '112113.7500',
          position: [{ code: '204001', name: 'GC001', count: '170', price: '100', value: '170000', position_rate: '0.6026' }],
          password: 'do-not-keep'
        }
      })
    },
    {
      capturedAt,
      url: 'https://tzzb.10jqka.com.cn/caishen_fund/pc/asset/v1/get_money_history',
      requestPostData: `${accountRequest}&start_date=20260714&end_date=20260714&page=1&count=200&cookie=do-not-keep`,
      responseText: JSON.stringify({
        ex_data: {
          page: 1,
          max_page: 1,
          total: 1,
          list: [{
            code: '000001',
            name: '样本股票',
            op_name: '买入',
            entry_date: '2026-07-14',
            entry_time: '10:01:02',
            entry_price: '10.50',
            entry_count: '100',
            entry_money: '1050',
            business_no: 'sequence-001',
            token: 'do-not-keep'
          }]
        }
      })
    },
    {
      capturedAt,
      url: 'https://tzzb.10jqka.com.cn/caishen_fund/pc/account/v1/merge_day_trading',
      requestPostData: accountRequest,
      responseText: JSON.stringify({
        ex_data: {
          data: [{
            zqdm: '000001',
            zqmc: '样本股票',
            czlx: '买入',
            cjjg: '10.50',
            cjsl: '100',
            moneychg: '-1050',
            entrust_no: 'sequence-001'
          }]
        }
      })
    },
    {
      capturedAt,
      url: 'https://tzzb.10jqka.com.cn/caishen_fund/pc/asset/v1/asset_trend',
      requestPostData: accountRequest,
      responseText: JSON.stringify({
        ex_data: {
          month_profit: [{ date: '20260714', asset: '282113.75', fundIn: '0', fundOut: '0', profit: '-13829.59' }],
          year_profit: [{ date: '20260714', asset: '282113.75', fundIn: '0', fundOut: '0', profit: '-13829.59' }],
          total_asset: [{ date: '20260714', asset: '282113.75', fundIn: '0', fundOut: '0', profit: '-13829.59' }]
        }
      })
    },
    {
      capturedAt,
      url: 'https://tzzb.10jqka.com.cn/caishen_fund/pc/asset/v1/time_share',
      requestPostData: accountRequest,
      responseText: JSON.stringify({ ex_data: { data: [{ time: 1784098800000, yk: '2453.59', token: 'do-not-keep' }] } })
    },
    {
      capturedAt,
      url: 'https://tzzb.10jqka.com.cn/caishen_fund/pc/asset/v1/stock_card',
      requestPostData: accountRequest,
      responseText: JSON.stringify({ ex_data: { asset: '999999.00', now_profit: '2453.59', password: 'do-not-keep' } })
    },
    {
      capturedAt,
      url: 'https://tzzb.10jqka.com.cn/caishen_fund/pc/quote/v1/pass_quotes',
      requestPostData: accountRequest,
      responseText: JSON.stringify({ token: 'do-not-keep', quotes: ['not-needed'] })
    }
  ]
};

rawPayload.records.push(
  {
    capturedAt,
    status: 503,
    url: 'https://tzzb.10jqka.com.cn/caishen_fund/pc/asset/v1/get_money_history',
    requestPostData: `${accountRequest}&start_date=20260714&end_date=20260714&page=1&count=200`,
    responseText: JSON.stringify({ ex_data: { page: 1, max_page: 1, total: 0, list: [] } })
  },
  {
    capturedAt,
    status: 200,
    url: 'https://tzzb.10jqka.com.cn/caishen_fund/pc/asset/v1/get_money_history',
    requestPostData: `${accountRequest}&start_date=20260714&end_date=20260714&page=1&count=200`,
    responseText: '{invalid-json'
  },
  {
    capturedAt,
    status: 200,
    url: 'https://tzzb.10jqka.com.cn/caishen_fund/pc/asset/v1/get_money_history',
    requestPostData: `${accountRequest}&start_date=20260714&end_date=20260714&page=1&count=200`,
    responseText: JSON.stringify({ ex_data: { page: 1, max_page: 1, list: [] } })
  }
);
for (const record of rawPayload.records) record.status ??= 200;

const evidence = await normalizeCaptureEvidence(rawPayload);
const expectedAccountRef = '05a40b1bf432f51d2d6f1cc512ed1dae5596aca598b65ef2272ee1588995bc81';
const expectedUnknownFlagAccountRef = 'b9cf30b6742522676cb5c9f79f6fce24e528b426568b2865acaf0dd43b9bf914';
const expectedFutureTypeAccountRef = '8dad2bd500625e8ec5e7a963b92531acf29fa6843efdae1c1303d5d936060a81';
const expectedMergeFlagAccountRef = 'cf866b9b64a3e77c5808686a52a372d5f0dddadf11d6fe58a0b3bbcaf89594d1';
const expectedUnresolvedAccountRef = '24554cb9045906725f67b5f9e128cc55545aa2c9a113519685e1e2d3e42e136c';

assert.deepEqual(
  evidence.activeAccountRefs,
  [
    expectedAccountRef,
    expectedUnresolvedAccountRef,
    expectedFutureTypeAccountRef,
    expectedUnknownFlagAccountRef,
    expectedMergeFlagAccountRef
  ],
  'explicitly disabled upload accounts are excluded; merge_flag and unresolved active types remain fail-closed'
);
assert.deepEqual(
  evidence.records.map((record) => record.endpoint),
  ['last_trading_day', 'stock_position', 'get_money_history', 'merge_day_trading', 'asset_trend', 'time_share', 'stock_card'],
  'only evidence needed by the DailyReview Module should cross the Adapter seam'
);
assert.deepEqual(
  evidence.records.map((record) => Object.keys(record)),
  evidence.records.map(() => ['endpoint', 'capturedAt', 'accountRef', 'request', 'payload'])
);

const position = evidence.records.find((record) => record.endpoint === 'stock_position');
assert.equal(position.accountRef, expectedAccountRef);
assert.deepEqual(position.request, {});
assert.deepEqual(position.payload, {
  totalAsset: '282113.7500',
  totalLiability: '0',
  totalValue: '170000.0000',
  positionRate: '0.6026',
  cash: '112113.7500',
  positions: [{ code: '204001', name: 'GC001', quantity: '170', price: '100', value: '170000' }]
});

const history = evidence.records.find((record) => record.endpoint === 'get_money_history');
assert.equal(history.accountRef, expectedAccountRef);
assert.deepEqual(history.request, {
  startDate: '2026-07-14',
  endDate: '2026-07-14',
  page: 1,
  count: 200
});
assert.deepEqual(history.payload, {
  page: 1,
  maxPage: 1,
  total: 1,
  trades: [{
    code: '000001',
    name: '样本股票',
    side: '买入',
    date: '2026-07-14',
    time: '10:01:02',
    price: '10.50',
    quantity: '100',
    amount: '1050',
    fee: '0',
    sequenceId: 'sequence-001'
  }]
});

assert.deepEqual(evidence.records.find((record) => record.endpoint === 'merge_day_trading').payload, {
  trades: [{
    code: '000001',
    name: '样本股票',
    side: '买入',
    date: '',
    time: '',
    price: '10.50',
    quantity: '100',
    amount: '-1050',
    fee: '0',
    sequenceId: 'sequence-001'
  }]
});

const calendar = evidence.records.find((record) => record.endpoint === 'last_trading_day');
assert.deepEqual(calendar.payload, {
  isTradingDay: true,
  lastTradingDay: '2026-07-15',
  previousTradingDay: '2026-07-14',
  beforePreviousTradingDay: '2026-07-13',
  systemTime: 1784045384264
});

const trend = evidence.records.find((record) => record.endpoint === 'asset_trend');
const expectedTrendRow = { date: '2026-07-14', asset: '282113.75', fundIn: '0', fundOut: '0', profit: '-13829.59' };
assert.deepEqual(trend.payload, {
  monthProfit: [expectedTrendRow],
  yearProfit: [expectedTrendRow],
  totalAssetHistory: [expectedTrendRow]
});
assert.deepEqual(evidence.records.find((record) => record.endpoint === 'time_share').payload, {
  displayPnl: '2453.59'
});
assert.deepEqual(evidence.records.find((record) => record.endpoint === 'stock_card').payload, {
  displayAsset: '999999.00',
  displayPnl: '2453.59'
});
assert.equal(
  evidence.records.filter((record) => record.endpoint === 'get_money_history').length,
  1,
  'non-2xx, malformed JSON, and incomplete history page shapes must be skipped'
);

const rzrqEvidence = await normalizeCaptureEvidence({
  records: [
    {
      status: 200,
      capturedAt,
      url: 'https://tzzb.10jqka.com.cn/caishen_fund/pc/account/v1/account_list',
      responseText: JSON.stringify({
        ex_data: {
          rzrq: [{ access_upload: '1', manual_id: 'margin-manual', fund_key: 'margin-fund' }]
        }
      })
    },
    {
      status: 200,
      capturedAt,
      url: 'https://tzzb.10jqka.com.cn/caishen_fund/pc/asset/v1/stock_position',
      requestPostData: 'manual_id=margin-manual&rzrq_fund_key=margin-fund',
      responseText: JSON.stringify({
        ex_data: {
          total_asset: '10000', total_value: '0', position_rate: '0', money_remain: '10000', position: []
        }
      })
    }
  ]
});
assert.equal(rzrqEvidence.activeAccountRefs.length, 1);
assert.equal(rzrqEvidence.records[0].accountRef, rzrqEvidence.activeAccountRefs[0]);
assert.equal(rzrqEvidence.records[0].payload.totalLiability, '', 'unknown liability must not become zero');

const failedOnlyEvidence = await normalizeCaptureEvidence({
  records: [
    {
      status: 200,
      capturedAt,
      url: 'https://tzzb.10jqka.com.cn/caishen_fund/pc/account/v1/account_list',
      responseText: JSON.stringify({ ex_data: { common: [{ access_upload: '1', fund_key: 'failed-fund' }] } })
    },
    {
      status: 500,
      capturedAt,
      url: 'https://tzzb.10jqka.com.cn/caishen_fund/pc/asset/v1/get_money_history',
      requestPostData: 'fund_key=failed-fund&start_date=20260714&end_date=20260714&page=1&count=200',
      responseText: JSON.stringify({ ex_data: { page: 1, max_page: 1, total: 0, list: [] } })
    }
  ]
});
assert.equal(failedOnlyEvidence.activeAccountRefs.length, 1, 'the active account remains so missing evidence fails closed');
assert.deepEqual(failedOnlyEvidence.records, [], 'a failed empty response is never normalized as a valid zero-trade page');

const serialized = JSON.stringify(evidence);
for (const secret of [
  'user-secret', 'manual-A', 'fund-A', 'disabled-upload', 'disabled-merge',
  'manual-unknown', 'fund-unknown', 'future-type', 'future-fund',
  'do-not-keep', 'sensitive-broker', 'private-account'
]) {
  assert.doesNotMatch(serialized, new RegExp(secret), `normalized evidence must not retain ${secret}`);
}

console.log('PASS tzzb evidence adapter');
