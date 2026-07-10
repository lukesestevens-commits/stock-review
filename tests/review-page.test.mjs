import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const htmlPath = new URL('../index.html', import.meta.url);
const html = fs.readFileSync(htmlPath, 'utf8');
const scriptMatch = html.match(/<script>([\s\S]*)<\/script>/);
assert.ok(scriptMatch, 'HTML should contain an inline script');

const storage = new Map();
const context = {
  console,
  alert() {},
  confirm() { return true; },
  Blob: class Blob {},
  URL: Object.assign(URL, { createObjectURL() { return 'blob:test'; }, revokeObjectURL() {} }),
  setTimeout(fn) { if (typeof fn === 'function') fn(); },
  localStorage: {
    getItem(key) { return storage.has(key) ? storage.get(key) : null; },
    setItem(key, value) { storage.set(key, String(value)); },
    removeItem(key) { storage.delete(key); }
  },
  navigator: { clipboard: { writeText: async () => {} } },
  location: {
    protocol: 'https:',
    hostname: 'review.example.com',
    origin: 'https://review.example.com'
  },
  document: {
    addEventListener() {},
    createElement() {
      return {
        style: {},
        click() {},
        set href(value) { this._href = value; },
        get href() { return this._href; },
        set download(value) { this._download = value; }
      };
    },
    querySelectorAll() { return []; },
    getElementById() {
      return {
        value: '',
        textContent: '',
        innerHTML: '',
        style: {},
        appendChild() {},
        querySelectorAll() { return []; }
      };
    }
  },
  window: { scrollTo() {} }
};
context.window = { ...context.window, localStorage: context.localStorage };
vm.createContext(context);
vm.runInContext(scriptMatch[1], context);

function test(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

test('parseOcrText extracts PC-style trades and asset fields', () => {
  assert.equal(typeof context.parseOcrText, 'function');
  const result = context.parseOcrText(`
成交时间 证券名称 操作 成交价格 成交数量 成交金额
09:31:08 江波龙 买入 88.50 100 8850.00
13:42:19 中际旭创 卖出 145.20 200 29040.00
总资产 205000.35 今日盈亏 +1280.55 持仓市值 102500.00
  `, { layout: 'pc' });

  assert.equal(result.trades.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(result.trades[0])), {
    time: '09:31',
    name: '江波龙',
    side: '买入',
    price: '88.50',
    qty: '100',
    amount: '8850.00',
    confidence: 'high'
  });
  assert.equal(result.asset.capital, '205000.35');
  assert.equal(result.asset.pnl, '+1280.55');
  assert.equal(result.asset.position, '5成');
});

test('parseOcrText extracts mobile-style card trades', () => {
  const result = context.parseOcrText(`
江波龙
买入 成交价 88.50 成交数量 100 成交金额 8850.00
成交时间 09:31:08
中际旭创
卖出 成交价格 145.20 数量 200 金额 29040.00 时间 13:42:19
  `, { layout: 'mobile' });

  assert.equal(result.trades.length, 2);
  assert.equal(result.trades[0].name, '江波龙');
  assert.equal(result.trades[1].side, '卖出');
  assert.equal(result.trades[1].time, '13:42');
});

test('buildQualityInsights flags weak review quality and risk', () => {
  assert.equal(typeof context.buildQualityInsights, 'function');
  const insights = context.buildQualityInsights({
    capital: '100000',
    position: '满仓',
    trades: [
      { name: 'A股', side: '买入', amount: '22000', reason: '', score: 4.5, planScore: 0.5 },
      { name: 'B股', side: '卖出', amount: '5000', reason: '按计划止盈', score: 8, planScore: 2 }
    ]
  });

  assert.equal(insights.stats.lowQuality, 1);
  assert.equal(insights.stats.unplanned, 1);
  assert.ok(insights.warnings.some(item => item.includes('理由')));
  assert.ok(insights.warnings.some(item => item.includes('单笔金额')));
  assert.ok(insights.discipline.includes('计划外'));
});

test('summarizeHistory calculates 7-day and 30-day trends', () => {
  assert.equal(typeof context.summarizeHistory, 'function');
  const records = Array.from({ length: 8 }, (_, index) => ({
    date: `2026-06-${String(index + 1).padStart(2, '0')}`,
    stats: {
      avgScore: index + 1,
      lowQuality: index % 2,
      unplanned: index % 3 === 0 ? 1 : 0
    },
    basic: { pnl: index % 2 ? '+100' : '-50' }
  }));

  const summary = context.summarizeHistory(records);
  assert.equal(summary.count, 8);
  assert.equal(summary.last7.avgScore, '5.0');
  assert.equal(summary.last30.lowQuality, 4);
  assert.equal(summary.pnlPositiveDays, 4);
});

