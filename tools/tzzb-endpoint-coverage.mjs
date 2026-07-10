const FUNDS_ENDPOINTS = new Set(['stock_position', 'stock_card', 'asset_trend', 'time_share']);
const TRADE_ENDPOINTS = new Set(['get_money_history', 'merge_day_trading']);
const QUOTE_ENDPOINTS = new Set(['pass_quotes']);

export function endpointName(url = '') {
  return String(url).split('?')[0].replace(/\/$/, '').split('/').pop() || '';
}

function localDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

function recordKey(record) {
  return [
    String(record.method || 'GET').toUpperCase(),
    Number(record.status || 0),
    String(record.url || ''),
    String(record.responseText || '')
  ].join('\u001f');
}

export function analyzeTzzbEndpointCoverage(records = []) {
  const endpointCounts = {};
  let fundsOrHoldingEndpoints = 0;
  let tradeEndpoints = 0;
  let quoteEndpoints = 0;

  for (const record of records || []) {
    const name = endpointName(record.url);
    if (!name) continue;
    endpointCounts[name] = (endpointCounts[name] || 0) + 1;
    if (FUNDS_ENDPOINTS.has(name)) fundsOrHoldingEndpoints += 1;
    if (TRADE_ENDPOINTS.has(name)) tradeEndpoints += 1;
    if (QUOTE_ENDPOINTS.has(name)) quoteEndpoints += 1;
  }

  const hasFundsOrHoldings = fundsOrHoldingEndpoints > 0;
  const hasTradeEndpoint = tradeEndpoints > 0;
  const missing = [];
  if (!hasFundsOrHoldings) missing.push('资金/持仓');
  if (!hasTradeEndpoint) missing.push('交易记录');

  return {
    readyForReview: hasFundsOrHoldings && hasTradeEndpoint,
    hasFundsOrHoldings,
    hasTradeEndpoint,
    fundsOrHoldingEndpoints,
    tradeEndpoints,
    quoteEndpoints,
    endpointCounts,
    missing
  };
}

export function mergeCaptureRecords(existing = [], incoming = [], { targetDate = localDate(new Date()) } = {}) {
  const merged = [];
  const seen = new Set();

  for (const record of [...(existing || []), ...(incoming || [])]) {
    const capturedAt = record.capturedAt || new Date().toISOString();
    if (localDate(capturedAt) !== targetDate) continue;
    const key = recordKey(record);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(record);
  }

  return merged;
}
