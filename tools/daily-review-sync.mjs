import { normalizeSubmittedEvidence } from './tzzb-evidence-adapter.mjs';

const SHANGHAI_TIME_ZONE = 'Asia/Shanghai';
const REVIEW_CUTOFF_MINUTES = 15 * 60 + 35;
const MONEY_SCALE_DIGITS = 4;
const MONEY_TOLERANCE = 100n;

function syncError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function shanghaiParts(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw syncError('INVALID_CAPTURED_AT', 'capturedAt must be a valid ISO instant');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SHANGHAI_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const read = (type) => parts.find((part) => part.type === type)?.value || '';
  return {
    date: `${read('year')}-${read('month')}-${read('day')}`,
    minutes: Number(read('hour')) * 60 + Number(read('minute'))
  };
}

function fixedValue(value, digits, code = 'INVALID_DECIMAL') {
  const text = String(value ?? '').trim().replaceAll(',', '');
  const match = text.match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
  if (!match) throw syncError(code, `Invalid fixed-point value: ${value}`);
  const sign = match[1] === '-' ? -1n : 1n;
  const scale = 10n ** BigInt(digits);
  const fraction = String(match[3] || '').padEnd(digits + 1, '0');
  let result = BigInt(match[2]) * scale + BigInt(fraction.slice(0, digits) || '0');
  if (fraction[digits] >= '5') result += 1n;
  return result * sign;
}

function moneyValue(value) {
  return fixedValue(value, MONEY_SCALE_DIGITS, 'INVALID_MONEY');
}

