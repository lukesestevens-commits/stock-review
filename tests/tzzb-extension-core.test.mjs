import assert from 'node:assert/strict';
import {
  buildCaptureRecord,
  dedupeRecords,
  scheduleSyncDelayMs,
  redactRequestPostData,
  TzzbSyncQueue
} from '../tools/tzzb-edge-extension/shared-core.js';

const sensitiveRecord = buildCaptureRecord({
  type: 'fetch',
  method: 'POST',
  status: 200,
  url: 'https://tzzb.10jqka.com.cn/caishen_httpserver/tzzb/caishen_fund/pc/account/v1/init',
  responseText: '{"ok":true}',
  requestPostData: JSON.stringify({
    account: 'demo',
    token: 'abc',
    password: 'secret',
    nested: { cookie: 'still-here' }
  }),
  capturedAt: '2026-07-03T09:30:00.000Z'
});

assert.equal(sensitiveRecord.method, 'POST');
assert.equal(sensitiveRecord.responseText, '{"ok":true}');
assert.equal(
  sensitiveRecord.requestPostData,
  '{"account":"demo","token":"[REDACTED]","password":"[REDACTED]","nested":{"cookie":"[REDACTED]"}}',
  'request post data should redact sensitive keys recursively'
);

assert.equal(
  redactRequestPostData('plain body token=abc'),
  'plain body token=abc',
  'non-JSON request data should be preserved'
);

const duplicateA = { ...sensitiveRecord };
const duplicateB = { ...sensitiveRecord, capturedAt: '2026-07-03T09:31:00.000Z' };
const distinct = { ...sensitiveRecord, url: `${sensitiveRecord.url}?page=2` };
assert.deepEqual(
  dedupeRecords([duplicateA, duplicateB, distinct]).map((record) => record.url),
  [sensitiveRecord.url, distinct.url],
  'dedupe should keep the first matching method/url/status/body record'
);

const queue = new TzzbSyncQueue({
  maxRecords: 3,
  now: () => '2026-07-03T10:00:00.000Z'
});
queue.enqueue([duplicateA, duplicateB, distinct]);
queue.enqueue([
  { ...sensitiveRecord, url: `${sensitiveRecord.url}?page=3` },
  { ...sensitiveRecord, url: `${sensitiveRecord.url}?page=4` }
]);

assert.equal(queue.stats().capturedCount, 4, 'captured count tracks accepted unique records');
assert.equal(queue.stats().pendingCount, 3, 'queue should be capped to the latest records');
assert.deepEqual(
  queue.snapshot().records.map((record) => record.url),
  [
    `${sensitiveRecord.url}?page=2`,
    `${sensitiveRecord.url}?page=3`,
    `${sensitiveRecord.url}?page=4`
  ],
  'queue should retain the newest records when capped'
);

const payload = queue.buildPayload({
  pageUrl: 'https://tzzb.10jqka.com.cn/pc/index.html#/myAccount/a/demo'
});
assert.equal(payload.source, 'edge-extension');
assert.equal(payload.records.length, 3);
assert.equal(payload.pushedAt, '2026-07-03T10:00:00.000Z');

queue.markSynced(2, '2026-07-03T10:01:00.000Z');
assert.equal(queue.stats().pendingCount, 1);
assert.equal(queue.stats().lastSyncAt, '2026-07-03T10:01:00.000Z');

const dailyQueue = new TzzbSyncQueue({
  now: () => '2026-07-03T10:00:00.000Z'
});
dailyQueue.enqueue([
  { ...sensitiveRecord, capturedAt: '2026-07-02T15:00:00.000Z', url: `${sensitiveRecord.url}?old=1` },
  { ...sensitiveRecord, capturedAt: '2026-07-03T09:30:00.000Z', url: `${sensitiveRecord.url}?today=1` }
]);
assert.deepEqual(
  dailyQueue.snapshot().records.map((record) => record.url),
  [`${sensitiveRecord.url}?today=1`],
  'extension queue should discard records captured before the current local day'
);
assert.equal(dailyQueue.stats().targetDate, '2026-07-03');
assert.equal(dailyQueue.stats().endpointCoverage.readyForReview, false);
assert.equal(scheduleSyncDelayMs({ pendingCount: 1 }), 2500);
assert.equal(scheduleSyncDelayMs({ pendingCount: 10 }), 2500);

console.log('PASS tzzb extension core');
