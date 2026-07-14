import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../tools/tzzb-edge-extension/page-capture.js', import.meta.url), 'utf8');
const summaryUrl = 'https://tzzb.10jqka.com.cn/caishen_httpserver/tzzb/caishen_fund/pc/account/v1/merge_day_trading';
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
const fixedNow = new NativeDate('2026-07-13T10:00:00+08:00').getTime();
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
  assert.equal(body.get('start_date'), '20260713');
  assert.equal(body.get('end_date'), '20260713');
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

console.log('PASS tzzb page capture');
