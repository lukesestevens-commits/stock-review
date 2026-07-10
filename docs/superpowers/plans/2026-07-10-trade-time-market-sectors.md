# Trade Time and Market Sectors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture real same-day trade timestamps automatically, sort trades to the second, and refresh strong-sector data reliably without high-frequency public API requests or stale quality locks.

**Architecture:** Keep the review page, Edge extension, and local helper split. The page-world capture script will make a read-only same-session detail request after observing the existing day-trade summary, the mapper will enrich only summary-authorized trades with detail timestamps, and a focused helper cache plus an independent page timer will own market refreshes.

**Tech Stack:** Vanilla JavaScript, Manifest V3 Edge extension, Node.js ESM, Node `vm` test harness, existing browser smoke tests.

---

## File structure

- Modify `tools/tzzb-edge-extension/page-capture.js`: trigger read-only same-day paginated detail capture in the authenticated page context.
- Create `tests/tzzb-page-capture.test.mjs`: execute the page script in a mocked browser context and verify request construction, pagination, and deduplication.
- Modify `tools/tzzb-review-mapper.mjs`: merge summary rows with detail rows, preserve seconds, keep missing time empty, and sort by seconds.
- Modify `tests/tzzb-review-mapper.test.mjs`: cover real-time enrichment, filtering, missing-time behavior, and ordering.
- Create `tools/market-snapshot-cache.mjs`: isolate cache TTL, in-flight request reuse, and same-day stale fallback.
- Create `tests/market-snapshot-cache.test.mjs`: verify the cache without starting the helper.
- Modify `tools/tzzb-local-helper.mjs`: route `/api/market-snapshot` through the cache.
- Modify `tests/tzzb-helper-server.test.mjs`: verify repeated market requests reuse a snapshot.
- Modify `index.html`: separate market polling from three-second trade polling and remove the stale quality lock.
- Modify `tests/review-page.test.mjs`: verify the independent timer and actual-application status semantics.
- Update time expectations in affected cloud and helper tests if they assert minute-only values.

### Task 1: Automatically capture authenticated trade details

**Files:**
- Create: `tests/tzzb-page-capture.test.mjs`
- Modify: `tools/tzzb-edge-extension/page-capture.js`

- [ ] **Step 1: Write the failing page-capture test**

Create a `vm` context with a mocked `window.fetch`, `window.postMessage`, `location`, `URL`, `URLSearchParams`, and `XMLHttpRequest`. Return a merge response for the original request and two detail pages for the generated requests:

```js
const fetchCalls = [];
const emitted = [];
const responses = new Map([
  [1, { ex_data: { page: 1, max_page: 2, list: [{ entry_time: '09:49:38' }] } }],
  [2, { ex_data: { page: 2, max_page: 2, list: [{ entry_time: '14:11:01' }] } }]
]);

async function fetchMock(url, options = {}) {
  fetchCalls.push({ url: String(url), options });
  const page = Number(new URLSearchParams(options.body || '').get('page') || 0);
  const payload = String(url).includes('merge_day_trading')
    ? { ex_data: { data: [{ zqmc: '样本股票' }] } }
    : responses.get(page);
  const text = JSON.stringify(payload);
  return {
    ok: true,
    status: 200,
    url: String(url),
    clone() { return this; },
    async text() { return text; }
  };
}
```

