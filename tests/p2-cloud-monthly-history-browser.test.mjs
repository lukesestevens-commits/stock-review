import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('/Users/ruiqiwang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const html = await fs.readFile(new URL('../index.html', import.meta.url), 'utf8');

const julyDrafts = [
  {
    reviewDate: '2026-07-15',
    version: 3,
    updatedAt: '2026-07-15T08:30:00.000Z',
    record: {
      date: '2026-07-15',
      basic: { capital: '100000', position: '8成', pnl: '+1200' },
      market: { mainLines: '半导体', marketOne: '主线核心抱团' },
      trades: [
        {
          accountRef: 'account-a', sequenceId: 'trade-a', code: '301308',
          name: '江波龙', time: '10:15', side: '买入', amount: '10000',
          reason: '按计划执行', planScore: 2, lineScore: 1.5, riskScore: 1.5, score: 8
        },
        {
          accountRef: 'account-a', sequenceId: 'trade-b', code: '000001',
          name: '平安银行', time: '13:20', side: '买入', amount: '8000',
          reason: '价格下跌后加仓', planScore: 0.5, lineScore: 1, riskScore: 0.5,
          score: 4, downwardAverage: true
        }
      ],
      holdings: [],
      reflection: {},
      plan: {},
      stats: {}
    }
  },
  {
    reviewDate: '2026-07-14',
    version: 2,
    updatedAt: '2026-07-14T08:20:00.000Z',
    record: {
      date: '2026-07-14',
      basic: { capital: '100000', position: '5成', pnl: '-300' },
      market: { mainLines: 'PCB', marketOne: '开盘分化' },
      trades: [
        {
          accountRef: 'account-a', sequenceId: 'trade-c', code: '002185',
          name: '华天科技', time: '09:40', side: '买入', amount: '20000',
          reason: '开盘临盘起意', planScore: 0.5, lineScore: 1.5, riskScore: 1,
          score: 6
        }
      ],
      holdings: [],
      reflection: {},
      plan: {},
      stats: {}
    }
  }
];

const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const page = await context.newPage();
  await page.addInitScript(() => {
    const NativeDate = Date;
    const fixedNow = NativeDate.parse('2026-07-15T08:00:00.000Z');
    class FixedDate extends NativeDate {
      constructor(...args) {
        super(...(args.length ? args : [fixedNow]));
      }
      static now() { return fixedNow; }
    }
    FixedDate.parse = NativeDate.parse;
    FixedDate.UTC = NativeDate.UTC;
    window.Date = FixedDate;
  });

  const historyRequests = [];
  let delayNextJuly = false;
  await page.route('https://review.example.com/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/' || url.pathname === '/index.html') {
      await route.fulfill({ status: 200, contentType: 'text/html', body: html });
      return;
    }
    if (url.pathname === '/api/review-drafts') {
      const range = {
        from: url.searchParams.get('from'),
        to: url.searchParams.get('to'),
        limit: url.searchParams.get('limit')
      };
      historyRequests.push(range);
      if (delayNextJuly && range.from === '2026-07-01') {
        delayNextJuly = false;
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
      const drafts = range.from === '2026-07-01' && range.to === '2026-07-31' ? julyDrafts : [];
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, from: range.from, to: range.to, drafts })
      });
      return;
    }
    if (url.pathname === '/api/review-draft') {
      await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false }) });
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

  const month = page.locator('#historyMonth');
  await month.waitFor({ state: 'visible', timeout: 2500 });
  assert.equal(await month.getAttribute('type'), 'month');
  assert.equal(await month.inputValue(), '2026-07', 'the current month should load automatically');
  await page.waitForFunction(() => document.getElementById('monthReviewDays')?.textContent.trim() === '2');

  assert.deepEqual(historyRequests[0], {
    from: '2026-07-01',
    to: '2026-07-31',
    limit: '62'
  }, 'private history should request exactly the selected calendar month');
  assert.equal((await page.locator('#monthTradeCount').textContent()).trim(), '3');
  assert.match(await page.locator('#monthTotalPnl').textContent(), /900/);
  assert.match(await page.locator('#monthAvgScore').textContent(), /6(?:\.0)?/);
  assert.equal((await page.locator('#monthLowQuality').textContent()).trim(), '1');
  assert.equal((await page.locator('#monthUnplanned').textContent()).trim(), '2');

  const recordText = await page.locator('#historyRecordList').innerText();
  assert.match(recordText, /2026-07-15/);
  assert.match(recordText, /江波龙/);
  assert.match(recordText, /2026-07-14/);
  assert.match(recordText, /华天科技/);

  const disciplineText = await page.locator('#historyDisciplineList').innerText();
  assert.match(disciplineText, /向下加仓/);
  assert.match(disciplineText, /开盘/);

  await month.fill('2026-06');
  await month.dispatchEvent('change');
  await page.waitForFunction(() => (
    document.getElementById('historyMonth')?.value === '2026-06'
    && document.getElementById('monthReviewDays')?.textContent.trim() === '0'
  ));
  assert.ok(historyRequests.some((request) => (
    request.from === '2026-06-01'
    && request.to === '2026-06-30'
    && request.limit === '62'
  )), 'switching months should request the exact June calendar range');

  delayNextJuly = true;
  await month.fill('2026-07');
  await month.dispatchEvent('change');
  await page.waitForFunction(() => document.getElementById('historyCloudStatus')?.textContent.includes('2026-07'));
  await month.fill('2026-06');
  await month.dispatchEvent('change');
  await page.waitForTimeout(750);
  assert.equal(await month.inputValue(), '2026-06');
  assert.equal((await page.locator('#monthReviewDays').textContent()).trim(), '0', 'a late July response must not overwrite June metrics');
  assert.doesNotMatch(await page.locator('#historyRecordList').innerText(), /2026-07-14/, 'late records must stay isolated to their requested month');

  await context.close();
} finally {
  await browser.close();
}

console.log('PASS private cloud monthly history browser flow');
