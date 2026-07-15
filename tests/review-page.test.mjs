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

test('market snapshots refresh independently from verified review polling', () => {
  const autoImportSource = scriptMatch[1].match(
    /async function autoImportLatestTzzbData\([^)]*\)\{([\s\S]*?)\n\}\nfunction scheduleTzzbAutoImport/
  );
  assert.ok(autoImportSource, 'verified-review auto-import function should exist');
  assert.doesNotMatch(
    autoImportSource[1],
    /importMarketSnapshot/,
    'review polling should not call the public market API'
  );
  assert.match(scriptMatch[1], /setTimeout\(autoImportLatestTzzbData, 30000\)/);
  assert.doesNotMatch(scriptMatch[1], /setInterval\(autoImportLatestTzzbData, 3000\)/);
  assert.match(scriptMatch[1], /setInterval\(autoImportMarketSnapshot, 60000\)/);
  assert.match(scriptMatch[1], /startTzzbAutoImport\(\);[\s\S]*startMarketAutoImport\(\);/);
  assert.match(scriptMatch[1], /addEventListener\(['"]focus['"],\s*autoImportLatestTzzbData\)/);
  const healthSource = scriptMatch[1].match(
    /async function checkTzzbHelperHealth\(\)\{([\s\S]*?)\n\}\nfunction tzzbMissingMessage/
  );
  assert.ok(healthSource);
  assert.doesNotMatch(
    healthSource[1],
    /autoImportLatestTzzbData/,
    'hosted startup should read latest once instead of issuing a health/latest double request'
  );
  assert.match(
    scriptMatch[1],
    /const reviewDate = document\.getElementById\('date'\)[\s\S]*const applied = await importMarketSnapshot\(\{silent:true,reviewDate\}\);[\s\S]*if\(applied\) setTzzbImportStatus/,
    'market refresh should only announce snapshots that changed the form'
  );
  assert.match(html, /id="marketSyncStatus"[\s\S]*role="status"/, 'market auto-fill should expose a dedicated synchronization status');
});

test('page exposes a holding review module for tomorrow planning', () => {
  assert.match(html, /id="holdingTable"/, 'holding review table should exist');
  assert.match(scriptMatch[1], /function addHoldingReviewRow/, 'holding rows should be renderable');
  assert.match(scriptMatch[1], /function collectHoldingPlan/, 'holding plans should be saved and exported');
});

test('tomorrow planning is consolidated into the holding review module', () => {
  const holdingIndex = html.indexOf('<h2>持仓复盘与明日预案</h2>');
  const reflectionIndex = html.indexOf('<h2>今日反思</h2>');
  const newPlanIndex = html.indexOf('id="newPlan"');
  const banRuleIndex = html.indexOf('id="banRule"');
  assert.ok(holdingIndex >= 0 && reflectionIndex > holdingIndex, 'holding and reflection sections should remain ordered');
  assert.ok(newPlanIndex > holdingIndex && newPlanIndex < reflectionIndex, 'new-position planning should live inside the holding module');
  assert.ok(banRuleIndex > holdingIndex && banRuleIndex < reflectionIndex, 'tomorrow ban should live inside the holding module');
  assert.doesNotMatch(html, /<h2>明日操作计划<\/h2>/, 'standalone tomorrow-plan section should be removed');
  assert.doesNotMatch(html, /id="corePlan"|id="noisePlan"|id="selfTalk"/, 'duplicate and nonessential plan fields should be removed');
  assert.doesNotMatch(html, /生成明日计划/, 'holding plans should not be copied into duplicate summary fields');
  assert.doesNotMatch(scriptMatch[1], /function syncHoldingPlanToTomorrow/, 'duplicate plan generator should be removed');
  const plan = JSON.parse(JSON.stringify(context.collectStructured().plan));
  assert.deepEqual(Object.keys(plan).sort(), ['banRule', 'newPlan'], 'saved plans should keep only the two global tomorrow fields');
  assert.doesNotMatch(scriptMatch[1], /八、明日操作计划/, 'text export should merge tomorrow fields into the holding section');
});

test('trade scoring uses six compact user-facing columns', () => {
  assert.doesNotMatch(html, /<th>买卖点<\/th>/, 'trade table should remove the old timing score column');
  assert.doesNotMatch(html, /<th>仓位<\/th>/, 'trade table should remove the old size score column');
  assert.doesNotMatch(scriptMatch[1], /timingScore|sizeScore/, 'trade data should no longer depend on old score dimensions');
  assert.match(scriptMatch[1], /scoreFromCoreDimensions/, '10-point score should be derived from the three core dimensions');
  const tradeHead = html.match(/<table id="tradeTable">[\s\S]*?<thead>([\s\S]*?)<\/thead>/)?.[1] || '';
  const headerLabels = [...tradeHead.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)]
    .map((match) => match[1].replace(/<[^>]+>/g, '').trim());
  assert.deepEqual(
    headerLabels,
    ['时间', '股票/ETF', '成交', '复盘', '交易质量', '操作'],
    'trade table should expose six compact semantic columns'
  );
  assert.match(tradeHead, /<th[^>]*>成交<\/th>/, 'side, price, quantity and amount should share one table header');
  assert.doesNotMatch(tradeHead, /<th[^>]*>买\/卖<\/th>|<th[^>]*>金额<\/th>|<th[^>]*>明细<\/th>|<th[^>]*>模式<\/th>|<th[^>]*>理由<\/th>|<th[^>]*>计划性<\/th>|<th[^>]*>主线<\/th>|<th[^>]*>风控<\/th>|<th[^>]*>总分<\/th>/, 'details and score dimensions should not become separate wide columns');
  const addTradeBody = scriptMatch[1].match(/function addTrade\(data=\{\}\)\{([\s\S]*?)\n\}\nfunction calcAmount/)?.[1] || '';
  assert.match(addTradeBody, /class="trade-execution-cell"/, 'transaction fields should share one table cell');
  assert.match(addTradeBody, /class="trade-review-cell"[\s\S]*class="trade-mode"[\s\S]*class="trade-reason"/, 'mode and reason should share one review cell');
  assert.match(addTradeBody, /class="trade-quality-cell"[\s\S]*计划[\s\S]*主线[\s\S]*风控[\s\S]*class="rowScore"/, 'three score dimensions and total should share one quality cell');
  assert.match(addTradeBody, /class="trade-primary-grid"[\s\S]*class="trade-side"[\s\S]*class="trade-price"/, 'side and price should remain visible');
  assert.match(addTradeBody, /<details class="trade-detail-toggle">[\s\S]*aria-label="展开数量、金额和行为标记"[\s\S]*明细[\s\S]*class="trade-qty"[\s\S]*class="trade-amount"[\s\S]*class="trade-flag-grid"[\s\S]*<\/details>/, 'quantity, amount and explicit risk flags should share one compact folded detail area');
  assert.match(addTradeBody, /tr\.dataset\.accountRef/, 'trade rows should retain the account identity used for stable cloud revisions');
  assert.match(addTradeBody, /tr\.dataset\.sequenceId/, 'trade rows should retain the broker sequence id used for stable cloud revisions');
  assert.match(addTradeBody, /tr\.dataset\.code/, 'trade rows should retain the security code used by fallback matching');
  const collectTradeBody = scriptMatch[1].match(/function getTradeRowsData\(\)\{([\s\S]*?)\n\}\nfunction buildQualityInsights/)?.[1] || '';
  assert.match(collectTradeBody, /accountRef:\s*tr\.dataset\.accountRef/, 'saved local drafts should carry account identity across imports');
  assert.match(collectTradeBody, /sequenceId:\s*tr\.dataset\.sequenceId/, 'saved local drafts should carry the broker sequence id across imports');
  assert.match(collectTradeBody, /code:\s*tr\.dataset\.code/, 'saved local drafts should carry the security code across imports');
});

test('verified cloud revisions preserve local trade and holding review fields', () => {
  const mergedTrades = context.mergeSyncedTrades([
    {
      accountRef: 'account-a', sequenceId: 'trade-1', code: '000001', name: '平安银行',
      time: '10:01:02', side: '买入', price: '10.20', qty: '200', amount: '2040.00',
      mode: '趋势波段', reason: '', planScore: 1, lineScore: 1, riskScore: 1
    },
    {
      code: '600000', name: '浦发银行', time: '14:31:08', side: '卖出',
      price: '9.80', qty: '100', amount: '980.00', reason: ''
    }
  ], [
    {
      accountRef: 'account-a', sequenceId: 'trade-1', code: '000001', name: '平安银行',
      time: '09:59:00', side: '买入', price: '10.00', qty: '100', amount: '1000.00',
      mode: 'ETF主线', reason: '突破后按计划加仓', planScore: 2, lineScore: 1.5, riskScore: 2,
      downwardAverage: true, lossReentry: true
    },
    {
      code: '600000', name: '浦发银行', time: '14:31:08', side: '卖出',
      price: '9.80', qty: '100', amount: '980.00', mode: '止盈/止损',
      reason: '跌破预案位', planScore: 1.5, lineScore: 2, riskScore: 1.5
    }
  ]);
  assert.equal(mergedTrades[0].time, '10:01:02', 'new verified automatic trade fields should win');
  assert.equal(mergedTrades[0].qty, '200', 'new verified quantities should win');
  assert.equal(mergedTrades[0].mode, 'ETF主线');
  assert.equal(mergedTrades[0].reason, '突破后按计划加仓');
  assert.equal(mergedTrades[0].planScore, 2);
  assert.equal(mergedTrades[0].downwardAverage, true, 'explicit discipline flags should survive verified cloud revisions');
  assert.equal(mergedTrades[0].lossReentry, true, 'loss re-entry review evidence should remain manual data');
  assert.equal(mergedTrades[1].reason, '跌破预案位', 'fallback trade identity should preserve manual fields');

  const mergedHoldings = context.mergeSyncedHoldings([
    { code: '000001', name: '平安银行', value: '2500.00', weight: '2.50%', isCore: '待判断', logic: '', tomorrowAction: '观察', trigger: '' },
    { name: '无代码持仓', value: '1000.00', weight: '1.00%' }
  ], [
    { code: '000001', name: '平银', value: '2000.00', weight: '2.00%', isCore: '核心', logic: '主线承接未坏', tomorrowAction: '持有', trigger: '跌破5日线减仓' },
    { name: '无代码持仓', value: '900.00', weight: '0.90%', isCore: '非核心', logic: '仅观察', tomorrowAction: '减仓', trigger: '冲高减仓' }
  ]);
  assert.equal(mergedHoldings[0].value, '2500.00', 'new verified holding values should win');
  assert.equal(mergedHoldings[0].weight, '2.50%', 'new verified total-asset weights should win');
  assert.equal(mergedHoldings[0].isCore, '核心');
  assert.equal(mergedHoldings[0].logic, '主线承接未坏');
  assert.equal(mergedHoldings[0].tomorrowAction, '持有');
  assert.equal(mergedHoldings[0].trigger, '跌破5日线减仓');
  assert.equal(mergedHoldings[1].logic, '仅观察', 'holding name should be used only when no code is available');

  assert.deepEqual(
    JSON.parse(JSON.stringify(context.mergeSyncedSection(
      { indexState: '指数强', mood: '', mainLines: undefined },
      { indexState: '指数弱', mood: '退潮', mainLines: '传媒' }
    ))),
    { indexState: '指数强', mood: '退潮', mainLines: '传媒' },
    'empty cloud section fields should not erase a same-day local draft'
  );
});

test('secondary tools are folded below the main workflow', () => {
  assert.match(html, /<details class="secondary-tools"/, 'OCR and quote should live in a collapsible secondary area');
  assert.doesNotMatch(html, /<button class="btn-hero" onclick="openOcrModal\(\)">/, 'hero should not promote OCR as a primary action');
});

test('mobile shell declares edge-to-edge iPhone safe-area coverage', () => {
  assert.match(html, /name="viewport" content="[^"]*viewport-fit=cover/, 'viewport should enable edge-to-edge iPhone layout');
  assert.match(html, /env\(safe-area-inset-top\)/, 'mobile shell should avoid the top sensor area');
  assert.match(html, /env\(safe-area-inset-right\)/, 'mobile shell should avoid the right safe area');
  assert.match(html, /env\(safe-area-inset-bottom\)/, 'mobile shell should avoid the Home indicator');
  assert.match(html, /env\(safe-area-inset-left\)/, 'mobile shell should avoid the left safe area');
});