After running the source, call the patched fetch with a `merge_day_trading` URL and a body containing `userid` and `fund_key`. Assert that detail calls use `pc/account/v2/get_money_history`, `start_date` and `end_date` equal the local test date, pages are `[1, 2]`, and emitted detail records contain both responses. Call the same merge request again and assert no second detail sequence starts inside the refresh window.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
/Users/ruiqiwang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node tests/tzzb-page-capture.test.mjs
```

Expected: FAIL because `page-capture.js` records the merge response but does not request `get_money_history`.

- [ ] **Step 3: Implement a single response-capture path**

In `page-capture.js`, route fetch and XHR responses through:

```js
function captureResponse(record) {
  emitRecord(record);
  if (isDayTradeSummary(record.url, record.method, record.status)) {
    captureSameDayTradeDetails(record.url, record.requestPostData).catch((error) => {
      console.warn('[tzzb-stable-capture] trade detail read failed', error);
    });
  }
}
```

Use it from both patched fetch and XHR so the behavior is transport-independent.

- [ ] **Step 4: Implement deduplicated paginated detail reads**

Add a 30-second per-account/day guard and construct the detail URL by replacing the summary endpoint suffix. Preserve only account identity fields from the observed request and force the date range to today:

```js
const params = new URLSearchParams(summaryBody || '');
const detailBody = new URLSearchParams({
  user_id: params.get('user_id') || params.get('userid') || '',
  manual_id: params.get('manual_id') || '',
  fund_key: params.get('fund_key') || '',
  rzrq_fund_key: params.get('rzrq_fund_key') || '',
  fundid: params.get('fundid') || '',
  custid: params.get('custid') || '',
  start_date: localCompactDate(),
  end_date: localCompactDate(),
  query_list: '[]',
  page: String(page),
  count: '200',
  sort_type: '',
  sort_order: '1',
  h5id: String(Date.now())
});
```

Call `originalFetch` with `credentials: 'include'`, emit each detail response manually, parse `ex_data.max_page`, and stop when all pages are read or when a response is not successful.

- [ ] **Step 5: Run the page-capture test and verify GREEN**

Run the Task 1 command again.

Expected: `PASS tzzb page capture`.

- [ ] **Step 6: Commit Task 1**

```bash
git add tools/tzzb-edge-extension/page-capture.js tests/tzzb-page-capture.test.mjs
git commit -m "fix: capture same-day trade details"
```

### Task 2: Enrich authorized trades with real second-level timestamps

**Files:**
- Modify: `tests/tzzb-review-mapper.test.mjs`
- Modify: `tools/tzzb-review-mapper.mjs`
- Modify as required: `tests/cloud-worker.test.mjs`, `tests/tzzb-cloud-sync-server.test.mjs`, `tests/tzzb-helper-server.test.mjs`

- [ ] **Step 1: Write failing mapper assertions**

Add one capture with `merge_day_trading` rows and one paginated `get_money_history` capture containing matching detail rows plus an unmatched reverse-repurchase row. Assert:

```js
assert.deepEqual(
  mapped.trades.map((trade) => `${trade.time} ${trade.name}`),
  [
    '09:30:59 光智科技',
    '09:33:26 甬矽电子',
    '09:49:06 双鹭药业',
    '14:11:01 东山精密'
  ]
);
assert.doesNotMatch(mapped.trades.map((trade) => trade.name).join(','), /GC001/);
```

Change the existing no-time summary expectation to `['', '']` and assert the audit warning contains `真实成交时间`.

- [ ] **Step 2: Run the mapper test and verify RED**

```bash
/Users/ruiqiwang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node tests/tzzb-review-mapper.test.mjs
```

Expected: FAIL because times are truncated, detail rows replace summary scope, and missing times are fabricated.

- [ ] **Step 3: Preserve seconds and remove fallback time generation**

Replace `normalizeTime()` and the minute sorter with:

```js
function normalizeTime(value) {
  const match = String(value ?? '').match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return '';
  return `${match[1].padStart(2, '0')}:${match[2]}:${match[3] || '00'}`;
}

