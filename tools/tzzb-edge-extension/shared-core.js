const DEFAULT_MAX_RECORDS = 200;
const DEFAULT_RECORD_TTL_MS = 30 * 24 * 60 * 60 * 1000;
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
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
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
  const capturedAt = record.capturedAt || new Date().toISOString();
  return {
    capturedAt,
    captureDate: record.captureDate || localDate(capturedAt),
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
    String(record.requestPostData || ''),
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
    targetDate = '',
    maxRecords = DEFAULT_MAX_RECORDS,
    recordTtlMs = DEFAULT_RECORD_TTL_MS,
    now = () => new Date().toISOString()
  } = {}) {
    this.maxRecords = maxRecords;
    this.recordTtlMs = Number.isFinite(Number(recordTtlMs)) && Number(recordTtlMs) >= 0
      ? Number(recordTtlMs)
      : DEFAULT_RECORD_TTL_MS;
    this.now = now;
    this.targetDate = targetDate || localDate(this.now());
    this.records = dedupeRecords(records.map(buildCaptureRecord))
      .slice(-this.maxRecords);
    this.capturedCount = Number(capturedCount || this.records.length || 0);
    this.lastCaptureAt = lastCaptureAt || '';
    this.lastSyncAt = lastSyncAt || '';
    this.pruneExpired();
  }

  static fromSnapshot(snapshot = {}, options = {}) {
    return new TzzbSyncQueue({ ...snapshot, ...options });
  }

  enqueue(records = []) {
    this.pruneExpired();
    this.targetDate = localDate(this.now());
    const before = new Set(this.records.map(recordKey));
    let accepted = 0;
    for (const input of records) {
      const record = buildCaptureRecord(input);
      const key = recordKey(record);
      if (before.has(key)) continue;
      before.add(key);
      this.records.push(record);
      this.lastCaptureAt = record.capturedAt;
      accepted += 1;
    }
    this.capturedCount += accepted;
    this.records = this.records.slice(-this.maxRecords);
    this.pruneExpired();
    return accepted;
  }

  buildPayload({ pageUrl = '' } = {}) {
    this.pruneExpired();
    const pushedAt = this.now();
    const lastRecord = this.records[this.records.length - 1];
    const capturedAt = this.lastCaptureAt || (lastRecord && lastRecord.capturedAt) || pushedAt;
    return {
      source: 'edge-extension',
      pageUrl,
      pushedAt,
      capturedAt,
      captureDate: (lastRecord && lastRecord.captureDate) || localDate(capturedAt),
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
    this.lastCaptureAt = '';
  }

  pruneExpired(referenceTime = this.now()) {
    const referenceTimestamp = Date.parse(referenceTime);
    if (!Number.isFinite(referenceTimestamp)) return 0;
    const cutoff = referenceTimestamp - this.recordTtlMs;
    const before = this.records.length;
    this.records = this.records.filter((record) => {
      const capturedAt = Date.parse(record.capturedAt || '');
      return Number.isFinite(capturedAt) && capturedAt >= cutoff;
    });
    if (this.records.length !== before) {
      this.lastCaptureAt = this.records.at(-1)?.capturedAt || '';
    }
    return before - this.records.length;
  }

  snapshot() {
    this.pruneExpired();
    return {
      records: this.records,
      capturedCount: this.capturedCount,
      lastCaptureAt: this.lastCaptureAt,
      lastSyncAt: this.lastSyncAt,
      targetDate: this.targetDate,
      recordTtlMs: this.recordTtlMs
    };
  }

  stats() {
    this.pruneExpired();
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