test('reflection section keeps only right and wrong fields', () => {
  assert.match(html, /id="rightThing"/, 'reflection should keep the did-right field');
  assert.match(html, /id="bigMistake"/, 'reflection should keep the did-wrong field');
  assert.doesNotMatch(html, /id="worstTrade"/, 'reflection should remove the worst-trade field');
  assert.doesNotMatch(html, /id="discipline"/, 'reflection should remove the discipline field');
  assert.doesNotMatch(html, /最不该做的一笔/, 'reflection copy should remove worst-trade wording');
  assert.doesNotMatch(html, /明天最需要遵守的一条纪律/, 'reflection copy should remove discipline wording');
});

test('page exposes verified review status instead of cloud secrets', () => {
  assert.match(html, /id="tzzbReviewDate"/, 'verified review date should be visible');
  assert.match(html, /id="tzzbCapturedAt"/, 'capture time should be visible');
  assert.match(html, /id="tzzbVerificationState"/, 'verification state should be visible');
  assert.match(html, /id="tzzbReverseRepoValue"/, 'reverse-repo value should be visible');
  assert.match(html, /id="tzzbAuditReasons"/, 'audit reasons should be visible');
  assert.doesNotMatch(html, /id="tzzbSyncMode"/, 'hosted users should not choose a sync mode');
  assert.doesNotMatch(html, /id="tzzbCloudSyncBaseUrl"/, 'hosted users should not configure an API URL');
  assert.doesNotMatch(html, /id="tzzbCloudSyncKey"/, 'browser must not store a cloud access key');
  assert.doesNotMatch(scriptMatch[1], /STORAGE_TZZB_CLOUD_KEY|X-TZZB-Sync-Key/, 'read secrets must not enter browser code');
});

