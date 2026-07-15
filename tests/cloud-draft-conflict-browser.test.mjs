import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('/Users/ruiqiwang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const html = await fs.readFile(new URL('../index.html', import.meta.url), 'utf8');
const reviewDate = '2026-07-15';

function record(rightThing) {
  return {
    date: reviewDate,
    basic: {},
    market: {},
    trades: [],
    holdings: [],
    reflection: { rightThing, bigMistake: '' },
    plan: {},
    stats: {}
  };
}

let cloudDraft = {
  reviewDate,
  version: 1,
  updatedAt: '2026-07-15T08:00:00.000Z',
  record: record('云端第一版')
};
let putCount = 0;

const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  page.on('dialog', dialog => dialog.accept());
  await page.route('https://review.example.com/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/' || url.pathname === '/index.html') {
      await route.fulfill({ status: 200, contentType: 'text/html', body: html });
      return;
    }
    if (url.pathname === '/api/review-draft' && request.method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, draft: cloudDraft })
      });
      return;
    }
    if (url.pathname === '/api/review-draft' && request.method() === 'PUT') {
      putCount += 1;
      const payload = request.postDataJSON();
      if (putCount === 1) {
        cloudDraft = {
          reviewDate,
          version: 2,
          updatedAt: '2026-07-15T08:01:00.000Z',
          record: record('另一设备新版')
        };
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({ ok: false, error: '云端已有更新的草稿。', current: cloudDraft })
        });
        return;
      }
      assert.equal(payload.expectedVersion, 2, 'manual conflict resolution must target the current cloud version');
      cloudDraft = {
        reviewDate,
        version: 3,
        updatedAt: '2026-07-15T08:02:00.000Z',
        record: payload.record
      };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, draft: cloudDraft })
      });
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

  await page.goto('https://review.example.com/', { waitUntil: 'domcontentloaded' });
  await page.locator('#rightThing').fill('本机冲突版');
  await page.waitForFunction(() => document.getElementById('autosaveStatus')?.textContent.includes('云端有更新版本'));
  assert.equal(putCount, 1);
  assert.ok(
    await page.evaluate(() => localStorage.getItem('tradeReviewDraftConflictV1')),
    'the conflict must survive a refresh'
  );

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);
  assert.equal(await page.locator('#rightThing').inputValue(), '本机冲突版', 'the local conflicting draft stays visible');
  assert.equal(putCount, 1, 'refresh must not silently overwrite the newer cloud draft');
  assert.match(await page.locator('#autosaveStatus').textContent(), /手动保存.*确认覆盖/);

  await page.locator('#manualDraftSaveButton').click();
  await page.waitForFunction(() => document.getElementById('autosaveStatus')?.textContent.includes('已保存到云端'));
  assert.equal(putCount, 2);
  assert.equal(cloudDraft.record.reflection.rightThing, '本机冲突版');
  assert.equal(await page.evaluate(() => localStorage.getItem('tradeReviewDraftConflictV1')), null);
} finally {
  await browser.close();
}

console.log('PASS cloud draft conflict survives refresh and requires manual resolution');
