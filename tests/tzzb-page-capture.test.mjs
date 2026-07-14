import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../tools/tzzb-edge-extension/page-capture.js', import.meta.url), 'utf8');
const accountListUrl = 'https://tzzb.10jqka.com.cn/caishen_httpserver/tzzb/caishen_fund/pc/account/v1/account_list';
const summaryUrl = 'https://tzzb.10jqka.com.cn/caishen_httpserver/tzzb/caishen_fund/pc/account/v1/merge_day_trading';
const calendarUrl = 'https://tzzb.10jqka.com.cn/caishen_httpserver/tzzb/caishen_fund/stock_common/v1/last_trading_day';
const stockPositionUrl = 'https://tzzb.10jqka.com.cn/caishen_httpserver/tzzb/caishen_fund/pc/asset/v1/stock_position';
const assetTrendUrl = 'https://tzzb.10jqka.com.cn/caishen_httpserver/tzzb/caishen_fund/pc/asset/v1/asset_trend';
const historyUrl = 'https://tzzb.10jqka.com.cn/caishen_httpserver/tzzb/caishen_fund/pc/account/v2/get_money_history';
const detailPath = '/pc/account/v2/get_money_history';
const fetchCalls = [];
const emitted = [];

function response(url, payload) {
  const text = JSON.stringify(payload);
  return {
    ok: true,
    status: 200,
    url,
    clone() { return response(url, payload); },
    async text() { return text; }
  };
}

async function fetchMock(input, options = {}) {
  const url = String(input && input.url ? input.url : input);
  fetchCalls.push({ url, options });
  if (url.includes('merge_day_trading')) {
    return response(url, { ex_data: { data: [{ zqmc: '样本股票' }] } });
  }
  if (url.includes('last_trading_day')) {
    return response(url, {
      ex_data: {
        system_time: new NativeDate('2026-07-15T00:09:00+08:00').getTime(),
        is_trading_day: 1,
        last_trading_day: '2026-07-15',
        prev_trading_day: '2026-07-14'
      }
    });
  }
  if (url.includes(detailPath)) {
    const page = Number(new URLSearchParams(String(options.body || '')).get('page'));
    return response(url, {
      ex_data: {
        page,
        max_page: 2,
        list: [{
          entry_date: '2026-07-13',
          entry_time: page === 1 ? '09:49:38' : '14:11:01'
        }]
      }
    });
  }
  throw new Error(`Unexpected fetch ${url}`);
}

class MockXMLHttpRequest {
  open() {}
  send() {}
  addEventListener() {}
}

const NativeDate = Date;
const fixedNow = new NativeDate('2026-07-15T00:09:00+08:00').getTime();
class FixedDate extends NativeDate {
  constructor(...args) {
    super(...(args.length ? args : [fixedNow]));
  }

  static now() {
    return fixedNow;
  }
}

const window = {
  fetch: fetchMock,
  XMLHttpRequest: MockXMLHttpRequest,
  postMessage(message) {
    emitted.push(message);
  }
};
const context = vm.createContext({
  window,
  location: {
    href: 'https://tzzb.10jqka.com.cn/pc/index.html#/myAccount/a/demo',
    origin: 'https://tzzb.10jqka.com.cn'
  },
  URL,
  URLSearchParams,
  Date: FixedDate,
  setTimeout,
  clearTimeout,
  console: { info() {}, warn() {} }
});

vm.runInContext(source, context, { filename: 'page-capture.js' });