test('audit status renders useful Chinese reasons', () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.auditReasons({
      issueCodes: ['TRADE_HISTORY_INCOMPLETE'],
      warnings: [{ code: 'DISPLAY_PNL_MISMATCH' }]
    }, {
      audit: { issueCodes: ['ACTIVE_ACCOUNTS_MISSING'] }
    }))),
    ['成交明细或分页不完整', '账本展示盈亏与历史权威值不一致', '未识别到全部有效账户']
  );
});

test('pending attempt drives the status card while the form source remains latest verified', () => {
  const envelope = context.readVerifiedEnvelope({
    dailyReview: {
      reviewDate: '2026-07-14',
      capturedAt: '2026-07-14T08:20:00.000Z',
      basic: { pnl: '+2462.39' }
    },
    audit: {
      status: 'verified',
      reviewDate: '2026-07-14',
      capturedAt: '2026-07-14T08:20:00.000Z',
      issueCodes: []
    },
    pendingAttempt: {
      state: 'stored-unverified',
      reviewDate: '2026-07-15',
      capturedAt: '2026-07-15T08:10:00.000Z',
      audit: {
        status: 'held',
        reviewDate: '2026-07-15',
        capturedAt: '2026-07-15T08:10:00.000Z',
        issueCodes: ['TRADE_HISTORY_INCOMPLETE']
      }
    }
  });
  assert.equal(envelope.reviewDate, '2026-07-14', 'the import identity should remain the latest verified review');
  assert.equal(envelope.dailyReview.basic.pnl, '+2462.39', 'the form source must remain latest verified');
  assert.equal(envelope.displayReviewDate, '2026-07-15', 'the card should describe the newer pending attempt');
  assert.equal(envelope.displayCapturedAt, '2026-07-15T08:10:00.000Z');
  assert.deepEqual(JSON.parse(JSON.stringify(envelope.displayAudit.issueCodes)), ['TRADE_HISTORY_INCOMPLETE']);

  const statusElements = new Map();
  for(const id of ['tzzbReviewDate','tzzbCapturedAt','tzzbVerificationState','tzzbReverseRepoValue','tzzbAuditReasons','tzzbVerificationCard']){
    statusElements.set(id, { textContent: '', dataset: {} });
  }
  context.document.getElementById = (id) => statusElements.get(id) || null;
  context.renderTzzbVerification(envelope);
  assert.equal(statusElements.get('tzzbReviewDate').textContent, '2026-07-15');
  assert.match(statusElements.get('tzzbCapturedAt').textContent, /2026/);
  assert.equal(statusElements.get('tzzbVerificationState').textContent, '已保留旧版 · 新数据对账中');
  assert.equal(statusElements.get('tzzbAuditReasons').textContent, '成交明细或分页不完整');
  assert.equal(statusElements.get('tzzbVerificationCard').dataset.state, 'pending');
  assert.match(scriptMatch[1], /applyTzzbReviewData\(envelope\.dailyReview/, 'pending metadata must never be passed to the form importer');
});

test('hosted page defaults to same-origin cloud sync', () => {
  assert.doesNotMatch(
    html,
    /tzzbLastImportedAtV1|localStorage\.(?:getItem|setItem)\([^)]*TZZB_IMPORT/,
    'the import de-duplication marker must be page-memory only so a reload auto-fills again'
  );
  const config = context.getTzzbSyncConfig();
  assert.equal(config.mode, 'cloud');
  assert.equal(config.baseUrl, 'https://review.example.com');
  assert.equal(context.tzzbSyncSourceLabel(config), '云端同步');
});

test('drafts autosave locally and use the private cloud on hosted pages', () => {
  assert.match(html, /id="autosaveStatus"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.equal(typeof context.scheduleAutosave, 'function');
  assert.equal(typeof context.flushAutosave, 'function');
  assert.equal(typeof context.restoreDraftOnStartup, 'function');
  assert.equal(typeof context.loadCloudDraft, 'function');
  assert.match(scriptMatch[1], /\/api\/review-draft/);
  assert.match(scriptMatch[1], /addEventListener\(['"]pagehide['"]/);
  assert.match(scriptMatch[1], /visibilitychange/);
  assert.match(scriptMatch[1], /applyTzzbReviewData[\s\S]*scheduleAutosave\(\)/);
});

test('form controls and tables expose accessible names', () => {
  for (const id of [
    'date', 'capital', 'position', 'pnl', 'indexState', 'mood', 'actionEnv',
    'mainLines', 'marketOne', 'newPlan', 'banRule', 'rightThing', 'bigMistake'
  ]) {
    assert.match(html, new RegExp(`<label\\s+for=["']${id}["']`), `${id} should have a connected label`);
  }
  const headers = [...html.matchAll(/<th\b([^>]*)>/g)];
  assert.ok(headers.length > 0);
  assert.ok(headers.every((match) => /\bscope=["']col["']/.test(match[1])), 'every column header should declare scope');
  const addTradeBody = scriptMatch[1].match(/function addTrade\(data=\{\}\)\{([\s\S]*?)\n\}\nfunction calcAmount/)?.[1] || '';
  for (const label of [
    '交易时间', '股票或 ETF 名称', '买卖方向', '成交价格', '成交数量', '成交金额',
    '交易模式', '买卖理由', '删除此交易'
  ]) {
    assert.match(addTradeBody, new RegExp(`aria-label=["']${label}["']`), `${label} should be exposed`);
  }
  for (const label of ['计划性评分', '主线评分', '风控评分']) {
    assert.match(context.scoreSelect(1, label), new RegExp(`aria-label=["']${label}["']`));
  }
  for (const label of ['时间', '股票/ETF', '成交', '复盘', '交易质量', '操作']) {
    assert.match(addTradeBody, new RegExp(`data-label=["']${label}["']`), `mobile trade card should label ${label}`);
  }
});

test('market snapshot application requires complete cloud fields regardless of source quality', () => {
  const marketElements = new Map();
  context.document.getElementById = (id) => {
    if(!marketElements.has(id)) marketElements.set(id, { value: '' });
    return marketElements.get(id);
  };
  assert.equal(context.applyMarketSnapshot({
    updatedAt: '2026-07-13T07:05:00.000Z',
    boardQuality: 'live',
    mainLines: '抗跌板块：传媒、医药',
    marketOne: '指数弱，市场退潮，适合防守。'
  }), true);
  assert.equal(context.applyMarketSnapshot({
    updatedAt: '2026-07-13T07:05:30.000Z',
    boardQuality: 'fallback',
    mainLines: '强势板块：传媒',
    marketOne: '指数分化，优先跟踪强势方向。'
  }), true);
  assert.equal(context.applyMarketSnapshot({
    updatedAt: '2026-07-13T07:06:00.000Z',
    mainLines: '只有主线'
  }), false);
  assert.equal(context.applyMarketSnapshot({
    updatedAt: '2026-07-13T07:07:00.000Z',
    marketOne: '只有判断'
  }), false);
  assert.equal(
    context.applyMarketSnapshot({
      updatedAt: '2026-07-13T07:05:30.000Z',
      boardQuality: 'fallback',
      mainLines: '强势板块：传媒',
      marketOne: '指数分化，优先跟踪强势方向。'
    }),
    false,
    'an unchanged complete snapshot should not trigger another status update'
  );
});

const cloudRequests = [];
context.fetch = async (url, options) => {
  cloudRequests.push({ url, options });
  return { ok: true, json: async () => ({ ok: true }) };
};

const latest = await context.fetchTzzbApi('/api/tzzb-latest');
assert.equal(latest.data.ok, true);
assert.equal(
  cloudRequests[0].url,
  'https://review.example.com/api/sync/latest',
  'hosted mode should read the same-origin verified-review endpoint'
);
assert.equal(cloudRequests[0].options.credentials, 'same-origin');
assert.equal(cloudRequests[0].options.headers?.['X-TZZB-Sync-Key'], undefined);

await context.fetchTzzbApi('/api/tzzb-health');
assert.equal(
  cloudRequests[1].url,
  'https://review.example.com/api/sync/health',
  'cloud mode should map helper health reads to cloud sync health'
);

console.log('PASS cloud sync fetch config');
