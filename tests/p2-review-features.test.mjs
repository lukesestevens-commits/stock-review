import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] || '';
assert.ok(script);

const context = {
  console,
  alert() {},
  confirm() { return true; },
  setTimeout() { return 0; },
  clearTimeout() {},
  setInterval() { return 0; },
  clearInterval() {},
  Blob: class Blob {},
  URL,
  localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  location: { protocol: 'https:', hostname: 'review.example.com', origin: 'https://review.example.com' },
  navigator: { clipboard: { writeText: async () => {} } },
  document: {
    addEventListener() {},
    querySelectorAll() { return []; },
    querySelector() { return null; },
    createElement() { return { style: {}, click() {} }; },
    getElementById() { return { value: '', textContent: '', innerHTML: '', style: {}, appendChild() {}, querySelectorAll() { return []; } }; }
  },
  window: { addEventListener() {}, scrollTo() {}, matchMedia() { return { matches: false }; } }
};
context.window.localStorage = context.localStorage;
vm.createContext(context);
vm.runInContext(script, context);

const settings = {
  openingWindowStart: '09:30',
  openingWindowEnd: '10:00',
  openingWindowAmountRatio: 0.15,
  unplannedTradeDailyLimit: 2,
  highPositionLevels: ['8成', '满仓']
};
const record = {
  date: '2026-07-15',
  basic: { capital: '100000', position: '8成' },
  trades: [
    {
      accountRef: 'a', sequenceId: '1', name: '甲', time: '09:30', side: '买入', amount: '15000',
      reason: '', planScore: 0.5, lineScore: 0.5, riskScore: 0.5, score: 2.5, downwardAverage: true
    },
    {
      accountRef: 'a', sequenceId: '2', name: '乙', time: '10:00', side: '买入', amount: '16000',
      reason: '临盘起意', planScore: 0.5, lineScore: 1, riskScore: 0.5, score: 3.3
    }
  ]
};

assert.equal(typeof context.evaluateDiscipline, 'function');
const discipline = context.evaluateDiscipline(record, settings);
assert.ok(discipline.alerts.some((alert) => alert.ruleKey === 'opening-window-large-position'));
assert.ok(discipline.alerts.some((alert) => alert.ruleKey === 'unplanned-daily-limit'));
assert.ok(discipline.alerts.some((alert) => alert.ruleKey === 'downward-average'));
assert.ok(discipline.alerts.some((alert) => alert.ruleKey === 'high-total-position'));
assert.equal(
  context.evaluateDiscipline(record, settings).alerts[0].id,
  discipline.alerts[0].id,
  'discipline alert ids must be stable across recalculation'
);
const expandedEvidence = structuredClone(record);
expandedEvidence.trades.push({
  accountRef: 'a', sequenceId: '3', name: '丙', time: '09:45', side: '买入', amount: '18000',
  reason: '新增开盘证据', planScore: 2, lineScore: 1, riskScore: 1, score: 6
});
const openingId = discipline.alerts.find((alert) => alert.ruleKey === 'opening-window-large-position').id;
const expandedOpeningId = context.evaluateDiscipline(expandedEvidence, settings).alerts
  .find((alert) => alert.ruleKey === 'opening-window-large-position').id;
assert.notEqual(expandedOpeningId, openingId, 'new risk evidence must require a new acknowledgement');

const changedOpeningEvidence = structuredClone(record);
changedOpeningEvidence.trades[0].amount = '50000';
const changedOpeningId = context.evaluateDiscipline(changedOpeningEvidence, settings).alerts
  .find((alert) => alert.ruleKey === 'opening-window-large-position').id;
assert.notEqual(
  changedOpeningId,
  openingId,
  'changed risk evidence on the same identified trade must require a new acknowledgement'
);

assert.equal(typeof context.summarizeMonth, 'function');
const month = context.summarizeMonth([
  record,
  {
    date: '2026-07-14', basic: { pnl: '+100' },
    trades: [{ score: 8, planScore: 2, lineScore: 2, riskScore: 2, reason: '按计划' }]
  },
  { date: '2026-06-30', basic: { pnl: '-999' }, trades: [{ score: 1 }] }
], '2026-07', settings);
assert.equal(month.reviewDays, 2);
assert.equal(month.tradeCount, 3);
assert.equal(month.pnlSamples, 1, 'missing P&L is not counted as zero');
assert.equal(month.totalPnl, 100);
assert.equal(month.lowQualityCount, 2);
assert.equal(month.unplannedCount, 2);

const historicalThresholdRecord = structuredClone(record);
historicalThresholdRecord.discipline = { settings: { ...settings, unplannedTradeDailyLimit: 3 } };
const historicalThresholdMonth = context.summarizeMonth([historicalThresholdRecord], '2026-07', {
  ...settings,
  unplannedTradeDailyLimit: 2
});
assert.equal(
  historicalThresholdMonth.issues.some((issue) => issue.ruleKey === 'unplanned-daily-limit'),
  false,
  'historical discipline diagnostics must use the threshold saved with that review'
);

assert.equal(typeof context.buildCommandResults, 'function');
const aliasResults = context.buildCommandResults({ query: '越跌越买', currentRecord: record, historyRecords: [], alerts: discipline.alerts });
assert.ok(aliasResults.some((item) => item.group === '纪律问题' && item.label.includes('向下加仓')));
const stockResults = context.buildCommandResults({ query: '甲', currentRecord: record, historyRecords: [], alerts: discipline.alerts });
assert.ok(stockResults.some((item) => item.group === '当前交易' && item.label.includes('甲')));

assert.match(html, /id="commandPalette"[^>]*role="dialog"[^>]*aria-modal="true"/);
assert.match(html, /id="appNoticeBackdrop"[^>]*aria-hidden="true"/);
assert.doesNotMatch(script, /\balert\s*\(/, 'app feedback should use the full-viewport notice overlay instead of native alerts');
assert.match(html, /id="disciplineAlerts"/);
assert.match(html, /id="historyMonth"/);

console.log('PASS P2 command search, discipline rules, and monthly diagnostics');