async function flushAsyncWork(iterations = 10) {
  for (let index = 0; index < iterations; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const summaryBody = new URLSearchParams({
  terminal: '1',
  version: '0.0.0',
  userid: 'test-user',
  user_id: 'test-user',
  manual_id: '',
  fund_key: 'test-fund',
  rzrq_fund_key: ''
}).toString();
await window.fetch(calendarUrl, {
  method: 'POST',
  body: new URLSearchParams({ terminal: '1', user_id: 'test-user' }).toString()
});
await window.fetch(summaryUrl, { method: 'POST', body: summaryBody });
await flushAsyncWork();

const detailCalls = fetchCalls.filter((call) => call.url.includes(detailPath));
assert.equal(detailCalls.length, 2, 'capturing a day-trade summary should automatically read every trade-detail page');
assert.deepEqual(
  detailCalls.map((call) => Number(new URLSearchParams(String(call.options.body)).get('page'))),
  [1, 2]
);
for (const call of detailCalls) {
  const body = new URLSearchParams(String(call.options.body));
  assert.equal(body.get('start_date'), '20260714', '00:09 Shanghai should review the previous trading day');
  assert.equal(body.get('end_date'), '20260714', '00:09 Shanghai should review the previous trading day');
  assert.equal(body.get('user_id'), 'test-user');
  assert.equal(body.get('fund_key'), 'test-fund');
  assert.equal(body.get('count'), '200');
  assert.equal(call.options.credentials, 'include');
}

const detailRecords = emitted
  .map((message) => message.record)
  .filter((record) => record && record.url.includes(detailPath));
assert.equal(detailRecords.length, 2, 'every detail page should be forwarded to the extension bridge');
assert.deepEqual(
  detailRecords.map((record) => JSON.parse(record.responseText).ex_data.list[0].entry_time),
  ['09:49:38', '14:11:01'],
  'detail responses should continue through the normal extension capture stream'
);

await window.fetch(summaryUrl, { method: 'POST', body: summaryBody });
await flushAsyncWork(5);
assert.equal(
  fetchCalls.filter((call) => call.url.includes(detailPath)).length,
  2,
  'repeated summary responses for the same account and day should not start duplicate detail reads'
);

const calendarFirstCalls = [];
async function calendarFirstFetch(input, options = {}) {
  const url = String(input && input.url ? input.url : input);
  calendarFirstCalls.push({ url, options });
  if (url.includes('account_list')) {
    return response(url, {
      ex_data: {
        common: [
          { access_upload: '1', manual_id: '', fund_key: 'primary-fund' },
          { access_upload: '1', manual_id: 'manual-two', fund_key: 'secondary-fund' },
          { access_upload: '0', manual_id: '', fund_key: 'disabled-fund' }
        ],
        rzrq: [{ access_upload: '1', manual_id: 'margin-manual', fund_key: 'margin-fund' }],
        fund: [{ access_upload: '1', fundid: 'managed-fund', custid: 'managed-customer' }],
        manual: [
          { access_upload: '1', manual_id: 'manual-only' },
          { access_upload: '1', account_id: 'unsupported-manual-shape' }
        ],
        wealth: [{ access_upload: '1', fund_key: 'wealth-fund' }],
        metadata: [{ label: 'not-an-account' }]
      }
    });
  }
  if (url.includes('last_trading_day')) {
    return response(url, {
      ex_data: {
        system_time: fixedNow,
        is_trading_day: 1,
        last_trading_day: '2026-07-15',
        prev_trading_day: '2026-07-14'
      }
    });
  }
  if (url.includes('get_money_history')) {
    const page = Number(new URLSearchParams(String(options.body || '')).get('page')) || 1;
    return response(url, { ex_data: { page, max_page: 2, list: [] } });
  }
  if (url.includes('stock_position')) return response(url, { ex_data: { position: [] } });
  if (url.includes('asset_trend')) return response(url, { ex_data: { total_asset: [] } });
  if (url.includes('merge_day_trading')) return response(url, { ex_data: { data: [] } });
  throw new Error(`Unexpected calendar-first fetch ${url}`);
}

const calendarFirstWindow = {
  fetch: calendarFirstFetch,
  XMLHttpRequest: MockXMLHttpRequest,
  postMessage() {}
};
const calendarFirstWarnings = [];
vm.runInContext(source, vm.createContext({
  window: calendarFirstWindow,
  location: {
    href: 'https://tzzb.10jqka.com.cn/pc/index.html#/myAccount/a/demo',
    origin: 'https://tzzb.10jqka.com.cn'
  },
  URL,
  URLSearchParams,
  Date: FixedDate,
  setTimeout,
  clearTimeout,
  console: { info() {}, warn(message) { calendarFirstWarnings.push(String(message)); } }
}), { filename: 'page-capture-calendar-first.js' });

await calendarFirstWindow.fetch(accountListUrl, {
  method: 'POST',
  body: new URLSearchParams({ terminal: '1', version: '0.0.0', user_id: 'test-user' }).toString()
});
await flushAsyncWork();
assert.deepEqual(
  calendarFirstCalls.map((call) => call.url.split('/').pop()),
  ['account_list', 'last_trading_day'],
  'capturing account_list should fetch the trading calendar before any account backfill'
);
assert.ok(
  calendarFirstWarnings.some((warning) => warning.includes('manual[1]')),
  'an active account with an unknown parameter shape should be surfaced instead of silently treated as verified'
);

const primaryTemplate = new URLSearchParams({
  terminal: '1',
  version: '0.0.0',
  userid: 'test-user',
  user_id: 'test-user',
  manual_id: '',
  fund_key: 'primary-fund',
  rzrq_fund_key: '',
  fundid: '',
  custid: ''
});
await calendarFirstWindow.fetch(stockPositionUrl, {
  method: 'POST',
  body: new URLSearchParams({ ...Object.fromEntries(primaryTemplate), is_merge: '0' }).toString()
});
await calendarFirstWindow.fetch(assetTrendUrl, {
  method: 'POST',
  body: primaryTemplate.toString()
});
await calendarFirstWindow.fetch(summaryUrl, {
  method: 'POST',
  body: primaryTemplate.toString()
});
await calendarFirstWindow.fetch(historyUrl, {
  method: 'POST',
  body: new URLSearchParams({
    ...Object.fromEntries(primaryTemplate),
    start_date: '20260715',
    end_date: '20260715',
    page: '1',
    count: '200'
  }).toString()
});
await flushAsyncWork(40);

function accountIdentity(call) {
  const body = new URLSearchParams(String(call.options.body || ''));
  return [
    body.get('manual_id') || '',
    body.get('fund_key') || '',
    body.get('rzrq_fund_key') || '',
    body.get('fundid') || '',
    body.get('custid') || ''
  ].join('|');
}

const expectedAccounts = [
  '|primary-fund|||',
  'manual-two|secondary-fund|||',
  'margin-manual||margin-fund||',
  '|||managed-fund|managed-customer',
  'manual-only||||',
  '|wealth-fund|||'
];
for (const endpoint of ['stock_position', 'asset_trend', 'merge_day_trading', 'get_money_history']) {
  const calls = calendarFirstCalls.filter((call) => call.url.includes(`/${endpoint}`));
  const identities = new Set(calls.map(accountIdentity));
  for (const identity of expectedAccounts) {
    assert.ok(identities.has(identity), `${endpoint} should be backfilled for active account ${identity}`);
  }
  assert.ok(!identities.has('|disabled-fund|||'), `${endpoint} should skip explicitly inactive accounts`);
}

const historyCalls = calendarFirstCalls.filter((call) => call.url.includes('/get_money_history'));
for (const identity of expectedAccounts) {
  const completePages = historyCalls
    .filter((call) => accountIdentity(call) === identity)
    .map((call) => new URLSearchParams(String(call.options.body || '')))
    .filter((body) => body.get('start_date') === '20260714' && body.get('end_date') === '20260714');
  assert.deepEqual(
    [...new Set(completePages.map((body) => Number(body.get('page'))))],
    [1, 2],
    `history backfill should preserve every page for ${identity}`
  );
  assert.ok(completePages.every((body) => body.get('count') === '200'), 'history completeness records should preserve count');
}

const beforeRepeat = calendarFirstCalls.length;
await calendarFirstWindow.fetch(stockPositionUrl, { method: 'POST', body: primaryTemplate.toString() });
await calendarFirstWindow.fetch(assetTrendUrl, { method: 'POST', body: primaryTemplate.toString() });
await calendarFirstWindow.fetch(summaryUrl, { method: 'POST', body: primaryTemplate.toString() });
await calendarFirstWindow.fetch(historyUrl, {
  method: 'POST',
  body: new URLSearchParams({
    ...Object.fromEntries(primaryTemplate),
    start_date: '20260715',
    end_date: '20260715',
    page: '1',
    count: '200'
  }).toString()
});
await flushAsyncWork(30);
assert.equal(
  calendarFirstCalls.length - beforeRepeat,
  4,
  'repeated observed templates should not trigger duplicate account backfills inside the throttle window'
);

const afterCutoffNow = new NativeDate('2026-07-15T15:40:00+08:00').getTime();
class AfterCutoffDate extends NativeDate {
  constructor(...args) {
    super(...(args.length ? args : [afterCutoffNow]));
  }

  static now() {
    return afterCutoffNow;
  }
}

const afterCutoffCalls = [];
async function afterCutoffFetch(input, options = {}) {
  const url = String(input && input.url ? input.url : input);
  afterCutoffCalls.push({ url, options });
  if (url.includes('last_trading_day')) {
    return response(url, {
      ex_data: {
        system_time: afterCutoffNow,
        is_trading_day: 1,
        last_trading_day: '2026-07-15',
        prev_trading_day: '2026-07-14'
      }
    });
  }
  if (url.includes('merge_day_trading')) return response(url, { ex_data: { data: [] } });
  if (url.includes('get_money_history')) return response(url, { ex_data: { page: 1, max_page: 1, list: [] } });
  throw new Error(`Unexpected after-cutoff fetch ${url}`);
}

const afterCutoffWindow = {
  fetch: afterCutoffFetch,
  XMLHttpRequest: MockXMLHttpRequest,
  postMessage() {}
};
const previousTimezone = process.env.TZ;
process.env.TZ = 'Pacific/Honolulu';
try {
  vm.runInContext(source, vm.createContext({
    window: afterCutoffWindow,
    location: {
      href: 'https://tzzb.10jqka.com.cn/pc/index.html#/myAccount/a/demo',
      origin: 'https://tzzb.10jqka.com.cn'
    },
    URL,
    URLSearchParams,
    Date: AfterCutoffDate,
    setTimeout,
    clearTimeout,
    console: { info() {}, warn() {} }
  }), { filename: 'page-capture-fixed-shanghai-time.js' });
  await afterCutoffWindow.fetch(calendarUrl, { method: 'POST', body: 'user_id=test-user' });
  await afterCutoffWindow.fetch(summaryUrl, { method: 'POST', body: summaryBody });
  await flushAsyncWork();
} finally {
  process.env.TZ = previousTimezone;
}
const afterCutoffHistory = afterCutoffCalls.find((call) => call.url.includes('/get_money_history'));
assert.ok(afterCutoffHistory, 'after-cutoff summary should trigger history capture');
assert.equal(
  new URLSearchParams(String(afterCutoffHistory.options.body)).get('start_date'),
  '20260715',
  'review-date cutoff must stay on Shanghai time even when the runtime timezone is Honolulu'
);

const missingCalendarCalls = [];
async function missingCalendarFetch(input, options = {}) {
  const url = String(input && input.url ? input.url : input);
  missingCalendarCalls.push({ url, options });
  if (url.includes('merge_day_trading')) return response(url, { ex_data: { data: [] } });
  throw new Error(`Calendar-free capture must not request ${url}`);
}
const missingCalendarWindow = {
  fetch: missingCalendarFetch,
  XMLHttpRequest: MockXMLHttpRequest,
  postMessage() {}
};
vm.runInContext(source, vm.createContext({
  window: missingCalendarWindow,
  location: {
    href: 'https://tzzb.10jqka.com.cn/pc/index.html#/myAccount/a/demo',
    origin: 'https://tzzb.10jqka.com.cn'
  },
  URL,
  URLSearchParams,
  Date: AfterCutoffDate,
  setTimeout,
  clearTimeout,
  console: { info() {}, warn() {} }
}), { filename: 'page-capture-missing-calendar.js' });
await missingCalendarWindow.fetch(summaryUrl, { method: 'POST', body: summaryBody });
await flushAsyncWork();
assert.equal(
  missingCalendarCalls.length,
  1,
  'without a verified trading calendar the extension must not guess a natural-day history date'
);

let movingNow = new NativeDate('2026-07-15T15:34:00+08:00').getTime();
class MovingDate extends NativeDate {
  constructor(...args) {
    super(...(args.length ? args : [movingNow]));
  }

  static now() {
    return movingNow;
  }
}
const calendarRefreshCalls = [];
async function calendarRefreshFetch(input, options = {}) {
  const url = String(input && input.url ? input.url : input);
  calendarRefreshCalls.push({ url, options });
  if (url.includes('account_list')) {
    return response(url, {
      ex_data: {
        common: [{ access_upload: '1', manual_id: '', fund_key: 'refresh-fund' }],
        rzrq: []
      }
    });
  }
  if (url.includes('last_trading_day')) {
    return response(url, {
      ex_data: {
        system_time: movingNow,
        is_trading_day: 1,
        last_trading_day: '2026-07-15',
        prev_trading_day: '2026-07-14'
      }
    });
  }
  if (url.includes('merge_day_trading')) return response(url, { ex_data: { data: [] } });
  if (url.includes('get_money_history')) return response(url, { ex_data: { page: 1, max_page: 1, list: [] } });
  throw new Error(`Unexpected calendar-refresh fetch ${url}`);
}
const calendarRefreshWindow = {
  fetch: calendarRefreshFetch,
  XMLHttpRequest: MockXMLHttpRequest,
  postMessage() {}
};
vm.runInContext(source, vm.createContext({
  window: calendarRefreshWindow,
  location: {
    href: 'https://tzzb.10jqka.com.cn/pc/index.html#/myAccount/a/demo',
    origin: 'https://tzzb.10jqka.com.cn'
  },
  URL,
  URLSearchParams,
  Date: MovingDate,
  setTimeout,
  clearTimeout,
  console: { info() {}, warn() {} }
}), { filename: 'page-capture-calendar-refresh.js' });
const refreshAccountBody = 'terminal=1&version=0.0.0&user_id=test-user';
const refreshSummaryBody = `${refreshAccountBody}&manual_id=&fund_key=refresh-fund&rzrq_fund_key=`;
await calendarRefreshWindow.fetch(accountListUrl, { method: 'POST', body: refreshAccountBody });
await flushAsyncWork();
await calendarRefreshWindow.fetch(summaryUrl, { method: 'POST', body: refreshSummaryBody });
await flushAsyncWork();
movingNow = new NativeDate('2026-07-15T15:40:00+08:00').getTime();
await calendarRefreshWindow.fetch(accountListUrl, { method: 'POST', body: refreshAccountBody });
await flushAsyncWork();
await calendarRefreshWindow.fetch(summaryUrl, { method: 'POST', body: refreshSummaryBody });
await flushAsyncWork();
assert.equal(
  calendarRefreshCalls.filter((call) => call.url.includes('/last_trading_day')).length,
  2,
  'a long-lived ledger page should refresh its calendar after the 15:35 cutoff'
);
assert.deepEqual(
  [...new Set(calendarRefreshCalls
    .filter((call) => call.url.includes('/get_money_history'))
    .map((call) => new URLSearchParams(String(call.options.body)).get('start_date')))],
  ['20260714', '20260715'],
  'calendar refresh should move the history target from previous trading day to current trading day'
);

console.log('PASS tzzb page capture');
