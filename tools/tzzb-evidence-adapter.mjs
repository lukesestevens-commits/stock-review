const EVIDENCE_ENDPOINTS = new Set([
  'last_trading_day',
  'stock_position',
  'get_money_history',
  'merge_day_trading',
  'asset_trend',
  'time_share',
  'stock_card'
]);

function endpointName(url = '') {
  return String(url).split('?')[0].replace(/\/$/, '').split('/').pop() || '';
}

function parsePayload(record = {}) {
  if (record.data && typeof record.data === 'object' && !Array.isArray(record.data)) return record.data;
  try {
    const parsed = JSON.parse(String(record.responseText || ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function successfulRecord(record = {}) {
  const status = Number(record.status);
  return Number.isInteger(status) && status >= 200 && status < 300;
}

function parseRequest(postData = '') {
  if (postData && typeof postData === 'object') return postData;
  const text = String(postData || '');
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // Form-encoded requests are the normal Tonghuashun shape.
  }
  return Object.fromEntries(new URLSearchParams(text));
}

function compactDate(value) {
  const text = String(value || '');
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}

function scopedAccountIdentity(value = {}, type = '') {
  const manualId = value.manual_id ?? value.manualid ?? value.manualId ?? '';
  const listedFundKey = value.fund_key ?? value.fundkey ?? value.fundKey ?? '';
  const explicitRzrqKey = value.rzrq_fund_key ?? value.rzrqfundkey ?? value.rzrqFundKey ?? '';
  const isRzrq = String(type).toLowerCase() === 'rzrq';
  const parts = [
    manualId,
    isRzrq && !explicitRzrqKey ? '' : listedFundKey,
    isRzrq ? (explicitRzrqKey || listedFundKey) : explicitRzrqKey,
    value.fundid ?? value.fund_id ?? '',
    value.custid ?? value.cust_id ?? ''
  ].map((part) => String(part || ''));
  return parts.some(Boolean) ? parts.join('|') : '';
}

function accountIdentity(value = {}, type = '') {
  const scoped = scopedAccountIdentity(value, type);
  if (scoped) return scoped;
  return String(value.user_id ?? value.userid ?? value.accountRef ?? 'unscoped');
}

function accountState(value) {
  if (typeof value === 'string') return value.trim() ? 'active' : 'inactive';
  if (!value || typeof value !== 'object') return 'inactive';
  const inactive = new Set(['0', 'false', 'disabled', 'inactive', 'no', 'off']);
  let explicit = false;
  for (const key of ['access_upload', 'is_active', 'active', 'enabled', 'is_valid']) {
    if (!Object.hasOwn(value, key)) continue;
    explicit = true;
    if (inactive.has(String(value[key]).trim().toLowerCase())) return 'inactive';
  }
  return explicit ? 'active' : 'unknown';
}

async function accountRef(value, type = '') {
  const identity = typeof value === 'string' ? value : accountIdentity(value, type);
  if (/^[a-f0-9]{64}$/i.test(identity)) return identity.toLowerCase();
  const bytes = new TextEncoder().encode(identity);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function activeAccounts(records, rawPayload) {
  const rows = [];
  for (const [index, account] of (rawPayload.activeAccounts || []).entries()) {
    rows.push({ value: account, type: 'submitted', index });
  }
  for (const record of records) {
    if (!successfulRecord(record)) continue;
    if (endpointName(record.url || record.endpoint) !== 'account_list') continue;
    const payload = parsePayload(record);
    const exData = payload?.ex_data;
    if (!exData || typeof exData !== 'object' || Array.isArray(exData)) continue;
    for (const [type, value] of Object.entries(exData)) {
      if (!Array.isArray(value)) continue;
      value.forEach((account, index) => rows.push({ value: account, type, index }));
    }
  }
  const references = await Promise.all(rows.map(async ({ value, type, index }) => {
    const state = accountState(value);
    if (state === 'inactive') return null;
    if (typeof value === 'string') return accountRef(value);
    if (scopedAccountIdentity(value, type)) return accountRef(value, type);
    if (state === 'active') return accountRef(`unresolved:${type}:${index}`);
    return null;
  }));
  return [...new Set(references.filter(Boolean))].sort();
}

function safeRequest(request) {
  const value = {};
  const startDate = compactDate(request.start_date ?? request.startDate);
  const endDate = compactDate(request.end_date ?? request.endDate);
  if (startDate) value.startDate = startDate;
  if (endDate) value.endDate = endDate;
  if (request.page !== undefined && request.page !== '') value.page = Number(request.page);
  if (request.count !== undefined && request.count !== '') value.count = Number(request.count);
  return value;
}

function safePosition(row = {}) {
  return {
    code: String(row.code ?? row.stock_code ?? row.zqdm ?? ''),
    name: String(row.name ?? row.stock_name ?? row.zqmc ?? ''),
    quantity: String(row.quantity ?? row.count ?? row.amount ?? row.current_amount ?? row.qty ?? ''),
    price: String(row.price ?? row.latest ?? row.latest_price ?? row.cost ?? ''),
    value: String(row.value ?? row.market_value ?? row.money ?? row.latest_market_value ?? '')
  };
}

function safeTrade(row = {}) {
  return {
    code: String(row.code ?? row.zqdm ?? row.stock_code ?? ''),
    name: String(row.name ?? row.zqmc ?? row.stock_name ?? ''),
    side: String(row.side ?? row.op_name ?? row.czlx ?? row.op ?? ''),
    date: compactDate(row.entry_date ?? row.cjrq ?? row.date ?? row.trade_date),
    time: String(row.entry_time ?? row.cjsj ?? row.time ?? ''),
    price: String(row.price ?? row.entry_price ?? row.cjjg ?? ''),
    quantity: String(row.quantity ?? row.entry_count ?? row.cjsl ?? ''),
    amount: String(row.amount ?? row.entry_money ?? row.moneychg ?? ''),
    fee: String(row.fee_total ?? row.fee ?? row.commission ?? '0'),
    sequenceId: String(
      row.sequenceId ?? row.sequence_id ?? row.business_no ?? row.entrust_no
      ?? row.entrustNo ?? row.wtbh ?? row.cjxh ?? row.serial_no ?? ''
    )
  };
}

function safeTrendRow(row = {}) {
  return {
    date: compactDate(row.date),
    asset: String(row.asset ?? ''),
    fundIn: String(row.fundIn ?? row.fund_in ?? '0'),
    fundOut: String(row.fundOut ?? row.fund_out ?? '0'),
    profit: String(row.profit ?? '')
  };
}

function rawPayloadIsUsable(endpoint, payload) {
  const exData = payload?.ex_data;
  if (!exData || typeof exData !== 'object' || Array.isArray(exData)) return false;
  if (endpoint === 'get_money_history') {
    if (!['page', 'max_page', 'total', 'list'].every((key) => Object.hasOwn(exData, key))) return false;
    const page = Number(exData.page);
    const maxPage = Number(exData.max_page);
    const total = Number(exData.total);
    const list = exData.list;
    const completeZeroTradePage = Array.isArray(list)
      && page === 0 && maxPage === 0 && total === 0 && list.length === 0;
    return completeZeroTradePage || (Number.isSafeInteger(page) && page >= 1
      && Number.isSafeInteger(maxPage) && maxPage >= page
      && Number.isSafeInteger(total) && total >= 0
      && Array.isArray(list));
  }
  if (endpoint === 'merge_day_trading') return Array.isArray(exData.data);
  if (endpoint === 'stock_position') {
    return ['total_asset', 'total_value', 'position_rate', 'money_remain', 'position']
      .every((key) => Object.hasOwn(exData, key)) && Array.isArray(exData.position);
  }
  if (endpoint === 'asset_trend') {
    return ['month_profit', 'year_profit', 'total_asset']
      .every((key) => Array.isArray(exData[key]));
  }
  return true;
}

function tradingDayFlag(value) {
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  return null;
}

function safePayload(endpoint, payload) {
  const exData = payload.ex_data;
  if (endpoint === 'last_trading_day') {
    return {
      isTradingDay: tradingDayFlag(exData.is_trading_day),
      lastTradingDay: compactDate(exData.last_trading_day),
      previousTradingDay: compactDate(exData.prev_trading_day),
      beforePreviousTradingDay: compactDate(exData.before_prev_trading_day),
      systemTime: Number(exData.system_time || 0)
    };
  }
  if (endpoint === 'stock_position') {
    return {
      totalAsset: String(exData.total_asset ?? ''),
      totalLiability: String(exData.total_liability ?? ''),
      totalValue: String(exData.total_value ?? ''),
      positionRate: String(exData.position_rate ?? ''),
      cash: String(exData.money_remain ?? ''),
      positions: (Array.isArray(exData.position) ? exData.position : []).map(safePosition)
    };
  }
  if (endpoint === 'asset_trend') {
    return {
      monthProfit: (Array.isArray(exData.month_profit) ? exData.month_profit : []).map(safeTrendRow),
      yearProfit: (Array.isArray(exData.year_profit) ? exData.year_profit : []).map(safeTrendRow),
      totalAssetHistory: (Array.isArray(exData.total_asset) ? exData.total_asset : []).map(safeTrendRow)
    };
  }
  if (endpoint === 'time_share') {
    const points = Array.isArray(exData.data) ? exData.data : [];
    return { displayPnl: String(points.at(-1)?.yk ?? '') };
  }
  if (endpoint === 'stock_card') {
    return {
      displayAsset: String(exData.asset ?? ''),
      displayPnl: String(exData.now_profit ?? '')
    };
  }
  if (endpoint === 'merge_day_trading') {
    return {
      trades: (Array.isArray(exData.data) ? exData.data : []).map(safeTrade)
    };
  }
  const completeZeroTradePage = Number(exData.page) === 0
    && Number(exData.max_page) === 0
    && Number(exData.total) === 0
    && exData.list.length === 0;
  return {
    page: completeZeroTradePage ? 1 : Number(exData.page),
    maxPage: completeZeroTradePage ? 1 : Number(exData.max_page),
    total: Number(exData.total),
    trades: exData.list.map(safeTrade)
  };
}

function submittedInteger(value, minimum = 0) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum ? number : null;
}

function submittedPayload(endpoint, payload = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const value = payload;
  if (endpoint === 'last_trading_day') {
    return {
      isTradingDay: typeof value.isTradingDay === 'boolean' ? value.isTradingDay : null,
      lastTradingDay: compactDate(value.lastTradingDay),
      previousTradingDay: compactDate(value.previousTradingDay),
      beforePreviousTradingDay: compactDate(value.beforePreviousTradingDay),
      systemTime: Number.isFinite(Number(value.systemTime)) ? Number(value.systemTime) : 0
    };
  }
  if (endpoint === 'stock_position') {
    if (!Array.isArray(value.positions)) return null;
    return {
      totalAsset: String(value.totalAsset ?? ''),
      totalLiability: String(value.totalLiability ?? ''),
      totalValue: String(value.totalValue ?? ''),
      positionRate: String(value.positionRate ?? ''),
      cash: String(value.cash ?? ''),
      positions: (Array.isArray(value.positions) ? value.positions : []).map(safePosition)
    };
  }
  if (endpoint === 'asset_trend') {
    if (![value.monthProfit, value.yearProfit, value.totalAssetHistory].every(Array.isArray)) return null;
    return {
      monthProfit: (Array.isArray(value.monthProfit) ? value.monthProfit : []).map(safeTrendRow),
      yearProfit: (Array.isArray(value.yearProfit) ? value.yearProfit : []).map(safeTrendRow),
      totalAssetHistory: (Array.isArray(value.totalAssetHistory) ? value.totalAssetHistory : []).map(safeTrendRow)
    };
  }
  if (endpoint === 'time_share') return { displayPnl: String(value.displayPnl ?? '') };
  if (endpoint === 'stock_card') {
    return {
      displayAsset: String(value.displayAsset ?? ''),
      displayPnl: String(value.displayPnl ?? '')
    };
  }
  if (endpoint === 'merge_day_trading') {
    return Array.isArray(value.trades) ? { trades: value.trades.map(safeTrade) } : null;
  }
  const page = submittedInteger(value.page, 1);
  const maxPage = submittedInteger(value.maxPage, 1);
  const total = submittedInteger(value.total, 0);
  if (page === null || maxPage === null || maxPage < page || total === null || !Array.isArray(value.trades)) return null;
  return { page, maxPage, total, trades: value.trades.map(safeTrade) };
}

function submittedRequest(request = {}) {
  const safe = safeRequest(request && typeof request === 'object' ? request : {});
  if (safe.page !== undefined && (!Number.isSafeInteger(safe.page) || safe.page < 1)) delete safe.page;
  if (safe.count !== undefined && (!Number.isSafeInteger(safe.count) || safe.count < 1)) delete safe.count;
  return safe;
}

export async function normalizeSubmittedEvidence(evidence = {}) {
  const activeValues = Array.isArray(evidence?.activeAccountRefs) ? evidence.activeAccountRefs : [];
  const activeAccountRefs = await Promise.all(activeValues.map((value, index) => (
    typeof value === 'string' && value.trim()
      ? accountRef(value.trim())
      : accountRef(`unresolved:submitted:${index}`)
  )));
  const records = [];
  const sourceRecords = Array.isArray(evidence?.records) ? evidence.records : [];
  for (const [index, record] of sourceRecords.entries()) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
    const endpoint = String(record.endpoint || '');
    if (!EVIDENCE_ENDPOINTS.has(endpoint)) continue;
    const reference = typeof record.accountRef === 'string' && record.accountRef.trim()
      ? await accountRef(record.accountRef.trim())
      : await accountRef(`unresolved:record:${index}`);
    const payload = submittedPayload(endpoint, record.payload);
    if (!payload) continue;
    records.push({
      endpoint,
      capturedAt: String(record.capturedAt || ''),
      accountRef: reference,
      request: submittedRequest(record.request),
      payload
    });
  }
  return {
    activeAccountRefs: [...new Set(activeAccountRefs)].sort(),
    records
  };
}

export async function normalizeCaptureEvidence(rawPayload = {}) {
  const sourceRecords = Array.isArray(rawPayload.records) ? rawPayload.records : [];
  const records = [];
  for (const record of sourceRecords) {
    if (!successfulRecord(record)) continue;
    const endpoint = endpointName(record.url || record.endpoint);
    if (!EVIDENCE_ENDPOINTS.has(endpoint)) continue;
    const payload = parsePayload(record);
    if (!rawPayloadIsUsable(endpoint, payload)) continue;
    const request = parseRequest(record.requestPostData || record.request || '');
    records.push({
      endpoint,
      capturedAt: String(record.capturedAt || rawPayload.capturedAt || ''),
      accountRef: await accountRef(record.accountRef || request),
      request: safeRequest(request),
      payload: safePayload(endpoint, payload)
    });
  }
  return normalizeSubmittedEvidence({
    activeAccountRefs: await activeAccounts(sourceRecords, rawPayload),
    records
  });
}
