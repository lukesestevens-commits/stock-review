import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('/Users/ruiqiwang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const html = await fs.readFile(new URL('../index.html', import.meta.url), 'utf8');

function verified(date, captureDate, rightThing) {
  const capturedAt = `${captureDate}T07:10:00.000Z`;
  return {
    ok: true,
    dailyReview: {
      date,
      reviewDate: date,
      basic: {},
      market: {},
      trades: [],
      holdings: [],
      reflection: { rightThing, bigMistake: '' },
      plan: {}
    },
    audit: {
      status: 'verified',
      reviewDate: date,
      captureDate,
      capturedAt,
      verifiedAt: capturedAt,
      issueCodes: [],
      warnings: []
    }
  };
}

const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  await page.addInitScript(() => {
    const nativeSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = (callback, delay, ...args) => nativeSetTimeout(callback, delay === 30000 ? 500 : delay, ...args);
  });
  let latestRequests = 0;
  let marketRequests = 0;
  await page.route('https://review.example.com/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/' || url.pathname === '/index.html') {
      await route.fulfill({ status: 200, contentType: 'text/html', body: html });
      return;
    }
    if (url.pathname === '/api/review-draft') {
      await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false }) });
      return;
    }
    if (url.pathname === '/api/sync/latest') {
      latestRequests += 1;
      const body = latestRequests === 1
        ? verified('2026-07-14', '2026-07-14', '昨日旧数据')
        : verified('2026-07-15', '2026-07-15', '今日已核验');
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      return;
    }
    if (url.pathname === '/api/market-snapshot') {
      marketRequests += 1;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        ok: true,
        market: {
          indexState: '指数强',
          mood: '分化',
          actionEnv: '只做核心',
          mainLines: '今日市场主线',
          marketOne: '今日市场判断',
          updatedAt: `2026-07-15T07:20:${String(marketRequests).padStart(2, '0')}.000Z`
        }
      }) });
      return;
    }
    await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false }) });
  });

  await page.goto('https://review.example.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__unused !== true && document.getElementById('tzzbVerificationState')?.textContent.length > 0);
  await page.waitForTimeout(160);
  assert.equal(latestRequests, 1);
  assert.equal(await page.locator('#date').inputValue(), '2026-07-15', 'stale verified data must not move the page back a day');
  assert.notEqual(await page.locator('#rightThing').inputValue(), '昨日旧数据');

  await page.waitForFunction(() => document.getElementById('rightThing')?.value === '今日已核验', null, { timeout: 2500 });
  assert.ok(latestRequests >= 2, 'hosted stable state must keep polling for a later verified close');

  await page.locator('#date').fill('2026-07-14');
  await page.locator('#date').press('Tab');
  await page.waitForFunction(() => document.getElementById('date')?.value === '2026-07-14');
  assert.equal(await page.locator('#mainLines').inputValue(), '');
  await page.evaluate(() => autoImportMarketSnapshot());
  assert.equal(await page.locator('#mainLines').inputValue(), '', 'today\'s market snapshot must not contaminate a historical review');
} finally {
  await browser.close();
}

console.log('PASS hosted polling skips stale data and imports the later verified close');
