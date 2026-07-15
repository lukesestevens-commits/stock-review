import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('/Users/ruiqiwang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const html = await fs.readFile(new URL('../index.html', import.meta.url), 'utf8');
const today = '2026-07-15';
const priorDay = '2026-07-14';

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

function verifiedPriorDayCapture() {
  return {
    ok: true,
    dailyReview: {
      date: priorDay,
      reviewDate: priorDay,
      basic: { capital: '100000', position: '5成', pnl: '120' },
      market: {},
      trades: [],
      holdings: [],
      reflection: {},
      plan: {}
    },
    audit: {
      status: 'verified',
      reviewDate: priorDay,
      captureDate: today,
      capturedAt: `${today}T00:20:00.000Z`,
      verifiedAt: `${today}T00:20:00.000Z`,
      issueCodes: [],
      warnings: []
    }
  };
}

const drafts = new Map([
  [today, {
    reviewDate: today,
    version: 1,
    updatedAt: `${today}T00:00:00.000Z`,
    record: record(today, '今日云端草稿')
  }],
  [priorDay, {
    reviewDate: priorDay,
    version: 4,
    updatedAt: `${priorDay}T08:00:00.000Z`,
    record: record(priorDay, '上一日手工备注')
  }]
]);
const writes = [];

const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  await page.route('https://review.example.com/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/' || url.pathname === '/index.html') {
      await route.fulfill({ status: 200, contentType: 'text/html', body: html });
      return;
    }
    if (url.pathname === '/api/review-draft' && request.method() === 'GET') {
      const draft = drafts.get(url.searchParams.get('date'));
      await route.fulfill({
        status: draft ? 200 : 404,
        contentType: 'application/json',
        body: JSON.stringify(draft ? { ok: true, draft } : { ok: false })
      });
      return;
    }
    if (url.pathname === '/api/review-draft' && request.method() === 'PUT') {
      const payload = request.postDataJSON();
      writes.push(payload);
      const current = drafts.get(payload.reviewDate);
      if (payload.expectedVersion !== Number(current?.version || 0)) {
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({ ok: false, current })
        });
        return;
      }
      const draft = {
        reviewDate: payload.reviewDate,
        version: Number(current?.version || 0) + 1,
        updatedAt: new Date().toISOString(),
        record: payload.record
      };
      drafts.set(payload.reviewDate, draft);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, draft }) });
      return;
    }
    if (url.pathname === '/api/sync/latest') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(verifiedPriorDayCapture()) });
      return;
    }
    if (url.pathname === '/api/market-snapshot') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, market: null }) });
      return;
    }
    await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false }) });
  });

  await page.goto('https://review.example.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('date')?.value === '2026-07-14');
  await page.waitForFunction(() => document.getElementById('autosaveStatus')?.textContent.includes('已保存到云端'));

  const priorWrites = writes.filter(item => item.reviewDate === priorDay);
  assert.equal(priorWrites.length, 1, '跨日收盘导入应只写入一次目标日草稿');
  assert.equal(priorWrites[0].expectedVersion, 4, '导入前必须读取目标日的云端版本');
  assert.equal(priorWrites[0].record.reflection.rightThing, '上一日手工备注', '收盘数据不得覆盖目标日手工备注');
  assert.equal(await page.evaluate(() => localStorage.getItem('tradeReviewDraftConflictV1')), null, '正常跨日导入不应制造云端冲突');
} finally {
  await browser.close();
}

console.log('PASS cross-date verified capture hydrates the target cloud draft before import');
