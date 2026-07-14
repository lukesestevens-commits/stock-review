import assert from 'node:assert/strict';
import { createCloudWorker } from '../cloud/worker.mjs';

const pruneCalls = [];
let waitedFor = null;
const app = createCloudWorker({
  dailyReviewStoreFactory: ({ db, env }) => ({
    async pruneCandidates(beforeDate) {
      pruneCalls.push({ beforeDate, db, env });
      return { deleted: 3 };
    }
  })
});
const env = { DB: { binding: 'daily-review-test' } };
const scheduledTime = Date.parse('2026-07-15T16:30:00.000Z');
const result = await app.scheduled({ scheduledTime }, env, {
  waitUntil(promise) {
    waitedFor = promise;
  }
});

assert.deepEqual(result, { deleted: 3 });
assert.ok(waitedFor instanceof Promise, 'the scheduled cleanup must be registered with waitUntil');
assert.deepEqual(await waitedFor, { deleted: 3 });
assert.equal(pruneCalls.length, 1);
assert.equal(pruneCalls[0].beforeDate, '2026-04-17', '90 days must be measured from the Shanghai calendar date');
assert.equal(pruneCalls[0].db, env.DB);
assert.equal(pruneCalls[0].env, env);

console.log('PASS cloud retention schedule');
