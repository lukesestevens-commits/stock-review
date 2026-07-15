import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('/Users/ruiqiwang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const html = await fs.readFile(new URL('../index.html', import.meta.url), 'utf8');
const today = '2026-07-15';

function record(date, rightThing) {
  return {
    date,
    basic: {},
    market: {},
    trades: [],
    holdings: [],
    reflection: { rightThing, bigMistake: '' },
    plan: {},
    stats: {}
  };
}

async function routePage(page, handlers = {}) {
  await page.route('https://review.example.com/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/' || url.pathname === '/index.html') {
      await route.fulfill({ status: 200, contentType: 'text/html', body: html });
      return;
    }
    if (url.pathname === '/api/review-draft') {
      await handlers.reviewDraft(route, request, url);
      return;
    }
    if (url.pathname === '/api/sync/latest') {
      await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false }) });
      return;
    }
    if (url.pathname === '/api/market-snapshot') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, market: null }) });
      return;
    }
    await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false }) });
  });
}

const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    let cloud = { reviewDate: today, version: 1, updatedAt: '2026-07-15T08:00:00.000Z', record: record(today, '云端第一版') };
    let offlinePut = true;
    let putCount = 0;
    await routePage(page, {
      async reviewDraft(route, request) {
        if (request.method() === 'GET') {
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, draft: cloud }) });
          return;
        }
        putCount += 1;
        if (offlinePut) {
          await route.abort('failed');
          return;
        }
        const payload = request.postDataJSON();
        cloud = { reviewDate: today, version: cloud.version + 1, updatedAt: new Date().toISOString(), record: payload.record };
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, draft: cloud }) });
      }
    });
    await page.goto('https://review.example.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('rightThing')?.value === '云端第一版');
    await page.locator('#rightThing').fill('本机离线版');
    await page.waitForFunction(() => document.getElementById('autosaveStatus')?.textContent.includes('本机草稿已保留'));
    const localEnvelope = await page.evaluate(() => JSON.parse(localStorage.getItem('tradeReviewDataV3')));
    assert.equal(localEnvelope.baseCloudVersion, 1);
    assert.equal(localEnvelope.dirty, true);

    cloud = { reviewDate: today, version: 2, updatedAt: '2026-07-15T08:01:00.000Z', record: record(today, '另一设备新版') };
    offlinePut = false;
    const putsBeforeReload = putCount;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('autosaveStatus')?.textContent.includes('云端有更新版本'));
    await page.waitForTimeout(900);
    assert.equal(await page.locator('#rightThing').inputValue(), '本机离线版');
    assert.equal(putCount, putsBeforeReload, 'an offline fork must not auto-overwrite the newer cloud version');
    assert.ok(await page.evaluate(() => localStorage.getItem('tradeReviewDraftConflictV1')));
    await context.close();
  }

  {
    const context = await browser.newContext();
    const page = await context.newPage();
    let cloud = { reviewDate: today, version: 3, updatedAt: '2026-07-15T08:00:00.000Z', record: record(today, '云端加载值') };
    await routePage(page, {
      async reviewDraft(route, request) {
        if (request.method() === 'GET') {
          await new Promise(resolve => setTimeout(resolve, 700));
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, draft: cloud }) });
          return;
        }
        const payload = request.postDataJSON();
        cloud = { reviewDate: today, version: cloud.version + 1, updatedAt: new Date().toISOString(), record: payload.record };
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, draft: cloud }) });
      }
    });
    await page.goto('https://review.example.com/', { waitUntil: 'domcontentloaded' });
    await page.locator('#rightThing').fill('加载期间输入');
    await page.waitForTimeout(900);
    assert.equal(await page.locator('#rightThing').inputValue(), '加载期间输入', 'startup hydration must not overwrite an attempted edit');
    await context.close();
  }

  {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.addInitScript(() => {
      const nativeSetTimeout = window.setTimeout.bind(window);
      window.setTimeout = (callback, delay, ...args) => nativeSetTimeout(callback, delay === 6000 ? 100 : delay, ...args);
    });
    await routePage(page, {
      async reviewDraft(route, request) {
        if (request.method() === 'GET') {
          await new Promise(resolve => setTimeout(resolve, 500));
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
            ok: true,
            draft: { reviewDate: today, version: 1, updatedAt: '2026-07-15T08:00:00.000Z', record: record(today, '迟到云端值') }
          }) });
          return;
        }
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false }) });
      }
    });
    await page.goto('https://review.example.com/', { waitUntil: 'domcontentloaded' });
    await page.locator('#rightThing').fill('超时后继续编辑', { timeout: 300 });
    assert.equal(await page.locator('#rightThing').inputValue(), '超时后继续编辑');
    await context.close();
  }

  {
    const context = await browser.newContext();
    const page = await context.newPage();
    let cloud = { reviewDate: today, version: 5, updatedAt: '2026-07-15T08:00:00.000Z', record: record(today, '已同步内容') };
    await routePage(page, {
      async reviewDraft(route, request) {
        if (request.method() === 'GET') {
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, draft: cloud }) });
          return;
        }
        throw new Error('a clean page should not write during this scenario');
      }
    });
    await page.goto('https://review.example.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('rightThing')?.value === '已同步内容');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('tradeReviewDataV3')).dirty), false);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
    assert.equal(
      await page.evaluate(() => JSON.parse(localStorage.getItem('tradeReviewDataV3')).dirty),
      false,
      'hiding an unchanged clean page must not manufacture an offline conflict'
    );
    cloud = { reviewDate: today, version: 6, updatedAt: '2026-07-15T08:02:00.000Z', record: record(today, '另一设备更新') };
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('rightThing')?.value === '另一设备更新');
    assert.equal(await page.evaluate(() => localStorage.getItem('tradeReviewDraftConflictV1')), null);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('tradeReviewDataV3')).dirty), false);
    await context.close();
  }

  {
    const context = await browser.newContext();
    const page = await context.newPage();
    const drafts = new Map([
      [today, { reviewDate: today, version: 1, updatedAt: '2026-07-15T08:00:00.000Z', record: record(today, '7月15日云端') }],
      ['2026-07-14', { reviewDate: '2026-07-14', version: 4, updatedAt: '2026-07-14T08:00:00.000Z', record: record('2026-07-14', '7月14日云端') }]
    ]);
    const writes = [];
    await routePage(page, {
      async reviewDraft(route, request, url) {
        if (request.method() === 'GET') {
          const draft = drafts.get(url.searchParams.get('date'));
          await route.fulfill({ status: draft ? 200 : 404, contentType: 'application/json', body: JSON.stringify(draft ? { ok: true, draft } : { ok: false }) });
          return;
        }
        const payload = request.postDataJSON();
        writes.push(payload);
        const current = drafts.get(payload.reviewDate);
        const draft = {
          reviewDate: payload.reviewDate,
          version: Number(current?.version || 0) + 1,
          updatedAt: new Date().toISOString(),
          record: payload.record
        };
        drafts.set(payload.reviewDate, draft);
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, draft }) });
      }
    });
    await page.goto('https://review.example.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('rightThing')?.value === '7月15日云端');
    await page.locator('#rightThing').fill('7月15日本机修改');
    await page.waitForFunction(() => document.getElementById('autosaveStatus')?.textContent.includes('已保存到云端'));

    await page.locator('#date').fill('2026-07-14');
    await page.locator('#date').press('Tab');
    await page.waitForFunction(() => document.getElementById('rightThing')?.value === '7月14日云端');
    await page.waitForTimeout(800);
    assert.ok(!writes.some(item => item.reviewDate === '2026-07-14' && item.record.reflection.rightThing === '7月15日本机修改'));

    await page.locator('#rightThing').fill('7月14日本机修改');
    await page.waitForFunction(() => document.getElementById('autosaveStatus')?.textContent.includes('已保存到云端'));
    const lastWrite = writes.at(-1);
    assert.equal(lastWrite.reviewDate, '2026-07-14');
    assert.equal(lastWrite.record.date, '2026-07-14');
    assert.equal(lastWrite.record.reflection.rightThing, '7月14日本机修改');
    await context.close();
  }
} finally {
  await browser.close();
}

console.log('PASS cloud draft recovery, hydration, and date isolation');
