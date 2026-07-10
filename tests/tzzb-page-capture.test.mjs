import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../tools/tzzb-edge-extension/page-capture.js', import.meta.url), 'utf8');
const mergeUrl = 'https://tzzb.10jqka.com.cn/caishen_httpserver/tzzb/caishen_fund/pc/account/v1/merge_day_trading';
const detailUrlPart = '/pc/account/v2/get_money_history';
const mergeBody = 'terminal=1&version=0.0.0&userid=123&user_id=123&manual_id=&fund_key=demo&rzrq_fund_key=';
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

async function fetchMock(url, options = {}) {
  const target = String(url);
  fetchCalls.push({ url: target, options });
  if (target.includes('merge_day_trading')) {
    return response(target, { ex_data: { data: [{ zqmc: '样本股票' }] } });
  }
  if (target.includes(detailUrlPart)) {
    const page = Number(new URLSearchParams(options.body || '').get('page'));
    return response(target, {
      ex_data: {
        page,
        max_page: 2,
        list: [{ entry_date: '2026-07-10', entry_time: page === 1 ? '09:49:38' : '14:11:01' }]
      }
    });
  }
  throw new Error(`Unexpected fetch ${target}`);
}

class FixedDate extends Date {
  constructor(value = '2026-07-10T09:00:00+08:00') {
    super(value);
  }

  static now() {
    return new Date('2026-07-10T09:00:00+08:00').getTime();
  }
}

class MockXMLHttpRequest {
  open() {}
  send() {}
  addEventListener() {}
}

const window = {
  fetch: fetchMock,
  XMLHttpRequest: MockXMLHttpRequest,
  postMessage(message) { emitted.push(message); }
};
const context = {
  window,
  console,
  Date: FixedDate,
  URL,
  URLSearchParams,
  location: {
    href: 'https://tzzb.10jqka.com.cn/pc/index.html#/myAccount/a/demo',
    origin: 'https://tzzb.10jqka.com.cn'
  },
  setTimeout,
  clearTimeout
};
vm.createContext(context);
vm.runInContext(source, context);

async function flushAsyncWork() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

await window.fetch(mergeUrl, { method: 'POST', body: mergeBody });
await flushAsyncWork();

const detailCalls = fetchCalls.filter((call) => call.url.includes(detailUrlPart));
assert.deepEqual(
  detailCalls.map((call) => Number(new URLSearchParams(call.options.body).get('page'))),
  [1, 2],
  'day-trade summary should trigger every detail page'
);
for (const call of detailCalls) {
  const params = new URLSearchParams(call.options.body);
  assert.equal(params.get('start_date'), '20260710');
  assert.equal(params.get('end_date'), '20260710');
  assert.equal(params.get('count'), '200');
  assert.equal(call.options.credentials, 'include');
}

const detailRecords = emitted
  .map((message) => message.record)
  .filter((record) => record?.url.includes(detailUrlPart));
assert.equal(detailRecords.length, 2, 'every detail page should be forwarded to the extension bridge');
assert.match(detailRecords[0].responseText, /09:49:38/);
assert.match(detailRecords[1].responseText, /14:11:01/);

await window.fetch(mergeUrl, { method: 'POST', body: mergeBody });
await flushAsyncWork();
assert.equal(
  fetchCalls.filter((call) => call.url.includes(detailUrlPart)).length,
  2,
  'duplicate summaries inside the refresh window should not repeat the detail request'
);

console.log('PASS tzzb page capture');