function tradeSortSeconds(trade) {
  const match = String(trade.time || '').match(/^(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return Number.POSITIVE_INFINITY;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}
```

Return `time` directly from `mapTrade()` without a generated fallback.

- [ ] **Step 4: Merge detail rows into summary rows**

Create a stable match key from code-or-name, normalized side, price, and quantity. Store detail rows in per-key queues and consume each at most once:

```js
function enrichDayTrades(dayTrades, detailTrades) {
  const detailsByKey = new Map();
  for (const detail of detailTrades) {
    const key = tradeMatchKey(detail);
    if (!detailsByKey.has(key)) detailsByKey.set(key, []);
    detailsByKey.get(key).push(detail);
  }
  return dayTrades.map((summary) => {
    const detail = detailsByKey.get(tradeMatchKey(summary))?.shift();
    return detail ? { ...summary, entry_time: detail.entry_time || detail.cjsj || detail.time } : summary;
  });
}
```

When summary rows exist, use enriched summary rows as `rawTrades`; only use detail rows directly when no summary exists. Add `缺少 N 笔真实成交时间` when a mapped summary trade has no time.

- [ ] **Step 5: Run mapper and affected focused tests**

```bash
/Users/ruiqiwang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node tests/tzzb-review-mapper.test.mjs
/Users/ruiqiwang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node tests/tzzb-helper-server.test.mjs
/Users/ruiqiwang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node tests/cloud-worker.test.mjs
/Users/ruiqiwang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node tests/tzzb-cloud-sync-server.test.mjs
```

Expected: all four test files pass with second-level time expectations.

- [ ] **Step 6: Commit Task 2**

```bash
git add tools/tzzb-review-mapper.mjs tests/tzzb-review-mapper.test.mjs tests/cloud-worker.test.mjs tests/tzzb-cloud-sync-server.test.mjs tests/tzzb-helper-server.test.mjs
git commit -m "fix: map real trade timestamps"
```

### Task 3: Cache market snapshots and reuse in-flight reads

**Files:**
- Create: `tools/market-snapshot-cache.mjs`
- Create: `tests/market-snapshot-cache.test.mjs`
- Modify: `tools/tzzb-local-helper.mjs`
- Modify: `tests/tzzb-helper-server.test.mjs`

- [ ] **Step 1: Write the failing cache test**

Test three behaviors with an injected clock and loader: two simultaneous `get()` calls invoke the loader once; another call before 60 seconds returns the cached object; after expiry a successful load returns a new object. Also verify that an expired same-day cached value is returned with `stale: true` when refresh throws.

```js
const cache = createMarketSnapshotCache({ load, ttlMs: 60_000, now: () => now });
const [first, second] = await Promise.all([cache.get(), cache.get()]);
assert.equal(loadCount, 1);
assert.strictEqual(first, second);
now += 59_000;
await cache.get();
assert.equal(loadCount, 1);
```

- [ ] **Step 2: Run the cache test and verify RED**

```bash
/Users/ruiqiwang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node tests/market-snapshot-cache.test.mjs
```

Expected: FAIL because the cache module does not exist.

- [ ] **Step 3: Implement the focused cache module**

Export `createMarketSnapshotCache({ load, ttlMs = 60_000, now = Date.now })`. Keep `cached`, `expiresAt`, and `inFlight` in the closure. `get()` returns a fresh cache hit, shares `inFlight`, stores successful loads, and on failure returns a same-local-day cached snapshot with `{ ...cached, stale: true }`; otherwise it rethrows.

- [ ] **Step 4: Route the helper market endpoint through the cache**

In `tools/tzzb-local-helper.mjs`:

```js
const marketSnapshots = createMarketSnapshotCache({
  load: () => fetchMarketSnapshot(),
  ttlMs: 60_000
});
```

Use `await marketSnapshots.get()` in `handleMarketSnapshot()`. Update `helperVersion` for the repaired build.

- [ ] **Step 5: Run cache and helper tests**

Run:

```bash
/Users/ruiqiwang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node tests/market-snapshot-cache.test.mjs
/Users/ruiqiwang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node tests/tzzb-helper-server.test.mjs
```

Expected: `PASS market snapshot cache` and `PASS tzzb helper server`.

- [ ] **Step 6: Commit Task 3**

```bash
git add tools/market-snapshot-cache.mjs tools/tzzb-local-helper.mjs tests/market-snapshot-cache.test.mjs tests/tzzb-helper-server.test.mjs
git commit -m "fix: stabilize market snapshot refresh"
```

### Task 4: Decouple page market refresh and apply fresh fallback results

**Files:**
- Modify: `tests/review-page.test.mjs`
- Modify: `index.html`

- [ ] **Step 1: Replace stale-policy tests with freshness tests**

Remove the test that expects fallback data to be rejected after live data. Add assertions that a valid live snapshot and a later valid fallback snapshot both apply, while an empty snapshot does not:

```js
assert.equal(context.applyMarketSnapshot({
  updatedAt: '2026-07-10T09:30:00.000Z',
  boardQuality: 'live',
  mainLines: '行业：半导体'
}), true);
assert.equal(context.applyMarketSnapshot({
  updatedAt: '2026-07-10T09:31:00.000Z',
  boardQuality: 'fallback',
  mainLines: '强势板块：传媒'
}), true);
assert.equal(context.applyMarketSnapshot({ updatedAt: '2026-07-10T09:32:00.000Z' }), false);
```

Statically assert `setInterval(autoImportLatestTzzbData, 3000)` remains, `setInterval(autoImportMarketSnapshot, 60000)` exists, and the same-capture branch no longer calls the market API.

- [ ] **Step 2: Run the page test and verify RED**

```bash
/Users/ruiqiwang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node tests/review-page.test.mjs
```

Expected: FAIL because the old quality lock rejects fallback data and market reads remain coupled to trade polling.

- [ ] **Step 3: Separate market polling**

Add `marketAutoImportTimer`, remove market reads from `autoImportLatestTzzbData()`, and add:

```js
async function autoImportMarketSnapshot(){
  await importMarketSnapshot({ silent: true });
}
function startMarketAutoImport(){
  if(marketAutoImportTimer) clearInterval(marketAutoImportTimer);
  autoImportMarketSnapshot();
  marketAutoImportTimer = setInterval(autoImportMarketSnapshot, 60000);
}
```

Start it next to `startTzzbAutoImport()` during page initialization.

- [ ] **Step 4: Apply valid snapshots by freshness, not source rank**

Remove `marketSnapshotQuality()`, `shouldApplyMarketSnapshot()`, and their state variables. Make `applyMarketSnapshot()` reject snapshots without a non-empty `mainLines`, write all non-empty market fields, and return `true` only when values were applied. Make `importMarketSnapshot()` return `false` for an unchanged `updatedAt` or a rejected snapshot instead of reporting success.

- [ ] **Step 5: Run page and browser smoke tests**

```bash
/Users/ruiqiwang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node tests/review-page.test.mjs
/Users/ruiqiwang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node tests/browser-smoke.mjs
```

Expected: `PASS review page logic`, `PASS cloud sync fetch config`, and `PASS browser smoke`.

- [ ] **Step 6: Commit Task 4**

```bash
git add index.html tests/review-page.test.mjs
git commit -m "fix: refresh strong sectors independently"
```

### Task 5: Full verification and live workflow check

**Files:**
- Verify: all modified files
- Generated and ignored: `dist/**`

- [ ] **Step 1: Run the complete test suite**

```bash
/Users/ruiqiwang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node tests/run-all.mjs
```

Expected: every test file passes with zero failures.

- [ ] **Step 2: Build the cloud site**

```bash
/Users/ruiqiwang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node tools/build-cloud-site.mjs
```

Expected: `Built dist/server/index.js`.

- [ ] **Step 3: Verify the local helper API**

Restart the helper using `启动复盘助手.command`, then run:

```bash
curl -sS http://127.0.0.1:8787/api/tzzb-health
curl -sS http://127.0.0.1:8787/api/market-snapshot
```

Expected: both responses have `ok: true`; the market response contains non-empty `mainLines` and a current `updatedAt`.

- [ ] **Step 4: Reload the existing Edge extension and refresh the ledger**

Reload the unpacked extension in `edge://extensions/`, refresh the existing investment-ledger page once, and leave it on the account overview. Wait for the helper to receive `get_money_history` without manually opening the transaction tab.

- [ ] **Step 5: Verify live mapped trades**

Read `/api/tzzb-latest` and assert all populated trade times match `^\\d{2}:\\d{2}:\\d{2}$`, are ascending by seconds, and no generated `09:30`, `09:31` sequence remains. Confirm the review page displays the same order and that `mainLines` updates from the independent market refresh.

- [ ] **Step 6: Inspect final repository state**

```bash
git status --short
git log -6 --oneline
```

Expected: the worktree is clean and the implementation commits follow the approved plan.
