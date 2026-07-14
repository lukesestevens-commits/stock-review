import assert from 'node:assert/strict';
import { createMarketSnapshotCache } from '../tools/market-snapshot-cache.mjs';

let now = new Date('2026-07-10T09:30:00+08:00').getTime();
let loadCount = 0;
let failNext = false;
let releaseFirstLoad;
const firstLoadGate = new Promise((resolve) => { releaseFirstLoad = resolve; });

async function load() {
  loadCount += 1;
  if (loadCount === 1) await firstLoadGate;
  if (failNext) throw new Error('public market source unavailable');
  return {
    updatedAt: new Date(now).toISOString(),
    mainLines: loadCount === 1 ? '行业：半导体' : '强势板块：传媒'
  };
}

const cache = createMarketSnapshotCache({
  load,
  ttlMs: 60_000,
  now: () => now
});

const firstPromise = cache.get();
const secondPromise = cache.get();
assert.equal(loadCount, 1, 'simultaneous reads should share the in-flight loader');
releaseFirstLoad();
const [first, second] = await Promise.all([firstPromise, secondPromise]);
assert.strictEqual(first, second, 'simultaneous reads should receive the same snapshot object');

now += 59_000;
assert.strictEqual(await cache.get(), first, 'reads inside the TTL should reuse the cached object');
assert.equal(loadCount, 1);

now += 2_000;
const refreshed = await cache.get();
assert.equal(loadCount, 2, 'the cache should refresh after the TTL');
assert.equal(refreshed.mainLines, '强势板块：传媒');
assert.notStrictEqual(refreshed, first);

now += 61_000;
failNext = true;
const stale = await cache.get();
assert.equal(loadCount, 3);
assert.equal(stale.mainLines, refreshed.mainLines);
assert.equal(stale.stale, true, 'same-day cached data should remain available after a refresh failure');

now += 24 * 60 * 60 * 1000;
await assert.rejects(
  () => cache.get(),
  /public market source unavailable/,
  'a previous-day snapshot should not hide a current-day source failure'
);

console.log('PASS market snapshot cache');
