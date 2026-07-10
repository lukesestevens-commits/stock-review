const DEFAULT_MAX_RECORDS = 200;
const SENSITIVE_KEY_RE = /password|passwd|pwd|token|cookie|secret|auth/i;
const FUNDS_ENDPOINTS = new Set(['stock_position', 'stock_card', 'asset_trend', 'time_share']);
const TRADE_ENDPOINTS = new Set(['get_money_history', 'merge_day_trading']);
const QUOTE_ENDPOINTS = new Set(['pass_quotes']);

function endpointName(url = '') {
  return String(url).split('?')[0].replace(/\/$/, '').split('/').pop() || '';
}

export function analyzeEndpointCoverage(records = []) {
  let fundsOrHoldingEndpoints = 0;
  let tradeEndpoints = 0;
  let quoteEndpoints = 0;
  for (const record of records || []) {
    const name = endpointName(record.url);
    if (FUNDS_ENDPOINTS.has(name)) fundsOrHoldingEndpoints += 1;
    if (TRADE_ENDPOINTS.has(name)) tradeEndpoints += 1;
    if (QUOTE_ENDPOINTS.has(name)) quoteEndpoints += 1;
  }
  const missing = [];
  if (!fundsOrHoldingEndpoints) missing.push('资金/持仓');
  if (!tradeEndpoints) missing.push('交易记录');
  return {
    readyForReview: fundsOrHoldingEndpoints > 0 && tradeEndpoints > 0,
    hasFundsOrHoldings: fundsOrHoldingEndpoints > 0,
    hasTradeEndpoint: tradeEndpoints > 0,
    fundsOrHoldingEndpoints,
    tradeEndpoints,
    quoteEndpoints,
    missing
  };
}

export function scheduleSyncDelayMs() {
  return 2500;
}

export function localDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

export function isSensitiveKey(key) {
  return SENSITIVE_KEY_RE.test(String(key || ''));
}

function redactValue(value) {
  if (Array.isArray(value)) return value.map(redactValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    isSensitiveKey(key) ? '[REDACTED]' : redactValue(child)
  ]));
}

export function redactRequestPostData(postData) {
  if (!postData) return postData;
  try {
    return JSON.stringify(redactValue(JSON.parse(postData)));
  } catch {
    return postData;
  }
}

function normalizeMethod(method) {
  return String(method || 'GET').toUpperCase();
}

export function buildCaptureRecord(record = {}) {
  return {
    capturedAt: record.capturedAt || new Date().toISOString(),
    type: record.type || 'browser-response',
    method: normalizeMethod(record.method),
    status: Number(record.status || 0),
    url: String(record.url || ''),
    responseText: String(record.responseText || ''),
    ...(record.requestPostData
      ? { requestPostData: redactRequestPostData(record.requestPostData) }
      : {})
  };
}

function recordKey(record) {
  return [
    normalizeMethod(record.method),
    Number(record.status || 0),
    String(record.url || ''),
    String(record.responseText || '')
  ].join('\u001f');
}

export function dedupeRecords(records = []) {
  const seen = new Set();
  const unique = [];
  for (const record of records) {
    const key = recordKey(record);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(record);
  }
  return unique;
}

export class TzzbSyncQueue {
  constructor({
    records = [],
    capturedCount = 0,
    lastCaptureAt = '',
    lastSyncAt = '',
    maxRecords = DEFAULT_MAX_RECORDS,
    now = () => new Date().toISOString()
  } = {}) {
    this.maxRecords = maxRecords;
    this.now = now;
    this.targetDate = localDate(this.now());
    this.records = dedupeRecords(records.map(buildCaptureRecord))
      .filter((record) => localDate(record.capturedAt) === this.targetDate)
      .slice(-this.maxRecords);
    this.capturedCount = Number(capturedCount || this.records.length || 0);
    this.lastCaptureAt = lastCaptureAt || '';
    this.lastSyncAt = lastSyncAt || '';
  }

  static fromSnapshot(snapshot = {}, options = {}) {
    return new TzzbSyncQueue({ ...snapshot, ...options });
  }

  enqueue(records = []) {
    this.targetDate = localDate(this.now());
    this.records = this.records.filter((record) => localDate(record.capturedAt) === this.targetDate);
    const before = new Set(this.records.map(recordKey));
    let accepted = 0;
    for (const input of records) {
      const record = buildCaptureRecord(input);
      if (localDate(record.capturedAt) !== this.targetDate) continue;
      const key = recordKey(record);
      if (before.has(key)) continue;
      before.add(key);
      this.records.push(record);
      this.lastCaptureAt = record.capturedAt;
      accepted += 1;
    }
    this.capturedCount += accepted;
    this.records = this.records.slice(-this.maxRecords);
    return accepted;
  }

  buildPayload({ pageUrl = '' } = {}) {
    return {
      source: 'edge-extension',
      pageUrl,
      pushedAt: this.now(),
      targetDate: this.targetDate,
      records: this.records
    };
  }

  markSynced(count = this.records.length, syncedAt = this.now()) {
    this.records = this.records.slice(Math.max(0, count));
    this.lastSyncAt = syncedAt;
  }

  clear() {
    this.records = [];
  }

  snapshot() {
    return {
      records: this.records,
      capturedCount: this.capturedCount,
      lastCaptureAt: this.lastCaptureAt,
      lastSyncAt: this.lastSyncAt,
      targetDate: this.targetDate
    };
  }

  stats() {
    return {
      capturedCount: this.capturedCount,
      pendingCount: this.records.length,
      lastCaptureAt: this.lastCaptureAt,
      lastSyncAt: this.lastSyncAt,
      targetDate: this.targetDate,
      endpointCoverage: analyzeEndpointCoverage(this.records)
    };
  }
}
