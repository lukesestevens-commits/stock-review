import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('/Users/ruiqiwang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const html = await fs.readFile(new URL('../index.html', import.meta.url), 'utf8');
const today = '2026-07-15';
const priorDay = '2026-07-14';

function market(date, suffix = '') {
  return {
    indexState: '指数弱',
    mood: '退潮',
    actionEnv: '防守',
    mainLines: `概念：创新药${suffix}`,
    marketOne: `三大指数收跌，适合防守${suffix}。`,
    tradeDate: date,
    finalized: true,
    finalizedAt: `${date}T07:05:00.000Z`,
    updatedAt: `${date}T07:05:00.000Z`
  };
}

async function routeHostedPage(page, onMarket) {
  await page.route('https://review.example.com/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/' || url.pathname === '/index.html') {
      await route.fulfill({ status: 200, contentType: 'text/html', body: html });
      return;
    }
    if (url.pathname === '/api/review-draft' && request.method() === 'GET') {
      await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false }) });
      return;
    }
    if (url.pathname === '/api/review-draft' && request.method() === 'PUT') {
      const payload = request.postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          draft: {
            reviewDate: payload.reviewDate,
            version: Number(payload.expectedVersion || 0) + 1,
            updatedAt: new Date().toISOString(),
            record: payload.record
          }
        })
      });
      return;
    }
    if (url.pathname === '/api/sync/latest') {
      await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false }) });
      return;
    }
    if (url.pathname === '/api/market-snapshot') {
      await onMarket(route, url);
      return;
    }
    await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false }) });
  });
}

const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(() => {
    const nativeSetInterval = window.setInterval.bind(window);
    window.setInterval = (callback, delay, ...args) => nativeSetInterval(callback, delay === 60000 ? 100 : delay, ...args);
  });
  const fixed = market(today);
  let requests = 0;
  await routeHostedPage(page, async (route) => {
    requests += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, market: fixed })
    });
  });

  await page.goto('https://review.example.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('mainLines')?.value === '概念：创新药');
  await page.locator('#mainLines').fill('');
  await page.locator('#marketOne').fill('');
  await page.waitForFunction(() => document.getElementById('mainLines')?.value === '概念：创新药', null, { timeout: 1500 });

  assert.ok(requests >= 2, 'the independent market poll should re-read the finalized snapshot');
  assert.equal(await page.locator('#marketOne').inputValue(), '三大指数收跌，适合防守。');
  assert.equal(await page.locator('#marketSyncStatus').count(), 1, 'the market module should expose its own synchronization status');
  assert.match(
    await page.locator('#marketSyncStatus').textContent(),
    /2026-07-15.*已固化.*自动填写/,
    'the market module should expose a dedicated, dated synchronization status'
  );
  await context.close();

  {
    const context = await browser.newContext();
    const page = await context.newPage();
    let markMarketStarted;
    let releaseMarket;
    const marketStarted = new Promise((resolve) => { markMarketStarted = resolve; });
    const marketRelease = new Promise((resolve) => { releaseMarket = resolve; });
    await routeHostedPage(page, async (route) => {
      markMarketStarted();
      await marketRelease;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, market: market(today, '·迟到') })
      });
    });

    await page.goto('https://review.example.com/', { waitUntil: 'domcontentloaded' });
    await marketStarted;
    await page.locator('#date').fill(priorDay);
    await page.locator('#date').press('Tab');
    await page.waitForFunction(() => document.getElementById('date')?.value === '2026-07-14');
    releaseMarket();
    await page.waitForTimeout(250);

    assert.equal(await page.locator('#mainLines').inputValue(), '', 'a response for the old date must not write into the newly selected review date');
    assert.equal(await page.locator('#marketOne').inputValue(), '', 'the late market judgment must remain isolated to its requested date');
    await context.close();
  }

  {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.addInitScript(() => {
      const nativeSetInterval = window.setInterval.bind(window);
      window.setInterval = (callback, delay, ...args) => nativeSetInterval(callback, delay === 60000 ? 100 : delay, ...args);
    });
    const requestedDates = [];
    await routeHostedPage(page, async (route, url) => {
      const requestedDate = url.searchParams.get('date');
      requestedDates.push(requestedDate);
      const selected = requestedDate === priorDay
        ? market(priorDay, '·历史同日')
        : market(today);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, market: selected })
      });
    });

    await page.goto('https://review.example.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('mainLines')?.value === '概念：创新药');
    await page.locator('#date').fill(priorDay);
    await page.locator('#date').press('Tab');
    await page.waitForFunction(() => document.getElementById('mainLines')?.value === '概念：创新药·历史同日', null, { timeout: 1500 });

    assert.ok(requestedDates.includes(today), 'the current review should request its own dated snapshot');
    assert.ok(requestedDates.includes(priorDay), 'a historical review should request the cloud snapshot for that exact date');
    assert.equal(await page.locator('#marketOne').inputValue(), '三大指数收跌，适合防守·历史同日。');
    await context.close();
  }

  {
    const context = await browser.newContext();
    const page = await context.newPage();
    await routeHostedPage(page, async (route, url) => {
      const requestedDate = url.searchParams.get('date') || today;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, market: market(requestedDate, requestedDate === priorDay ? '·切换即时' : '') })
      });
    });

    await page.goto('https://review.example.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('mainLines')?.value === '概念：创新药');
    await page.locator('#date').fill(priorDay);
    await page.locator('#date').press('Tab');
    await page.waitForFunction(() => document.getElementById('mainLines')?.value === '概念：创新药·切换即时', null, { timeout: 1500 });
    assert.match(await page.locator('#marketSyncStatus').textContent(), /2026-07-14.*自动填写/);
    await context.close();
  }

  {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.addInitScript(() => {
      const nativeSetInterval = window.setInterval.bind(window);
      window.setInterval = (callback, delay, ...args) => nativeSetInterval(callback, delay === 60000 ? 100 : delay, ...args);
    });
    await routeHostedPage(page, async (route, url) => {
      const requestedDate = url.searchParams.get('date');
      const selected = requestedDate === priorDay
        ? market(today, '·错日')
        : market(today);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, market: selected })
      });
    });

    await page.goto('https://review.example.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('mainLines')?.value === '概念：创新药');
    await page.locator('#date').fill(priorDay);
    await page.locator('#date').press('Tab');
    await page.waitForFunction(() => document.getElementById('date')?.value === '2026-07-14');
    await page.waitForTimeout(350);

    assert.equal(await page.locator('#mainLines').inputValue(), '', 'a response whose tradeDate differs from the requested review date must be rejected');
    assert.equal(await page.locator('#marketOne').inputValue(), '', 'cross-date market judgment must never contaminate the active draft');
    await context.close();
  }
} finally {
  await browser.close();
}

console.log('PASS finalized market snapshot repairs cleared fields even when updatedAt is unchanged');