test('auto import retries market fill after the same TZZB capture was already imported', () => {
  assert.match(
    scriptMatch[1],
    /if\(data\.latestReceivedAt === lastTzzbImportedAt\)\{[\s\S]*importMarketSnapshot\(\{silent:true\}\)[\s\S]*return;/,
    'auto import should keep retrying market fields even when the same capture was already imported'
  );
});

test('page exposes a holding review module for tomorrow planning', () => {
  assert.match(html, /id="holdingTable"/, 'holding review table should exist');
  assert.match(scriptMatch[1], /function addHoldingReviewRow/, 'holding rows should be renderable');
  assert.match(scriptMatch[1], /function collectHoldingPlan/, 'holding plans should be saved and exported');
});

test('trade scoring uses three core dimensions and folds mechanical details', () => {
  assert.doesNotMatch(html, /<th>买卖点<\/th>/, 'trade table should remove the old timing score column');
  assert.doesNotMatch(html, /<th>仓位<\/th>/, 'trade table should remove the old size score column');
  assert.doesNotMatch(scriptMatch[1], /timingScore|sizeScore/, 'trade data should no longer depend on old score dimensions');
  assert.match(scriptMatch[1], /scoreFromCoreDimensions/, '10-point score should be derived from the three core dimensions');
  assert.match(html, /class="trade-detail-toggle"/, 'price and quantity should be folded under trade details');
});

test('secondary tools are folded below the main workflow', () => {
  assert.match(html, /<details class="secondary-tools"/, 'OCR and quote should live in a collapsible secondary area');
  assert.doesNotMatch(html, /<button class="btn-hero" onclick="openOcrModal\(\)">/, 'hero should not promote OCR as a primary action');
});

test('reflection section keeps only right and wrong fields', () => {
  assert.match(html, /id="rightThing"/, 'reflection should keep the did-right field');
  assert.match(html, /id="bigMistake"/, 'reflection should keep the did-wrong field');
  assert.doesNotMatch(html, /id="worstTrade"/, 'reflection should remove the worst-trade field');
  assert.doesNotMatch(html, /id="discipline"/, 'reflection should remove the discipline field');
  assert.doesNotMatch(html, /最不该做的一笔/, 'reflection copy should remove worst-trade wording');
  assert.doesNotMatch(html, /明天最需要遵守的一条纪律/, 'reflection copy should remove discipline wording');
});

test('page exposes cloud sync configuration controls', () => {
  assert.match(html, /id="tzzbSyncMode"/, 'sync mode selector should exist');
  assert.match(html, /id="tzzbCloudSyncBaseUrl"/, 'cloud sync base URL input should exist');
  assert.match(html, /id="tzzbCloudSyncKey"/, 'cloud sync access key input should exist');
  assert.match(scriptMatch[1], /function saveTzzbSyncConfig/, 'page should save sync configuration locally');
});

test('hosted page defaults to same-origin cloud sync', () => {
  const config = context.getTzzbSyncConfig();
  assert.equal(config.mode, 'cloud');
  assert.equal(config.baseUrl, 'https://review.example.com');
  assert.equal(config.key, '');
  assert.equal(context.tzzbSyncSourceLabel(config), '云端同步');
});

test('market snapshots do not downgrade live board directions to fallback rankings', () => {
  assert.equal(context.marketSnapshotQuality({ boardQuality: 'live' }), 2);
  assert.equal(context.marketSnapshotQuality({ boardQuality: 'fallback' }), 1);
  assert.equal(context.shouldApplyMarketSnapshot({ boardQuality: 'live' }), true);
  assert.equal(context.shouldApplyMarketSnapshot({ boardQuality: 'fallback' }), false);
  assert.equal(context.shouldApplyMarketSnapshot({ boardQuality: 'live' }), true);
});

await assert.rejects(
  () => context.fetchTzzbApi('/api/tzzb-health'),
  /访问码/,
  'hosted mode should ask for the cloud access key instead of falling back to localhost'
);

storage.set('tzzbSyncModeV1', 'cloud');
storage.set('tzzbCloudSyncBaseUrlV1', 'https://review-cloud.example.com/');
storage.set('tzzbCloudSyncKeyV1', 'abc123');
const cloudRequests = [];
context.fetch = async (url, options) => {
  cloudRequests.push({ url, options });
  return { ok: true, json: async () => ({ ok: true }) };
};

const latest = await context.fetchTzzbApi('/api/tzzb-latest');
assert.equal(latest.data.ok, true);
assert.equal(
  cloudRequests[0].url,
  'https://review-cloud.example.com/api/sync/latest',
  'cloud mode should map latest import reads to the deployed sync API'
);
assert.equal(
  cloudRequests[0].options.headers['X-TZZB-Sync-Key'],
  'abc123',
  'cloud mode should send the access key in a request header'
);

await context.fetchTzzbApi('/api/tzzb-health');
assert.equal(
  cloudRequests[1].url,
  'https://review-cloud.example.com/api/sync/health',
  'cloud mode should map helper health reads to cloud sync health'
);

console.log('PASS cloud sync fetch config');
