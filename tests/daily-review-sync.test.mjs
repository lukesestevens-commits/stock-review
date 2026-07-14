import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createDailyReviewSync } from '../tools/daily-review-sync.mjs';

const moduleSource = await readFile(new URL('../tools/daily-review-sync.mjs', import.meta.url), 'utf8');
assert.doesNotMatch(moduleSource, /from ['"]node:/, 'the Module must run inside Cloudflare Workers');

class MemoryStore {
  constructor() {
    this.attempts = new Map();
    this.latest = null;
    this.verifiedWrites = 0;
    this.candidateWrites = 0;
    this.pendingAttempt = null;
    this.prunedBefore = [];
    this.pruneThrows = false;
  }

  async readAttempt(idempotencyKey) {
    return this.attempts.get(idempotencyKey) || null;
  }

  async saveAttempt(attempt) {
    this.candidateWrites += 1;
    this.attempts.set(attempt.idempotencyKey, structuredClone(attempt));
    this.pendingAttempt = structuredClone(attempt);
  }

  async readLatestVerified() {
    return {
      ...(this.latest ? structuredClone(this.latest) : { dailyReview: null, audit: null }),
      pendingAttempt: this.pendingAttempt ? structuredClone(this.pendingAttempt) : null
    };
  }

  async saveVerified(value) {
    assert.match(value.attempt.contentHash, /^[a-f0-9]{64}$/);
    assert.ok(Array.isArray(value.attempt.normalizedEvidence?.records));
    this.verifiedWrites += 1;
    this.attempts.set(value.attempt.idempotencyKey, structuredClone(value.attempt));
    this.latest = structuredClone({ dailyReview: value.dailyReview, audit: value.audit });
    this.pendingAttempt = null;
  }

  async pruneCandidates(beforeDate) {
    this.prunedBefore.push(beforeDate);
    if (this.pruneThrows) throw new Error('simulated retention failure');
  }
}

const accountRef = 'a'.repeat(64);
const capturedAt = '2026-07-14T16:09:44.269Z';

function midnightEvidence() {
  return {
    activeAccountRefs: [accountRef],
    records: [
      {
        endpoint: 'last_trading_day',
        capturedAt,
        accountRef: 'c'.repeat(64),
        request: {},
        payload: {
          isTradingDay: true,
          lastTradingDay: '2026-07-15',
          previousTradingDay: '2026-07-14',
          beforePreviousTradingDay: '2026-07-13',
          systemTime: 1784045384264
        }
      },
      {
        endpoint: 'stock_position',
        capturedAt,
        accountRef,
        request: {},
        payload: {
          totalAsset: '282113.7500',
          totalLiability: '0',
          totalValue: '220000.0000',
          positionRate: '0.7798',
          cash: '62113.75',
          positions: [
            { code: '000001', name: '样本股票', quantity: '1000', price: '50', value: '50000' },
            { code: '204001', name: 'GC001', quantity: '170', price: '1000', value: '170000' }
          ]
        }
      },
      {
        endpoint: 'asset_trend',
        capturedAt,
        accountRef,
        request: {},
        payload: {
          monthProfit: [
            { date: '2026-07-13', asset: '279651.36', fundIn: '0', fundOut: '0', profit: '-16291.98' },
            { date: '2026-07-14', asset: '282113.75', fundIn: '0', fundOut: '0', profit: '-13829.59' }
          ],
          yearProfit: [
            { date: '2026-07-13', asset: '279651.36', fundIn: '0', fundOut: '0', profit: '-16291.98' },
            { date: '2026-07-14', asset: '282113.75', fundIn: '0', fundOut: '0', profit: '-13829.59' }
          ],
          totalAssetHistory: [
            { date: '2026-07-13', asset: '279651.36', fundIn: '0', fundOut: '0', profit: '-16291.98' },
            { date: '2026-07-14', asset: '282113.75', fundIn: '0', fundOut: '0', profit: '-13829.59' }
          ]
        }
      },
      {
        endpoint: 'get_money_history',
        capturedAt,
        accountRef,
        request: { startDate: '2026-07-14', endDate: '2026-07-14', page: 1, count: 200 },
        payload: {
          page: 1,
          maxPage: 1,
          total: 2,
          trades: [
            { code: '000001', name: '样本股票', side: '买入', date: '2026-07-14', time: '10:01:02', price: '50', quantity: '1000', amount: '50000', fee: '0', sequenceId: 'trade-001' },
            { code: '204001', name: 'GC001', side: '买入', date: '2026-07-14', time: '15:02:00', price: '1.5', quantity: '170', amount: '170000', fee: '0', sequenceId: 'repo-001' }
          ]
        }
      },
      {
        endpoint: 'merge_day_trading',
        capturedAt,
        accountRef,
        request: {},
        payload: {
          trades: [
            { code: '000001', name: '样本股票', side: '买入', date: '', time: '', price: '50', quantity: '1000', amount: '-50000', fee: '0', sequenceId: 'trade-001' }
          ]
        }
      },
      {
        endpoint: 'time_share',
        capturedAt,
        accountRef,
        request: {},
        payload: { displayPnl: '2453.59' }
      },
      {
        endpoint: 'stock_card',
        capturedAt,
        accountRef,
        request: {},
        payload: { displayAsset: '999999.00', displayPnl: '2453.59' }
      }
    ]
  };
}

async function settleInTimezone(timezone) {
  const previousTimezone = process.env.TZ;
  process.env.TZ = timezone;
  try {
    const store = new MemoryStore();
    const sync = createDailyReviewSync({
      store,
      now: () => new Date('2026-07-14T17:00:00.000Z')
    });
    const result = await sync.submitCapture({
      idempotencyKey: `midnight-${timezone}`,
      capturedAt,
      captureDate: '2026-07-15',
      evidence: midnightEvidence()
    });
    return { store, sync, result, latest: await sync.readLatestVerified() };
  } finally {
    process.env.TZ = previousTimezone;
  }
}

const utc = await settleInTimezone('UTC');
const shanghai = await settleInTimezone('Asia/Shanghai');

for (const run of [utc, shanghai]) {
  assert.equal(run.result.state, 'verified');
  assert.equal(run.result.reviewDate, '2026-07-14');
  assert.equal(run.result.audit.status, 'verified');
  assert.ok(run.result.audit.verifiedAt);
  assert.equal(run.store.candidateWrites, 0, 'verified writes are one atomic store operation');
  assert.equal(run.store.verifiedWrites, 1);
  assert.deepEqual(run.store.attempts.values().next().value.normalizedEvidence, midnightEvidence());
  assert.equal(run.latest.dailyReview.reviewDate, '2026-07-14');
  assert.equal(run.latest.dailyReview.pnl, '2462.39', 'reconciled history delta must win over the 2453.59 display value');
  assert.deepEqual(run.latest.dailyReview.capital, {
    totalAsset: '282113.75',
    liability: '0.00',
    investedMarketValue: '220000.00',
    reverseRepoValue: '170000.00',
    cash: '62113.75',
    positionRatio: '0.7798',
    positionPercent: '77.98%'
  });
  assert.deepEqual(run.latest.dailyReview.basic, {
    capital: '282113.75',
    pnl: '+2462.39',
    position: '8成'
  });
  assert.equal(run.latest.dailyReview.date, '2026-07-14');
  assert.deepEqual(
    run.latest.dailyReview.holdings.map((holding) => `${holding.code} ${holding.weight}`),
    ['000001 17.72%'],
    'each visible holding weight uses total assets as the denominator'
  );
  assert.deepEqual(run.latest.dailyReview.trades.map((trade) => trade.code), ['000001']);
  assert.equal(run.latest.dailyReview.trades[0].accountRef, accountRef);
  assert.equal(run.latest.dailyReview.trades[0].sequenceId, 'trade-001');
  assert.equal(run.latest.dailyReview.tzzb.holdingValue, '220000.00');
  assert.equal(run.latest.dailyReview.tzzb.reverseRepoValue, '170000.00');
  assert.equal(run.latest.dailyReview.tzzb.positionRatio, '0.7798');
  assert.equal(run.latest.dailyReview.tzzb.positionPercent, '77.98%');
  assert.equal(run.latest.dailyReview.tzzb.importAudit, run.latest.audit);
  assert.ok(run.latest.audit.warnings.some((warning) => warning.code === 'DISPLAY_PNL_MISMATCH'));
  assert.deepEqual(run.latest.audit.issueCodes, []);
  assert.equal(run.store.prunedBefore.at(-1), '2026-04-16');
}

assert.deepEqual(utc.latest.dailyReview, shanghai.latest.dailyReview, 'the result must not depend on the host TZ');

function cloneEvidence() {
  return structuredClone(midnightEvidence());
}

function findRecord(evidence, endpoint, ref = accountRef) {
  return evidence.records.find((record) => record.endpoint === endpoint && record.accountRef === ref);
}

function makeSync(store = new MemoryStore()) {
  return {
    store,
    sync: createDailyReviewSync({
      store,
      now: () => new Date('2026-07-14T17:00:00.000Z')
    })
  };
}

async function submit(sync, evidence, idempotencyKey) {
  return sync.submitCapture({
    idempotencyKey,
    capturedAt,
    captureDate: '2026-07-15',
    evidence
  });
}

{
  const evidence = cloneEvidence();
  findRecord(evidence, 'get_money_history').payload = { page: 1, maxPage: 1, total: 0, trades: [] };
  findRecord(evidence, 'merge_day_trading').payload.trades = [];
  const { store, sync } = makeSync();
  const result = await submit(sync, evidence, 'correct-date-empty');
  const latest = await sync.readLatestVerified();
  assert.equal(result.state, 'verified', 'a complete correct-date empty detail response is valid evidence');
  assert.deepEqual(latest.dailyReview.trades, []);
  assert.ok(result.audit.warnings.some((warning) => warning.code === 'TRADE_SUMMARY_EMPTY'));
  assert.equal(store.verifiedWrites, 1);
}

{
  const evidence = cloneEvidence();
  evidence.records = evidence.records.filter((record) => record.endpoint !== 'merge_day_trading');
  const { sync } = makeSync();
  const result = await submit(sync, evidence, 'missing-trade-summary');
  assert.equal(result.state, 'stored-unverified', 'a missing summary endpoint is not proof of an empty summary');
  assert.ok(result.audit.issueCodes.includes('TRADE_RECONCILIATION_FAILED'));
}

{
  const evidence = cloneEvidence();
  findRecord(evidence, 'last_trading_day', 'c'.repeat(64)).payload.previousTradingDay = '';
  const { sync } = makeSync();
  const result = await submit(sync, evidence, 'invalid-trading-calendar');
  assert.equal(result.state, 'stored-unverified', 'an incomplete calendar cannot fall back to captureDate');
  assert.ok(result.audit.issueCodes.includes('TRADING_CALENDAR_MISSING'));
}

{
  const evidence = cloneEvidence();
  findRecord(evidence, 'last_trading_day', 'c'.repeat(64)).payload.systemTime = Date.parse('2026-07-14T15:00:00+08:00');
  const { sync } = makeSync();
  const result = await submit(sync, evidence, 'stale-trading-calendar');
  assert.equal(result.state, 'stored-unverified', 'a previous-natural-day calendar cannot drive a post-midnight review');
  assert.ok(result.audit.issueCodes.includes('TRADING_CALENDAR_STALE'));
}

{
  const evidence = cloneEvidence();
  findRecord(evidence, 'merge_day_trading').payload.trades = [];
  const { sync } = makeSync();
  const result = await submit(sync, evidence, 'empty-summary-with-detail');
  assert.equal(result.state, 'stored-unverified', 'an empty summary conflicts with non-empty ordinary detail trades');
  assert.ok(result.audit.issueCodes.includes('TRADE_RECONCILIATION_FAILED'));
}

{
  const evidence = cloneEvidence();
  findRecord(evidence, 'get_money_history').payload = { page: 1, maxPage: 1, total: 35, trades: [] };
  findRecord(evidence, 'merge_day_trading').payload.trades = [];
  const { sync } = makeSync();
  const result = await submit(sync, evidence, 'declared-trades-missing');
  assert.equal(result.state, 'stored-unverified', 'declared total must equal collected and de-duplicated details');
  assert.ok(result.audit.issueCodes.includes('TRADE_HISTORY_INCOMPLETE'));
}

{
  const evidence = cloneEvidence();
  const trades = Array.from({ length: 35 }, (_, index) => ({
    code: String(600000 + index),
    name: `完整成交${index + 1}`,
    side: index % 2 ? '卖出' : '买入',
    date: '2026-07-14',
    time: `10:${String(index).padStart(2, '0')}:00`,
    price: '10',
    quantity: '100',
    amount: '1000',
    fee: '0',
    sequenceId: `trade-${index + 1}`
  }));
  findRecord(evidence, 'get_money_history').payload = {
    page: 1,
    maxPage: 1,
    total: 35,
    trades: structuredClone(trades)
  };
  findRecord(evidence, 'merge_day_trading').payload.trades = trades.map((trade) => ({
    ...trade,
    date: '',
    time: '',
    amount: trade.side === '买入' ? `-${trade.amount}` : trade.amount
  }));
  const { sync } = makeSync();
  const result = await submit(sync, evidence, 'thirty-five-trades-survive-cloud-normalization');
  assert.equal(result.state, 'verified');
  assert.equal((await sync.readLatestVerified()).dailyReview.trades.length, 35, '35 local details must never become 0 in UTC/cloud execution');
}

{
  const evidence = cloneEvidence();
  delete findRecord(evidence, 'get_money_history').payload.trades;
  const { sync } = makeSync();
  const result = await submit(sync, evidence, 'submitted-history-shape-missing');
  assert.equal(result.state, 'stored-unverified', 'direct evidence cannot turn a missing trades array into a valid empty page');
  assert.ok(result.audit.issueCodes.includes('TRADE_HISTORY_INCOMPLETE'));
}

{
  const evidence = cloneEvidence();
  const history = findRecord(evidence, 'get_money_history');
  history.request = { startDate: '2026-07-13', endDate: '2026-07-13', page: 1, count: 200 };
  history.payload = { page: 1, maxPage: 1, total: 0, trades: [] };
  findRecord(evidence, 'merge_day_trading').payload.trades = [];
  const { store, sync } = makeSync();
  const result = await submit(sync, evidence, 'wrong-date-empty');
  const latest = await sync.readLatestVerified();
  assert.equal(result.state, 'stored-unverified', 'an empty response for another date is not proof of no trades');
  assert.ok(result.audit.issueCodes.includes('TRADE_HISTORY_INCOMPLETE'));
  assert.equal(latest.dailyReview, null);
  assert.equal(store.candidateWrites, 1);
}

{
  const missingAccountRef = 'b'.repeat(64);
  const evidence = cloneEvidence();
  evidence.activeAccountRefs.push(missingAccountRef);
  const { sync } = makeSync();
  const result = await submit(sync, evidence, 'missing-active-account');
  assert.equal(result.state, 'stored-unverified');
  for (const code of ['STOCK_POSITION_MISSING', 'ASSET_TREND_MISSING', 'TRADE_HISTORY_INCOMPLETE']) {
    assert.ok(result.audit.issues.some((issue) => issue.code === code && issue.accountRef === missingAccountRef));
  }
}

{
  const { store, sync } = makeSync();
  await submit(sync, cloneEvidence(), 'previous-good');
  const badEvidence = cloneEvidence();
  findRecord(badEvidence, 'get_money_history').request.endDate = '2026-07-13';
  const bad = await submit(sync, badEvidence, 'later-bad');
  assert.equal(bad.state, 'stored-unverified');
  const latest = await sync.readLatestVerified();
  assert.equal(latest.dailyReview.pnl, '2462.39', 'a held candidate must not replace the previous verified review');
  assert.deepEqual(Object.keys(latest.pendingAttempt), ['state', 'capturedAt', 'captureDate', 'reviewDate', 'audit']);
  assert.equal(latest.pendingAttempt.state, 'stored-unverified');
  assert.equal('normalizedEvidence' in latest.pendingAttempt, false);

  const restarted = createDailyReviewSync({ store, now: () => new Date('2026-07-14T17:00:00.000Z') });
  assert.equal((await restarted.readLatestVerified()).pendingAttempt.state, 'stored-unverified', 'pending state survives Worker restart');
}

{
  const { store, sync } = makeSync();
  const evidence = cloneEvidence();
  const first = await submit(sync, evidence, 'same-capture');
  const replay = await submit(sync, structuredClone(evidence), 'same-capture');
  assert.deepEqual(replay, first);
  assert.equal(store.verifiedWrites, 1, 'an exact idempotent replay is not written twice');

  const changed = cloneEvidence();
  findRecord(changed, 'time_share').payload.displayPnl = '1.00';
  await assert.rejects(
    submit(sync, changed, 'same-capture'),
    (error) => error.code === 'IDEMPOTENCY_CONFLICT'
  );
}

{
  const evidence = cloneEvidence();
  findRecord(evidence, 'stock_position').payload.totalValue = '219000.00';
  const { sync } = makeSync();
  const result = await submit(sync, evidence, 'capital-conflict');
  assert.equal(result.state, 'stored-unverified');
  assert.ok(result.audit.issueCodes.includes('CAPITAL_IDENTITY_CONFLICT'));
}

{
  const evidence = cloneEvidence();
  findRecord(evidence, 'stock_position').payload.positionRate = '0.5000';
  const { sync } = makeSync();
  const result = await submit(sync, evidence, 'position-conflict');
  assert.equal(result.state, 'stored-unverified');
  assert.ok(result.audit.issueCodes.includes('POSITION_RECONCILIATION_FAILED'));
}

{
  const evidence = cloneEvidence();
  const trend = findRecord(evidence, 'asset_trend').payload;
  for (const rows of [trend.monthProfit, trend.yearProfit, trend.totalAssetHistory]) {
    rows[0].date = '2026-07-12';
  }
  const { sync } = makeSync();
  const result = await submit(sync, evidence, 'missing-previous-trading-day-profit');
  assert.equal(
    result.state,
    'stored-unverified',
    'three internally consistent multi-day deltas cannot stand in for the previous trading day'
  );
  assert.ok(result.audit.issueCodes.includes('MONTH_PNL_MISSING'));
}

{
  const evidence = cloneEvidence();
  delete findRecord(evidence, 'stock_position').payload.totalLiability;
  const { sync } = makeSync();
  const result = await submit(sync, evidence, 'unknown-liability');
  assert.equal(result.state, 'stored-unverified', 'missing financing liability is not equivalent to zero');
  assert.ok(result.audit.issueCodes.includes('UNKNOWN_LIABILITY'));
}

{
  const evidence = cloneEvidence();
  findRecord(evidence, 'stock_position').payload.totalAsset = 'not-a-number';
  const { store, sync } = makeSync();
  const result = await submit(sync, evidence, 'invalid-numeric-candidate');
  assert.equal(result.state, 'stored-unverified', 'bad numeric evidence is retained for audit instead of becoming a 503');
  assert.ok(result.audit.issueCodes.includes('EVIDENCE_CALCULATION_ERROR'));
  assert.equal(store.candidateWrites, 1);
}

{
  const evidence = cloneEvidence();
  findRecord(evidence, 'stock_position').payload.positions.push({
    code: '000002', name: '已清仓残留行', quantity: '0', price: '10', value: '1000'
  });
  const { sync } = makeSync();
  const result = await submit(sync, evidence, 'ignore-cleared-position');
  assert.equal(result.state, 'verified', 'capital identity uses active positions, not stale zero-quantity rows');
  assert.deepEqual((await sync.readLatestVerified()).dailyReview.holdings.map((holding) => holding.code), ['000001']);
}

{
  const evidence = cloneEvidence();
  findRecord(evidence, 'stock_position').payload.positions.find((holding) => holding.code === '204001').quantity = '0';
  const { sync } = makeSync();
  const result = await submit(sync, evidence, 'repo-zero-quantity');
  assert.equal(result.state, 'verified', 'reverse repo market value remains invested even when its quantity is zero');
  assert.equal((await sync.readLatestVerified()).dailyReview.capital.reverseRepoValue, '170000.00');
}

{
  const evidence = cloneEvidence();
  findRecord(evidence, 'merge_day_trading').payload.trades[0].amount = '-49999';
  const { sync } = makeSync();
  const result = await submit(sync, evidence, 'trade-summary-conflict');
  assert.equal(result.state, 'stored-unverified');
  assert.ok(result.audit.issueCodes.includes('TRADE_RECONCILIATION_FAILED'));
}

{
  const evidence = cloneEvidence();
  findRecord(evidence, 'merge_day_trading').payload.trades[0].sequenceId = 'different-sequence';
  const { sync } = makeSync();
  const result = await submit(sync, evidence, 'trade-sequence-conflict');
  assert.equal(result.state, 'stored-unverified', 'when either side has a sequenceId, both sequenceIds must match');
  assert.ok(result.audit.issueCodes.includes('TRADE_RECONCILIATION_FAILED'));
}

{
  const evidence = cloneEvidence();
  const calendar = findRecord(evidence, 'last_trading_day', 'c'.repeat(64)).payload;
  calendar.lastTradingDay = '2026-07-02';
  calendar.previousTradingDay = '2026-07-01';
  calendar.beforePreviousTradingDay = '2026-06-30';
  const historyRecord = findRecord(evidence, 'get_money_history');
  historyRecord.request.startDate = '2026-07-01';
  historyRecord.request.endDate = '2026-07-01';
  historyRecord.payload.trades.forEach((trade) => { trade.date = '2026-07-01'; });
  const trend = findRecord(evidence, 'asset_trend').payload;
  trend.monthProfit = [
    { date: '2026-07-01', asset: '282113.7500', fundIn: '0', fundOut: '0', profit: '2462.3949' }
  ];
  const cumulative = [
    { date: '2026-06-30', asset: '279651.3551', fundIn: '0', fundOut: '0', profit: '-26066.2658' },
    { date: '2026-07-01', asset: '282113.7500', fundIn: '0', fundOut: '0', profit: '-23603.8709' }
  ];
  trend.yearProfit = structuredClone(cumulative);
  trend.totalAssetHistory = structuredClone(cumulative);
  const { sync } = makeSync();
  const result = await submit(sync, evidence, 'month-open-four-decimals');
  assert.equal(result.state, 'verified', 'the first monthly row is that day cumulative P&L');
  assert.equal((await sync.readLatestVerified()).dailyReview.pnl, '2462.39', 'subtract four-decimal cumulative values before rounding to cents');
}

{
  const evidence = cloneEvidence();
  const history = findRecord(evidence, 'get_money_history').payload.trades;
  history.splice(1, 0, { ...history[0], time: '10:01:03' });
  const { sync } = makeSync();
  const result = await submit(sync, evidence, 'sequence-deduplication');
  assert.equal(result.state, 'verified');
  assert.equal((await sync.readLatestVerified()).dailyReview.trades.length, 1, 'sequenceId wins over unstable duplicate row fields');
}

{
  const secondAccountRef = 'd'.repeat(64);
  const evidence = cloneEvidence();
  evidence.activeAccountRefs.push(secondAccountRef);
  evidence.records.push(
    {
      endpoint: 'stock_position', capturedAt, accountRef: secondAccountRef, request: {},
      payload: {
        totalAsset: '100000.00', totalLiability: '0', totalValue: '40000.00',
        positionRate: '0.4000', cash: '60000.00',
        positions: [{ code: '000001', name: '样本股票', quantity: '500', price: '80', value: '40000' }]
      }
    },
    {
      endpoint: 'asset_trend', capturedAt, accountRef: secondAccountRef, request: {},
      payload: {
        monthProfit: [
          { date: '2026-07-13', asset: '99900', fundIn: '0', fundOut: '0', profit: '0' },
          { date: '2026-07-14', asset: '100000', fundIn: '0', fundOut: '0', profit: '100' }
        ],
        yearProfit: [
          { date: '2026-07-13', asset: '99900', fundIn: '0', fundOut: '0', profit: '0' },
          { date: '2026-07-14', asset: '100000', fundIn: '0', fundOut: '0', profit: '100' }
        ],
        totalAssetHistory: [
          { date: '2026-07-13', asset: '99900', fundIn: '0', fundOut: '0', profit: '0' },
          { date: '2026-07-14', asset: '100000', fundIn: '0', fundOut: '0', profit: '100' }
        ]
      }
    },
    {
      endpoint: 'get_money_history', capturedAt, accountRef: secondAccountRef,
      request: { startDate: '2026-07-14', endDate: '2026-07-14', page: 1, count: 200 },
      payload: { page: 1, maxPage: 1, total: 0, trades: [] }
    },
    {
      endpoint: 'merge_day_trading', capturedAt, accountRef: secondAccountRef,
      request: {}, payload: { trades: [] }
    }
  );
  const { sync } = makeSync();
  const result = await submit(sync, evidence, 'aggregate-same-holding');
  assert.equal(result.state, 'verified');
  const review = (await sync.readLatestVerified()).dailyReview;
  assert.equal(review.holdings.length, 1, 'the same security across active accounts is one website holding row');
  assert.deepEqual(
    {
      code: review.holdings[0].code,
      quantity: review.holdings[0].quantity,
      price: review.holdings[0].price,
      value: review.holdings[0].value,
      weight: review.holdings[0].weight
    },
    { code: '000001', quantity: '1500', price: '60.00', value: '90000.00', weight: '23.55%' }
  );
}

{
  const { store, sync } = makeSync();
  store.pruneThrows = true;
  const result = await submit(sync, cloneEvidence(), 'prune-failure');
  assert.equal(result.state, 'verified', 'retention cleanup is best-effort after the atomic verified write');
  assert.equal((await sync.readLatestVerified()).dailyReview.reviewDate, '2026-07-14');
}

{
  const { store, sync } = makeSync();
  const evidence = cloneEvidence();
  evidence.cookie = 'top-secret-cookie';
  evidence.responseText = 'top-secret-response';
  const calendar = findRecord(evidence, 'last_trading_day', 'c'.repeat(64));
  calendar.url = 'https://private.example/account';
  calendar.responseText = 'record-secret-response';
  calendar.cookie = 'record-secret-cookie';
  calendar.request.cookie = 'request-secret-cookie';
  calendar.payload.cookie = 'payload-secret-cookie';
  findRecord(evidence, 'stock_position').payload.positions[0].cookie = 'row-secret-cookie';

  const first = await submit(sync, evidence, 'submitted-evidence-whitelist');
  assert.equal(first.state, 'verified');
  const stored = store.attempts.get('submitted-evidence-whitelist').normalizedEvidence;
  const serialized = JSON.stringify(stored);
  for (const secret of ['top-secret', 'private.example', 'record-secret', 'request-secret', 'payload-secret', 'row-secret']) {
    assert.doesNotMatch(serialized, new RegExp(secret));
  }
  assert.deepEqual(
    stored.records.map((record) => Object.keys(record)),
    stored.records.map(() => ['endpoint', 'capturedAt', 'accountRef', 'request', 'payload'])
  );

  const replay = structuredClone(evidence);
  replay.cookie = 'different-cookie';
  replay.records[0].responseText = 'different-response';
  const replayResult = await submit(sync, replay, 'submitted-evidence-whitelist');
  assert.deepEqual(replayResult, first, 'discarded transport secrets do not alter the idempotent content hash');
  assert.equal(store.verifiedWrites, 1);
}

console.log('PASS daily review sync');
