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
assert.equal(sensitiveRecord.captureDate, '2026-07-03', 'records should carry an explicit Shanghai capture date');
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

const historyPageOne = buildCaptureRecord({
  ...sensitiveRecord,
  url: 'https://tzzb.10jqka.com.cn/caishen_fund/pc/account/v2/get_money_history',
  responseText: '{"ex_data":{"list":[]}}',
  requestPostData: 'start_date=20260714&end_date=20260714&page=1&count=200'
});
const historyPageTwo = buildCaptureRecord({
  ...historyPageOne,
  requestPostData: 'start_date=20260714&end_date=20260714&page=2&count=200'
});
assert.equal(
  dedupeRecords([historyPageOne, historyPageTwo]).length,
  2,
  'identical history responses from distinct request pages must retain completeness evidence'
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
assert.equal(payload.capturedAt, '2026-07-03T09:30:00.000Z');
assert.equal(payload.captureDate, '2026-07-03');

queue.markSynced(2, '2026-07-03T10:01:00.000Z');
assert.equal(queue.stats().pendingCount, 1);
assert.equal(queue.stats().lastSyncAt, '2026-07-03T10:01:00.000Z');

const crossMidnightQueue = new TzzbSyncQueue({
  now: () => '2026-07-14T16:02:00.000Z'
});
crossMidnightQueue.enqueue([
  { ...sensitiveRecord, capturedAt: '2026-07-14T15:59:00.000Z', captureDate: '', url: `${sensitiveRecord.url}?before-midnight=1` },
  { ...sensitiveRecord, capturedAt: '2026-07-14T16:01:00.000Z', captureDate: '', url: `${sensitiveRecord.url}?after-midnight=1` }
]);
assert.deepEqual(
  crossMidnightQueue.snapshot().records.map((record) => record.url),
  [
    `${sensitiveRecord.url}?before-midnight=1`,
    `${sensitiveRecord.url}?after-midnight=1`
  ],
  'pending uploads should survive a Shanghai calendar-day rollover'
);
assert.deepEqual(
  crossMidnightQueue.snapshot().records.map((record) => record.captureDate),
  ['2026-07-14', '2026-07-15']
);
assert.equal(crossMidnightQueue.stats().targetDate, '2026-07-15');
assert.equal(crossMidnightQueue.stats().endpointCoverage.readyForReview, false);

const pendingPayload = crossMidnightQueue.buildPayload();
assert.equal(crossMidnightQueue.stats().pendingCount, 2, 'building an upload must not acknowledge queued records');
const restoredAfterMidnight = TzzbSyncQueue.fromSnapshot(crossMidnightQueue.snapshot(), {
  now: () => '2026-07-14T16:10:00.000Z'
});
assert.equal(restoredAfterMidnight.stats().pendingCount, 2, 'reloading extension state must retain unconfirmed uploads');
restoredAfterMidnight.markSynced(pendingPayload.records.length, '2026-07-14T16:11:00.000Z');
assert.equal(restoredAfterMidnight.stats().pendingCount, 0, 'only helper confirmation should dequeue uploaded records');

const ttlQueue = TzzbSyncQueue.fromSnapshot({
  records: [
    { ...sensitiveRecord, capturedAt: '2026-06-14T00:00:00.000Z', url: `${sensitiveRecord.url}?expired=1` },
    { ...sensitiveRecord, capturedAt: '2026-06-15T12:00:00.000Z', url: `${sensitiveRecord.url}?retained=1` },
    { ...sensitiveRecord, capturedAt: '2026-07-14T12:00:00.000Z', url: `${sensitiveRecord.url}?fresh=1` }
  ],
  lastCaptureAt: '2026-07-14T12:00:00.000Z'
}, {
  now: () => '2026-07-15T12:00:00.000Z'
});
assert.deepEqual(
  ttlQueue.snapshot().records.map((record) => record.url),
  [`${sensitiveRecord.url}?retained=1`, `${sensitiveRecord.url}?fresh=1`],
  'restoring the offline queue must discard captures older than 30 days'
);
ttlQueue.enqueue([
  { ...sensitiveRecord, capturedAt: '2026-05-01T00:00:00.000Z', url: `${sensitiveRecord.url}?late-stale=1` }
]);
assert.equal(
  ttlQueue.snapshot().records.some((record) => record.url.endsWith('?late-stale=1')),
  false,
  'enqueue must not reintroduce already-expired records'
);
assert.equal(scheduleSyncDelayMs({ pendingCount: 1 }), 2500);
assert.equal(scheduleSyncDelayMs({ pendingCount: 10 }), 2500);

console.log('PASS tzzb extension core');