function formatMoney(value) {
  const sign = value < 0n ? '-' : '';
  const absolute = value < 0n ? -value : value;
  const cents = (absolute + 50n) / 100n;
  return `${sign}${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}

function abs(value) {
  return value < 0n ? -value : value;
}

function roundedDivide(numerator, denominator) {
  if (denominator === 0n) return 0n;
  return (numerator + denominator / 2n) / denominator;
}

function formatPercent(value, total) {
  if (total <= 0n || value <= 0n) return '0.00%';
  const hundredths = roundedDivide(value * 10000n, total);
  return `${hundredths / 100n}.${String(hundredths % 100n).padStart(2, '0')}%`;
}

function formatRatio(value, total) {
  if (total <= 0n || value <= 0n) return '0.0000';
  const tenThousandths = roundedDivide(value * 10000n, total);
  return `${tenThousandths / 10000n}.${String(tenThousandths % 10000n).padStart(4, '0')}`;
}

function formatFixed(value, digits) {
  const sign = value < 0n ? '-' : '';
  const absolute = value < 0n ? -value : value;
  const scale = 10n ** BigInt(digits);
  const fraction = String(absolute % scale).padStart(digits, '0').replace(/0+$/, '');
  return `${sign}${absolute / scale}${fraction ? `.${fraction}` : ''}`;
}

function signedMoney(value) {
  const formatted = formatMoney(value);
  return value > 0n ? `+${formatted}` : formatted;
}

function positionLabel(value, total) {
  if (total <= 0n || value * 20n <= total) return '空仓';
  const tier = roundedDivide(value * 10n, total);
  if (tier >= 9n) return '满仓';
  return `${tier < 1n ? 1n : tier}成`;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

async function digestCapture(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(stableValue(value)));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function latestRecord(records, endpoint, accountRef) {
  return records
    .filter((record) => record.endpoint === endpoint && (!accountRef || record.accountRef === accountRef))
    .sort((left, right) => String(left.capturedAt).localeCompare(String(right.capturedAt)))
    .at(-1) || null;
}

function deriveReviewDate(records, capturedAt, fallbackDate) {
  const calendar = latestRecord(records, 'last_trading_day');
  const invalid = (calendarIssueCode) => ({
    reviewDate: fallbackDate,
    previousReviewDate: '',
    calendar: null,
    calendarIssueCode
  });
  if (!calendar) return invalid('TRADING_CALENDAR_MISSING');
  const clock = shanghaiParts(capturedAt);
  const payload = calendar.payload || {};
  const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
  let systemTimestamp = Number(payload.systemTime);
  if (Number.isFinite(systemTimestamp) && systemTimestamp > 0 && systemTimestamp < 1e12) {
    systemTimestamp *= 1000;
  }
  if (
    !Number.isFinite(systemTimestamp)
    || systemTimestamp <= 0
    || shanghaiParts(new Date(systemTimestamp)).date !== fallbackDate
  ) {
    return invalid('TRADING_CALENDAR_STALE');
  }
  if (typeof payload.isTradingDay !== 'boolean' || !validDate(payload.lastTradingDay)) {
    return invalid('TRADING_CALENDAR_MISSING');
  }
  const beforeCutoff = payload.isTradingDay && clock.minutes < REVIEW_CUTOFF_MINUTES;
  const reviewDate = payload.isTradingDay
    ? (beforeCutoff ? payload.previousTradingDay : payload.lastTradingDay)
    : payload.lastTradingDay;
  const previousReviewDate = beforeCutoff
    ? payload.beforePreviousTradingDay
    : payload.previousTradingDay;
  if (!validDate(reviewDate) || !validDate(previousReviewDate) || previousReviewDate >= reviewDate) {
    return invalid('TRADING_CALENDAR_MISSING');
  }
  return { reviewDate, previousReviewDate, calendar, calendarIssueCode: '' };
}

function datedRows(rows = []) {
  return [...rows]
    .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(String(row.date || '')))
    .sort((left, right) => left.date.localeCompare(right.date));
}

function adjacentDifference(rows, reviewDate, previousReviewDate, field) {
  const ordered = datedRows(rows);
  const current = ordered.find((row) => row.date === reviewDate);
  const previous = ordered.find((row) => row.date === previousReviewDate);
  if (!current || !previous) return null;
  return moneyValue(current[field]) - moneyValue(previous[field]);
}

function monthlyProfit(rows, reviewDate, previousReviewDate) {
  const ordered = datedRows(rows);
  const current = ordered.find((row) => row.date === reviewDate);
  if (!current) return null;
  if (previousReviewDate.slice(0, 7) !== reviewDate.slice(0, 7)) {
    return moneyValue(current.profit);
  }
  const previous = ordered.find((row) => row.date === previousReviewDate);
  if (!previous) return null;
  return moneyValue(current.profit) - moneyValue(previous.profit);
}

function netAssetDifference(rows, reviewDate, previousReviewDate) {
  const ordered = datedRows(rows);
  const current = ordered.find((row) => row.date === reviewDate);
  const previous = ordered.find((row) => row.date === previousReviewDate);
  if (!current || !previous) return null;
  return moneyValue(current.asset) - moneyValue(previous.asset)
    - moneyValue(current.fundIn || '0') + moneyValue(current.fundOut || '0');
}

function reverseRepo(row = {}) {
  const code = String(row.code || '').toUpperCase();
  const name = String(row.name || '').toUpperCase();
  return /^204\d{3}$/.test(code)
    || /^1318\d{2}$/.test(code)
    || code === '888880'
    || name.startsWith('GC')
    || name.startsWith('R-')
    || name.includes('标准券');
}

function activePosition(row = {}) {
  if (reverseRepo(row)) return moneyValue(row.value || '0') > 0n;
  const quantity = String(row.quantity ?? '').trim();
  if (quantity) return fixedValue(quantity, 4) > 0n;
  return moneyValue(row.value || '0') > 0n;
}

function daysBefore(date, count) {
  const value = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(value.getTime())) return '';
  value.setUTCDate(value.getUTCDate() - count);
  return value.toISOString().slice(0, 10);
}

async function bestEffortPrune(store, captureDate) {
  if (typeof store.pruneCandidates !== 'function') return;
  const beforeDate = daysBefore(captureDate, 90);
  if (!beforeDate) return;
  try {
    await store.pruneCandidates(beforeDate);
  } catch {
    // Retention cleanup must never roll back an accepted capture.
  }
}

function publicPendingAttempt(attempt) {
  if (!attempt) return null;
  return {
    state: attempt.state,
    capturedAt: attempt.capturedAt,
    captureDate: attempt.captureDate,
    reviewDate: attempt.reviewDate,
    audit: attempt.audit
  };
}

function completeTradeRecords(records, accountRef, reviewDate) {
  const matching = records.filter((record) => (
    record.endpoint === 'get_money_history'
    && record.accountRef === accountRef
    && record.request?.startDate === reviewDate
    && record.request?.endDate === reviewDate
  ));
  if (!matching.length) return { complete: false, trades: [], warnings: [] };
  const pageSnapshots = new Map();
  for (const [index, record] of matching.entries()) {
    const page = Number(record.payload?.page || record.request?.page || 1);
    if (!Number.isSafeInteger(page) || page < 1 || !Array.isArray(record.payload?.trades)) {
      return { complete: false, trades: [], warnings: [] };
    }
    const candidate = { record, index, capturedAt: String(record.capturedAt || '') };
    const existing = pageSnapshots.get(page);
    if (
      !existing
      || candidate.capturedAt > existing.capturedAt
      || (candidate.capturedAt === existing.capturedAt && candidate.index > existing.index)
    ) {
      pageSnapshots.set(page, candidate);
    }
  }
  const selected = [...pageSnapshots.values()]
    .map((snapshot) => snapshot.record)
    .sort((left, right) => Number(left.payload.page) - Number(right.payload.page));
  const maxPages = selected.map((record) => Number(record.payload?.maxPage));
  if (
    maxPages.some((value) => !Number.isSafeInteger(value) || value < 1)
    || new Set(maxPages).size !== 1
  ) {
    return { complete: false, trades: [], warnings: [] };
  }
  const maxPage = maxPages[0];
  const pages = new Set(selected.map((record) => Number(record.payload.page)));
  for (let page = 1; page <= maxPage; page += 1) {
    if (!pages.has(page)) return { complete: false, trades: [], warnings: [] };
  }
  const declaredTotals = selected
    .map((record) => record.payload?.total)
    .filter((value) => value !== undefined && value !== null && value !== '')
    .map(Number);
  if (
    !declaredTotals.length
    || declaredTotals.some((value) => !Number.isSafeInteger(value) || value < 0)
    || new Set(declaredTotals).size !== 1
  ) {
    return { complete: false, trades: [], warnings: [] };
  }
  const seenSequences = new Set();
  const noSequenceCounts = new Map();
  const trades = [];
  for (const record of selected) {
    for (const trade of record.payload?.trades || []) {
      if (trade.date && trade.date !== reviewDate) continue;
      const sequenceId = String(trade.sequenceId || '').trim();
      if (sequenceId) {
        if (seenSequences.has(sequenceId)) continue;
        seenSequences.add(sequenceId);
      } else {
        const occurrence = JSON.stringify(stableValue(trade));
        noSequenceCounts.set(occurrence, (noSequenceCounts.get(occurrence) || 0) + 1);
      }
      trades.push({ ...trade, accountRef });
    }
  }
  if (trades.length !== declaredTotals[0]) return { complete: false, trades: [], warnings: [] };
  const identicalOccurrenceCount = [...noSequenceCounts.values()]
    .reduce((total, count) => total + Math.max(0, count - 1), 0);
  return {
    complete: true,
    trades,
    warnings: identicalOccurrenceCount
      ? [{
          code: 'TRADE_HISTORY_IDENTICAL_OCCURRENCES_PRESERVED',
          accountRef,
          count: identicalOccurrenceCount
        }]
      : []
  };
}

function previousAssetIsZero(rows, previousReviewDate) {
  const row = datedRows(rows).find((candidate) => candidate.date === previousReviewDate);
  const asset = String(row?.asset ?? '').trim();
  return Boolean(asset) && moneyValue(asset) === 0n;
}

function confirmedZeroBalanceAccount({
  position,
  trend,
  history,
  tradeSummary,
  previousReviewDate,
  accountAsset,
  accountLiability,
  accountCash,
  accountPositionValue,
  declaredValueText
}) {
  return accountAsset === 0n
    && accountLiability === 0n
    && accountCash === 0n
    && accountPositionValue === 0n
    && Boolean(declaredValueText)
    && moneyValue(declaredValueText) === 0n
    && !(position.payload.positions || []).some(activePosition)
    && history.complete
    && history.trades.length === 0
    && tradeSummary.matched
    && tradeSummary.empty
    && previousAssetIsZero(trend.payload.totalAssetHistory, previousReviewDate);
}

function tradeSide(value) {
  const text = String(value || '').trim();
  if (text.includes('卖')) return '卖出';
  if (text.includes('买')) return '买入';
  return text;
}

function tradeSignature(trade) {
  return [
    String(trade.sequenceId || '').trim(),
    String(trade.code || '').trim(),
    String(trade.name || '').trim(),
    tradeSide(trade.side),
    moneyValue(trade.price || '0'),
    fixedValue(trade.quantity || '0', 4),
    abs(moneyValue(trade.amount || '0'))
  ].join('|');
}

function tradeSummaryResult(records, accountRef, reviewDate, detailTrades, captureDate) {
  const summary = latestRecord(records, 'merge_day_trading', accountRef);
  if (!summary) return { matched: false, empty: false, reason: 'SUMMARY_MISSING' };
  const summaryRows = (summary?.payload?.trades || []).filter((trade) => !reverseRepo(trade));
  const ordinaryDetails = detailTrades.filter((trade) => !reverseRepo(trade));
  const explicitlyScopedToReviewDate = summary.request?.startDate === reviewDate
    && summary.request?.endDate === reviewDate;
  const containsReviewDate = summaryRows.some((trade) => trade.date === reviewDate);
  if (captureDate !== reviewDate && !explicitlyScopedToReviewDate && !containsReviewDate) {
    return { matched: true, empty: false, unavailable: true };
  }
  if (!summaryRows.length) {
    return ordinaryDetails.length
      ? { matched: false, empty: false, reason: 'EMPTY_SUMMARY_WITH_DETAILS' }
      : { matched: true, empty: true };
  }
  if (summaryRows.some((trade) => trade.date && trade.date !== reviewDate)) {
    return { matched: false, empty: false };
  }

  const counts = (rows) => {
    const values = new Map();
    for (const row of rows.filter((trade) => !reverseRepo(trade))) {
      const signature = tradeSignature(row);
      values.set(signature, (values.get(signature) || 0) + 1);
    }
    return values;
  };
  const expected = counts(summaryRows);
  const actual = counts(ordinaryDetails);
  if (expected.size !== actual.size) return { matched: false, empty: false };
  for (const [signature, count] of expected) {
    if (actual.get(signature) !== count) return { matched: false, empty: false };
  }
  return { matched: true, empty: false };
}

function visibleTrade(trade) {
  const quantity = String(trade.quantity || '');
  return {
    code: String(trade.code || ''),
    accountRef: String(trade.accountRef || ''),
    sequenceId: String(trade.sequenceId || ''),
    name: String(trade.name || ''),
    side: String(trade.side || ''),
    date: String(trade.date || ''),
    time: String(trade.time || ''),
    price: String(trade.price || ''),
    quantity,
    qty: quantity,
    amount: formatMoney(abs(moneyValue(trade.amount || '0'))),
    fee: formatMoney(abs(moneyValue(trade.fee || '0'))),
    mode: String(trade.side || '').includes('卖') ? '止盈/止损' : '趋势波段',
    reason: '',
    planScore: 1,
    lineScore: 1,
    riskScore: 1
  };
}

function buildReview({ records, activeAccountRefs, reviewDate, previousReviewDate, capturedAt, captureDate, now }) {
  const issues = [];
  const warnings = [];
  if (!activeAccountRefs.length) issues.push({ code: 'ACTIVE_ACCOUNTS_MISSING' });

  let totalAsset = 0n;
  let liability = 0n;
  let investedMarketValue = 0n;
  let reverseRepoValue = 0n;
  let cash = 0n;
  let pnl = 0n;
  const rawVisibleHoldings = [];
  const visibleTrades = [];

  for (const accountRef of activeAccountRefs) {
    const position = latestRecord(records, 'stock_position', accountRef);
    const trend = latestRecord(records, 'asset_trend', accountRef);
    const history = completeTradeRecords(records, accountRef, reviewDate);
    if (!position) issues.push({ code: 'STOCK_POSITION_MISSING', accountRef });
    if (!trend) issues.push({ code: 'ASSET_TREND_MISSING', accountRef });
    if (!history.complete) issues.push({ code: 'TRADE_HISTORY_INCOMPLETE', accountRef, reviewDate });
    if (!position || !trend || !history.complete) continue;
    warnings.push(...history.warnings);

    const tradeSummary = tradeSummaryResult(records, accountRef, reviewDate, history.trades, captureDate);
    if (tradeSummary.unavailable) {
      warnings.push({ code: 'TRADE_SUMMARY_UNAVAILABLE_FOR_REVIEW_DATE', accountRef, reviewDate, captureDate });
    } else if (!tradeSummary.matched) {
      issues.push({
        code: 'TRADE_RECONCILIATION_FAILED',
        accountRef,
        reviewDate,
        ...(tradeSummary.reason ? { reason: tradeSummary.reason } : {})
      });
    } else if (tradeSummary.empty) {
      warnings.push({ code: 'TRADE_SUMMARY_EMPTY', accountRef, reviewDate });
    }

    const accountAsset = moneyValue(position.payload.totalAsset);
    const liabilityText = String(position.payload.totalLiability ?? '').trim();
    const accountLiability = liabilityText ? moneyValue(liabilityText) : 0n;
    const accountCash = moneyValue(position.payload.cash || '0');
    totalAsset += accountAsset;
    liability += accountLiability;
    cash += accountCash;
    if (!liabilityText) issues.push({ code: 'UNKNOWN_LIABILITY', accountRef });
    else if (accountLiability !== 0n) issues.push({ code: 'NONZERO_LIABILITY', accountRef, value: formatMoney(accountLiability) });

    let accountPositionValue = 0n;
    for (const holding of position.payload.positions || []) {
      const value = moneyValue(holding.value || '0');
      if (!activePosition(holding) || value <= 0n) continue;
      accountPositionValue += value;
      investedMarketValue += value;
      if (reverseRepo(holding)) reverseRepoValue += value;
      else rawVisibleHoldings.push({ ...holding, valueMinor: value });
    }

    const declaredValueText = String(position.payload.totalValue ?? '');
    if (!declaredValueText) {
      issues.push({ code: 'CAPITAL_IDENTITY_CONFLICT', accountRef, reason: 'TOTAL_VALUE_MISSING' });
    } else {
      const declaredValue = moneyValue(declaredValueText);
      if (
        abs(accountPositionValue - declaredValue) > MONEY_TOLERANCE
        || abs(accountAsset - accountCash - declaredValue) > MONEY_TOLERANCE
      ) {
        issues.push({
          code: 'CAPITAL_IDENTITY_CONFLICT',
          accountRef,
          positionValue: formatMoney(accountPositionValue),
          declaredValue: formatMoney(declaredValue),
          assetLessCash: formatMoney(accountAsset - accountCash)
        });
      }
    }

    const positionRateText = String(position.payload.positionRate ?? '').trim();
    const zeroPositionRateConfirmed = !positionRateText
      && accountPositionValue === 0n
      && Boolean(declaredValueText)
      && moneyValue(declaredValueText) === 0n
      && abs(accountAsset - accountCash) <= MONEY_TOLERANCE;
    if (zeroPositionRateConfirmed) {
      warnings.push({ code: 'POSITION_RATE_EMPTY_FOR_ZERO_POSITION', accountRef });
    } else if (!positionRateText || accountAsset <= 0n) {
      issues.push({ code: 'POSITION_RECONCILIATION_FAILED', accountRef, reason: 'POSITION_RATE_MISSING' });
    } else {
      const reportedRate = fixedValue(positionRateText, 6, 'INVALID_POSITION_RATE');
      const rateScale = 1000000n;
      const difference = abs(accountPositionValue * rateScale - reportedRate * accountAsset);
      if (difference > abs(accountAsset) * 1000n) {
        issues.push({
          code: 'POSITION_RECONCILIATION_FAILED',
          accountRef,
          computed: formatRatio(accountPositionValue, accountAsset),
          reported: positionRateText
        });
      }
    }

    const monthPnl = monthlyProfit(trend.payload.monthProfit, reviewDate, previousReviewDate);
    const crossChecks = [
      adjacentDifference(trend.payload.yearProfit, reviewDate, previousReviewDate, 'profit'),
      adjacentDifference(trend.payload.totalAssetHistory, reviewDate, previousReviewDate, 'profit'),
      netAssetDifference(trend.payload.totalAssetHistory, reviewDate, previousReviewDate)
    ].filter((value) => value !== null);
    let accountPnl = monthPnl;
    const zeroBalanceConfirmed = monthPnl === null && confirmedZeroBalanceAccount({
      position,
      trend,
      history,
      tradeSummary,
      previousReviewDate,
      accountAsset,
      accountLiability,
      accountCash,
      accountPositionValue,
      declaredValueText
    });
    const zeroBalanceCrossCheckConflict = zeroBalanceConfirmed
      && crossChecks.some((value) => abs(value) > MONEY_TOLERANCE);
    if (zeroBalanceConfirmed && zeroBalanceCrossCheckConflict) {
      issues.push({
        code: 'PNL_RECONCILIATION_FAILED',
        accountRef,
        reviewDate,
        reason: 'ZERO_BALANCE_CROSS_CHECK_NONZERO'
      });
    } else if (zeroBalanceConfirmed) {
      accountPnl = 0n;
      warnings.push({ code: 'MONTH_PNL_DERIVED_ZERO_BALANCE_ACCOUNT', accountRef, reviewDate });
    } else if (monthPnl === null) {
      issues.push({ code: 'MONTH_PNL_MISSING', accountRef, reviewDate });
    } else if (!crossChecks.some((value) => abs(value - monthPnl) <= MONEY_TOLERANCE)) {
      issues.push({ code: 'PNL_RECONCILIATION_FAILED', accountRef, reviewDate });
    }
    if (accountPnl !== null && !issues.some((issue) => (
      issue.accountRef === accountRef
      && ['MONTH_PNL_MISSING', 'PNL_RECONCILIATION_FAILED'].includes(issue.code)
    ))) pnl += accountPnl;

    for (const trade of history.trades) {
      if (!reverseRepo(trade)) visibleTrades.push(visibleTrade(trade));
    }

    for (const endpoint of ['time_share', 'stock_card']) {
      const display = latestRecord(records, endpoint, accountRef);
      const displayPnl = display?.payload?.displayPnl;
      if (accountPnl !== null && displayPnl !== undefined && displayPnl !== '') {
        const reported = moneyValue(displayPnl);
        if (abs(reported - accountPnl) > MONEY_TOLERANCE) {
          warnings.push({
            code: 'DISPLAY_PNL_MISMATCH',
            accountRef,
            source: endpoint,
            expected: formatMoney(accountPnl),
            actual: formatMoney(reported)
          });
        }
      }
    }
  }

  const status = issues.length ? 'held' : 'verified';
  const nowValue = now();
  const checkedAt = (nowValue instanceof Date ? nowValue : new Date(nowValue)).toISOString();
  const audit = {
    status,
    capturedAt,
    captureDate,
    reviewDate,
    checkedAt,
    ...(status === 'verified' ? { verifiedAt: checkedAt } : {}),
    issueCodes: issues.map((issue) => issue.code),
    issues,
    warnings
  };
  if (status !== 'verified') return { audit, dailyReview: null };

  const groupedHoldings = new Map();
  rawVisibleHoldings.forEach((holding, index) => {
    const code = String(holding.code || '').trim();
    const name = String(holding.name || '').trim();
    const key = code ? `code:${code}` : (name ? `name:${name}` : `row:${index}`);
    const quantityText = String(holding.quantity ?? '').trim();
    const quantityFixed = quantityText ? fixedValue(quantityText, 4) : 0n;
    const existing = groupedHoldings.get(key);
    if (existing) {
      existing.valueMinor += holding.valueMinor;
      existing.quantityFixed += quantityFixed;
    } else {
      groupedHoldings.set(key, { ...holding, code, name, quantityFixed });
    }
  });
  const holdings = [...groupedHoldings.values()].map((holding) => ({
    code: holding.code,
    name: holding.name,
    quantity: holding.quantityFixed > 0n
      ? formatFixed(holding.quantityFixed, 4)
      : String(holding.quantity || ''),
    price: holding.quantityFixed > 0n
      ? formatMoney(roundedDivide(holding.valueMinor * 10000n, holding.quantityFixed))
      : String(holding.price || ''),
    value: formatMoney(holding.valueMinor),
    weight: formatPercent(holding.valueMinor, totalAsset),
    isCore: '待判断',
    logic: '',
    tomorrowAction: '观察',
    trigger: ''
  }));
  visibleTrades.sort((left, right) => left.time.localeCompare(right.time));
  const totalAssetText = formatMoney(totalAsset);
  const pnlText = formatMoney(pnl);
  const investedText = formatMoney(investedMarketValue);
  const reverseRepoText = formatMoney(reverseRepoValue);
  const positionRatio = formatRatio(investedMarketValue, totalAsset);
  const positionPercent = formatPercent(investedMarketValue, totalAsset);
  const basic = {
    capital: totalAssetText,
    pnl: signedMoney(pnl),
    position: positionLabel(investedMarketValue, totalAsset)
  };
  const capital = {
    totalAsset: totalAssetText,
    liability: formatMoney(liability),
    investedMarketValue: investedText,
    reverseRepoValue: reverseRepoText,
    cash: formatMoney(cash),
    positionRatio,
    positionPercent
  };
  return {
    audit,
    dailyReview: {
      reviewDate,
      date: reviewDate,
      captureDate,
      capturedAt,
      pnl: pnlText,
      basic,
      capital,
      holdings,
      trades: visibleTrades,
      tzzb: {
        holdingCount: holdings.length,
        tradeCount: visibleTrades.length,
        holdingValue: investedText,
        reverseRepoValue: reverseRepoText,
        positionRatio,
        positionPercent,
        importAudit: audit
      }
    }
  };
}

export function createDailyReviewSync({ store, now = () => new Date() } = {}) {
  for (const method of ['readAttempt', 'saveAttempt', 'readLatestVerified', 'saveVerified']) {
    if (!store || typeof store[method] !== 'function') throw new TypeError(`store.${method} is required`);
  }
  let pendingAttempt = null;

  async function submitCapture({ idempotencyKey, capturedAt, captureDate, evidence } = {}) {
    if (!idempotencyKey) throw syncError('IDEMPOTENCY_KEY_REQUIRED', 'idempotencyKey is required');
    const clock = shanghaiParts(capturedAt);
    if (clock.date !== captureDate) {
      throw syncError('CAPTURE_DATE_MISMATCH', `captureDate ${captureDate} does not match ${clock.date}`);
    }
    const normalizedEvidence = await normalizeSubmittedEvidence(evidence);
    const content = { capturedAt, captureDate, evidence: normalizedEvidence };
    const contentHash = await digestCapture(content);
    const existing = await store.readAttempt(idempotencyKey);
    if (existing) {
      if (existing.contentHash !== contentHash) throw syncError('IDEMPOTENCY_CONFLICT', 'idempotencyKey was reused with different content');
      await bestEffortPrune(store, captureDate);
      return { state: existing.state, reviewDate: existing.reviewDate, audit: existing.audit };
    }

    const records = normalizedEvidence.records;
    const activeAccountRefs = normalizedEvidence.activeAccountRefs;
    const {
      reviewDate,
      previousReviewDate,
      calendar,
      calendarIssueCode
    } = deriveReviewDate(records, capturedAt, captureDate);
    let built;
    try {
      built = buildReview({
        records,
        activeAccountRefs,
        reviewDate,
        previousReviewDate,
        capturedAt,
        captureDate,
        now
      });
    } catch (error) {
      const nowValue = now();
      const checkedAt = (nowValue instanceof Date ? nowValue : new Date(nowValue)).toISOString();
      const issue = {
        code: 'EVIDENCE_CALCULATION_ERROR',
        reason: String(error?.code || 'INVALID_EVIDENCE_VALUE')
      };
      built = {
        dailyReview: null,
        audit: {
          status: 'held',
          capturedAt,
          captureDate,
          reviewDate,
          checkedAt,
          issueCodes: [issue.code],
          issues: [issue],
          warnings: []
        }
      };
    }
    if (!calendar) {
      built.audit.issues.unshift({ code: calendarIssueCode || 'TRADING_CALENDAR_MISSING' });
      built.audit.issueCodes = built.audit.issues.map((issue) => issue.code);
      built.audit.status = 'held';
      delete built.audit.verifiedAt;
      built.dailyReview = null;
    }
    const state = built.audit.status === 'verified' ? 'verified' : 'stored-unverified';
    const attempt = {
      idempotencyKey,
      contentHash,
      capturedAt,
      captureDate,
      reviewDate,
      state,
      normalizedEvidence,
      audit: built.audit
    };

    if (state === 'verified') {
      await store.saveVerified({ attempt, dailyReview: built.dailyReview, audit: built.audit });
      pendingAttempt = null;
    } else {
      await store.saveAttempt(attempt);
      pendingAttempt = attempt;
    }
    await bestEffortPrune(store, captureDate);
    return { state, reviewDate, audit: built.audit };
  }

  async function readLatestVerified() {
    const latest = await store.readLatestVerified();
    const durablePending = latest && Object.hasOwn(latest, 'pendingAttempt')
      ? latest.pendingAttempt
      : pendingAttempt;
    return {
      dailyReview: latest?.dailyReview || null,
      audit: latest?.audit || null,
      pendingAttempt: publicPendingAttempt(durablePending)
    };
  }

  return Object.freeze({ submitCapture, readLatestVerified });
}
