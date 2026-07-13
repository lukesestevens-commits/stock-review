const REQUIRED_INDEX_CODES = ['000001', '399001', '399006'];
const MARKET_CLOSE_TIME = '15:00:00';

function text(value) {
  return String(value || '').trim();
}

function requiredIndices(market = {}) {
  const rows = Array.isArray(market.indices) ? market.indices : [];
  const byCode = new Map(rows.map((row) => [String(row?.code || ''), row]));
  return REQUIRED_INDEX_CODES.map((code) => byCode.get(code)).filter(Boolean);
}

function quoteParts(value) {
  const match = text(value).match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  return match ? { date: match[1], time: match[2] } : null;
}

export function isValidMarketSnapshot(market = {}) {
  const mainLines = text(market.mainLines);
  return Boolean(
    mainLines
    && !/暂不可用|暂无/.test(mainLines)
    && text(market.marketOne)
    && requiredIndices(market).length === REQUIRED_INDEX_CODES.length
  );
}

export function marketSnapshotTradeDate(market = {}) {
  const rows = requiredIndices(market);
  if (rows.length !== REQUIRED_INDEX_CODES.length) return '';
  const quotes = rows.map((row) => quoteParts(row.quoteTime));
  if (quotes.some((quote) => !quote)) return '';
  const dates = new Set(quotes.map((quote) => quote.date));
  return dates.size === 1 ? quotes[0].date : '';
}

export function isFinalMarketSnapshot(market = {}) {
  if (!isValidMarketSnapshot(market) || !marketSnapshotTradeDate(market)) return false;
  return requiredIndices(market)
    .map((row) => quoteParts(row.quoteTime))
    .every((quote) => quote && quote.time >= MARKET_CLOSE_TIME);
}
