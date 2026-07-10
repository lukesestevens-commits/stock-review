function parseBody(record) {
  if (record && typeof record.data === 'object') return record.data;
  const text = record && (record.responseText ?? record.data);
  if (typeof text !== 'string') return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function endpointName(url = '') {
  return String(url).split('?')[0].replace(/\/$/, '').split('/').pop() || '';
}

function numeric(value) {
  const match = String(value ?? '').replace(/,/g, '').match(/[+-]?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

function money(value) {
  const num = numeric(value);
  return Number.isFinite(num) ? num.toFixed(2) : '';
}

function signedMoney(value) {
  const num = numeric(value);
  if (!Number.isFinite(num)) return '';
  return `${num > 0 ? '+' : ''}${num.toFixed(2)}`;
}

function compactMoney(value) {
  const num = numeric(value);
  if (!Number.isFinite(num)) return '';
  return String(+num.toFixed(3));
}

function percent(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '';
  return `${(num * 100).toFixed(1)}%`;
}

function normalizeSide(value) {
  return String(value || '').includes('卖') ? '卖出' : '买入';
}

function normalizeTime(value) {
  const text = String(value ?? '');
  const match = text.match(/(\d{1,2}):(\d{2})(?::\d{2})?/);
  if (match) return `${match[1].padStart(2, '0')}:${match[2]}`;
  if (/^\d{5,6}$/.test(text)) {
    const padded = text.padStart(6, '0');
    return `${padded.slice(0, 2)}:${padded.slice(2, 4)}`;
  }
  return '';
}

function fallbackTradeTime(index) {
  const minutes = 9 * 60 + 30 + index;
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function formatDate(value = new Date()) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  if (typeof value === 'string' && /^\d{8}$/.test(value)) {
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  }
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return formatDate(new Date());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function rowDate(row) {
  const value = row && (row.entry_date || row.cjrq || row.date || row.trade_date);
  return value ? formatDate(value) : '';
}

export function positionFromRatio(holdingValue, totalValue) {
  const holding = numeric(holdingValue);
  const total = numeric(totalValue);
  if (!holding || !total) return '空仓';
  const ratio = Math.max(0, Math.min(1, holding / total));
  if (ratio >= 0.95) return '满仓';
  const level = Math.max(1, Math.min(8, Math.round(ratio * 10)));
  return `${level}成`;
}

function latestPayloadByEndpoint(records) {
  const latest = new Map();
  for (const record of records || []) {
    const name = endpointName(record.url);
    if (!name) continue;
    latest.set(name, parseBody(record));
  }
  return latest;
}

function allRows(records, targetName, path) {
  const rows = [];
  const seen = new Set();
  for (const record of records || []) {
    if (endpointName(record.url) !== targetName) continue;
    const payload = parseBody(record);
    const data = path(payload);
    for (const row of data || []) {
      const key = JSON.stringify(row, Object.keys(row).sort());
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
  }
  return rows;
}

function getLatestArray(payload, key) {
  const ex = payload && payload.ex_data;
  return Array.isArray(ex && ex[key]) ? ex[key] : [];
}

function mapTrade(row, index = 0) {
  const side = normalizeSide(row.czlx || row.op_name || row.op);
  const price = compactMoney(row.cjjg || row.entry_price);
  const qty = compactMoney(row.cjsl || row.entry_count);
  const amount = money(row.moneychg || row.entry_money || (numeric(price) * numeric(qty)));
  const time = normalizeTime(row.cjsj || row.entry_time || row.time);
  return {
    time: time || fallbackTradeTime(index),
    name: row.zqmc || row.name || '',
    side,
    price,
    qty,
    amount,
    mode: side === '卖出' ? '止盈/止损' : '趋势波段',
    reason: '',
    planScore: 1,
    lineScore: 1,
    riskScore: 1
  };
}

function tradeSortMinutes(trade) {
  const match = String(trade.time || '').match(/^(\d{2}):(\d{2})$/);
  if (!match) return Number.POSITIVE_INFINITY;
  return Number(match[1]) * 60 + Number(match[2]);
}

function mapHolding(row, totalAsset) {
  const qty = compactMoney(row.count || row.amount || row.current_amount || row.enable_amount || row.qty);
  const price = compactMoney(row.latest || row.price || row.now_price || row.cost || row.latest_price);
  const value = numeric(row.market_value || row.value || row.money || row.latest_market_value || (numeric(qty) * numeric(price)));
  const cost = compactMoney(row.cost || row.cost_price || row.avg_price);
  const pnl = row.profit !== undefined || row.total_profit !== undefined || row.income !== undefined
    ? signedMoney(row.profit ?? row.total_profit ?? row.income)
    : '';
  const ledgerWeight = row.position_rate !== undefined && row.position_rate !== ''
    ? percent(numeric(row.position_rate))
    : '';
  return {
    code: row.code || row.stock_code || row.zqdm || '',
    name: row.name || row.stock_name || row.zqmc || '',
    qty,
    price,
    cost,
    value: value ? money(value) : '',
    weight: ledgerWeight || (totalAsset && value ? percent(value / totalAsset) : ''),
    pnl,
    isCore: '待判断',
    logic: '',
    tomorrowAction: '观察',
    trigger: ''
  };
}

function holdingQuantity(row) {
  return numeric(row.count ?? row.amount ?? row.current_amount ?? row.enable_amount ?? row.qty);
}

function isActiveHolding(row) {
  const hasQuantity = ['count', 'amount', 'current_amount', 'enable_amount', 'qty']
    .some((key) => row && row[key] !== undefined && row[key] !== '');
  if (hasQuantity) return holdingQuantity(row) > 0;
  return numeric(row.market_value || row.value || row.money || row.latest_market_value) > 0;
}

function holdingKey(row) {
  return row.code || row.stock_code || row.zqdm || row.name || row.stock_name || row.zqmc || JSON.stringify(row);
}

function dedupeActiveHoldings(rows) {
  const holdings = new Map();
  for (const row of rows || []) {
    if (!isActiveHolding(row)) continue;
    const key = holdingKey(row);
    if (!holdings.has(key)) holdings.set(key, row);
  }
  return [...holdings.values()];
}

function deriveCapital(latest, holdings) {
  const stockPosition = latest.get('stock_position') || {};
  const stockCard = latest.get('stock_card') || {};
  const hasStockPosition = Boolean(stockPosition.ex_data);
  const remain = numeric(stockPosition.ex_data && stockPosition.ex_data.money_remain);
  const holdingValue = holdings.reduce((sum, row) => {
    const marketValue = numeric(row.market_value || row.value || row.money || row.latest_market_value);
    if (marketValue) return sum + marketValue;
    return sum + numeric(row.count) * numeric(row.latest || row.price || row.now_price || row.cost);
  }, 0);

  if (hasStockPosition) {
    const explicitTotal = numeric(stockPosition.ex_data.total_asset);
    const explicitHolding = numeric(stockPosition.ex_data.total_value);
    return {
      total: explicitTotal || holdingValue + remain,
      holding: explicitHolding || holdingValue,
      capitalSource: explicitTotal ? 'stock_position.total_asset' : 'stock_position.calculated'
    };
  }

  const cardAsset = numeric(stockCard.ex_data && stockCard.ex_data.asset);
  if (cardAsset) {
    const cardHoldings = getLatestArray(stockCard, 'position');
    const cardHoldingValue = cardHoldings.reduce((sum, row) => (
      sum + numeric(row.value || row.market_value || row.money || (numeric(row.count) * numeric(row.price || row.latest || row.cost)))
    ), 0);
    return { total: cardAsset, holding: cardHoldingValue, capitalSource: 'stock_card.asset' };
  }

  if (holdingValue || remain) return { total: holdingValue + remain, holding: holdingValue, capitalSource: 'position.calculated' };

  const trend = getLatestArray(latest.get('asset_trend'), 'total_asset');
  const lastTrend = trend[trend.length - 1];
  return { total: numeric(lastTrend && lastTrend.asset), holding: 0, capitalSource: 'asset_trend.total_asset' };
}

function derivePnl(latest) {
  const card = latest.get('stock_card');
  const nowProfit = card && card.ex_data && card.ex_data.now_profit;
  if (nowProfit !== undefined) return { value: signedMoney(nowProfit), source: 'stock_card.now_profit' };
  const timeShare = getLatestArray(latest.get('time_share'), 'data');
  const last = timeShare[timeShare.length - 1];
  return last ? { value: signedMoney(last.yk), source: 'time_share.yk' } : { value: '', source: '' };
}

function deriveDate(records, trades, targetDate = '') {
  if (targetDate) return formatDate(targetDate);
  const tradeWithDate = trades.find((row) => row.entry_date || row.cjrq || row.date);
  if (tradeWithDate) return formatDate(tradeWithDate.entry_date || tradeWithDate.cjrq || tradeWithDate.date);
  const firstCapture = records.find((record) => record.capturedAt);
  return formatDate(firstCapture ? firstCapture.capturedAt : new Date());
}

function deriveTargetDate(records, explicitTargetDate) {
  if (explicitTargetDate) return formatDate(explicitTargetDate);
  const datedRecord = (records || []).find((record) => record.capturedAt);
  if (datedRecord) return formatDate(datedRecord.capturedAt);
  return formatDate(new Date());
}

function filterRowsByDate(rows, targetDate) {
  const datedRows = rows.filter((row) => rowDate(row));
  if (!datedRows.length) return rows;
  return rows.filter((row) => rowDate(row) === targetDate);
}

export function mapTzzbCaptureToReview(records, options = {}) {
  const targetDate = deriveTargetDate(records, options.targetDate);
  const latest = latestPayloadByEndpoint(records);
  const positionRows = allRows(records, 'stock_position', (payload) => getLatestArray(payload, 'position'));
  const cardRows = allRows(records, 'stock_card', (payload) => getLatestArray(payload, 'position'));
  const rawHoldings = positionRows.length ? positionRows : cardRows;
  const holdings = dedupeActiveHoldings(rawHoldings);
  const dayTrades = allRows(records, 'merge_day_trading', (payload) => getLatestArray(payload, 'data'));
  const moneyTrades = allRows(records, 'get_money_history', (payload) => getLatestArray(payload, 'list'));
  const todayMoneyTrades = filterRowsByDate(moneyTrades, targetDate);
  const todayDayTrades = filterRowsByDate(dayTrades, targetDate);
  const rawTrades = todayMoneyTrades.length ? todayMoneyTrades : todayDayTrades;
  const tradeSource = todayMoneyTrades.length ? 'get_money_history' : (todayDayTrades.length ? 'merge_day_trading' : '');
  const trades = rawTrades
    .map((row, index) => ({ trade: mapTrade(row, index), index }))
    .filter(({ trade }) => trade.name || trade.price || trade.amount)
    .sort((a, b) => tradeSortMinutes(a.trade) - tradeSortMinutes(b.trade) || a.index - b.index)
    .map(({ trade }) => trade);
  const capital = deriveCapital(latest, holdings);
  const holdingPlans = holdings
    .map((row) => mapHolding(row, capital.total))
    .filter((holding) => holding.name || holding.code || holding.value);
  const pnl = derivePnl(latest);
  const date = deriveDate(records || [], rawTrades, targetDate);
  const warnings = [];
  if (!trades.length) warnings.push('缺少当天交易记录');
  if (!holdings.length) warnings.push('缺少持仓明细');
  if (!capital.total) warnings.push('缺少账户总资金');
  const importAudit = {
    targetDate,
    trustLevel: warnings.length ? 'warning' : 'ready',
    capitalSource: capital.capitalSource || '',
    holdingSource: positionRows.length ? 'stock_position.position' : (cardRows.length ? 'stock_card.position' : ''),
    tradeSource,
    pnlSource: pnl.source,
    warnings
  };

  return {
    source: 'tzzb',
    importedAt: new Date().toISOString(),
    date,
    basic: {
      capital: capital.total ? money(capital.total) : '',
      position: positionFromRatio(capital.holding, capital.total),
      pnl: pnl.value
    },
    holdings: holdingPlans,
    trades,
    tzzb: {
      holdings: holdingPlans,
      rawHoldings,
      holdingCount: holdings.length,
      tradeCount: trades.length,
      cash: money(capital.total - capital.holding),
      holdingValue: money(capital.holding),
      importAudit
    },
    importSummary: `同花顺导入：${date} 当天 ${trades.length} 笔成交，${holdings.length} 条当前持仓，已填资金、盈亏和仓位。买卖理由与评分请手动补充。`
  };
}
