(function installTzzbStableCapture() {
  if (window.__tzzbStableCaptureInstalled) return;
  window.__tzzbStableCaptureInstalled = true;

  const originalFetch = window.fetch;
  const detailReadAt = new Map();
  const pendingSummaries = new Map();
  const detailReadWindowMs = 30_000;
  const calendarRefreshMs = 60_000;
  const maxDetailPages = 50;
  const backfillEndpoints = new Set([
    'stock_position',
    'asset_trend',
    'merge_day_trading',
    'get_money_history'
  ]);
  const requestTemplates = new Map();
  const backfillReadAt = new Map();
  let tradingCalendar = null;
  let calendarReadPromise = null;
  let calendarReadAt = 0;
  let activeAccounts = [];
  let backfillScheduled = false;
  let backfillChain = Promise.resolve();

  function absoluteUrl(url) {
    try {
      return new URL(url, location.href).href;
    } catch {
      return String(url || '');
    }
  }

  function endpointName(url) {
    return absoluteUrl(url).split('?')[0].replace(/\/$/, '').split('/').pop() || '';
  }

  function shouldCapture(url, method) {
    const text = absoluteUrl(url);
    return ['GET', 'POST'].includes(String(method || 'GET').toUpperCase())
      && text.includes('tzzb.10jqka.com.cn')
      && text.includes('/caishen_fund/');
  }

  function emitRecord(record) {
    window.postMessage({
      source: 'tzzb-stable-capture',
      pageUrl: location.href,
      record: {
        capturedAt: new Date().toISOString(),
        ...record
      }
    }, location.origin);
  }

  function isSuccessful(record) {
    return Number(record && record.status) >= 200 && Number(record && record.status) < 300;
  }

  function parseResponsePayload(record) {
    try {
      return JSON.parse(String(record && record.responseText || ''));
    } catch {
      return null;
    }
  }

  function firstValue(source, keys) {
    for (const key of keys) {
      if (source && source[key] !== undefined && source[key] !== null) {
        return String(source[key]);
      }
    }
    return '';
  }

  function isActiveAccount(source) {
    const inactiveValues = new Set(['0', 'false', 'disabled', 'inactive']);
    for (const key of ['access_upload', 'is_active', 'active', 'enabled', 'is_valid']) {
      if (!Object.prototype.hasOwnProperty.call(source || {}, key)) continue;
      if (inactiveValues.has(String(source[key]).toLowerCase())) return false;
    }
    return true;
  }

  function normalizeAccount(source, type) {
    if (!source || typeof source !== 'object' || !isActiveAccount(source)) return null;
    const manualId = firstValue(source, ['manual_id', 'manualid']);
    const listedFundKey = firstValue(source, ['fund_key', 'fundkey']);
    const explicitRzrqKey = firstValue(source, ['rzrq_fund_key', 'rzrqfundkey']);
    const isRzrqType = String(type || '').toLowerCase().includes('rzrq') || Boolean(explicitRzrqKey);
    const rzrqFundKey = isRzrqType ? (explicitRzrqKey || listedFundKey) : '';
    const fundKey = isRzrqType && !explicitRzrqKey ? '' : listedFundKey;
    const fundid = firstValue(source, ['fundid', 'fund_id']);
    const custid = firstValue(source, ['custid', 'cust_id']);
    if (![manualId, fundKey, rzrqFundKey, fundid, custid].some(Boolean)) return null;
    return {
      type,
      manualId,
      fundKey,
      rzrqFundKey,
      fundid,
      custid,
      key: [type, manualId, fundKey, rzrqFundKey, fundid, custid].join('|')
    };
  }

  function parseActiveAccounts(record) {
    const payload = parseResponsePayload(record);
    const data = payload && payload.ex_data;
    if (!data || typeof data !== 'object') return [];
    const knownAccountArrays = new Set(['common', 'rzrq', 'fund', 'manual']);
    const parsed = [];
    for (const [type, value] of Object.entries(data)) {
      if (!Array.isArray(value)) continue;
      const candidates = value.filter((item) => item && typeof item === 'object' && isActiveAccount(item));
      const normalized = candidates.map((item) => normalizeAccount(item, type));
      const isAccountArray = knownAccountArrays.has(type) || normalized.some(Boolean);
      if (!isAccountArray) continue;
      normalized.forEach((account, index) => {
        if (account) {
          parsed.push(account);
          return;
        }
        console.warn(`[tzzb-stable-capture] unsupported active account parameters in ${type}[${index}]`);
      });
    }
    return [...new Map(parsed.map((account) => [account.key, account])).values()];
  }

  function accountFromRequestParams(params) {
    const requested = {
      manualId: params.get('manual_id') || params.get('manualid') || '',
      fundKey: params.get('fund_key') || '',
      rzrqFundKey: params.get('rzrq_fund_key') || '',
      fundid: params.get('fundid') || '',
      custid: params.get('custid') || ''
    };
    const matched = activeAccounts.find((account) => (
      account.manualId === requested.manualId
      && account.fundKey === requested.fundKey
      && account.rzrqFundKey === requested.rzrqFundKey
      && account.fundid === requested.fundid
      && account.custid === requested.custid
    ));
    if (matched) return matched;
    return normalizeAccount({
      manual_id: requested.manualId,
      fund_key: requested.fundKey,
      rzrq_fund_key: requested.rzrqFundKey,
      fundid: requested.fundid,
      custid: requested.custid
    }, requested.rzrqFundKey ? 'rzrq' : 'common');
  }

  function compactDate(value) {
    const compact = String(value || '').replace(/\D/g, '');
    return /^\d{8}$/.test(compact) ? compact : '';
  }

  function shanghaiClock(value) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(value instanceof Date ? value : new Date(value));
    const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return {
      date: `${fields.year}${fields.month}${fields.day}`,
      minutes: Number(fields.hour) * 60 + Number(fields.minute)
    };
  }

  function reviewDate(calendar) {
    if (!calendar || typeof calendar !== 'object') return '';
    const lastTradingDay = compactDate(calendar.last_trading_day);
    if (!lastTradingDay) return '';

    const systemTime = Number(calendar.system_time);
    const clock = shanghaiClock(Number.isFinite(systemTime) && systemTime > 0 ? systemTime : Date.now());
    const isCurrentTradingDay = Number(calendar.is_trading_day) === 1
      && lastTradingDay === clock.date;
    if (isCurrentTradingDay && clock.minutes < (15 * 60 + 35)) {
      return compactDate(calendar.prev_trading_day);
    }
    return lastTradingDay;
  }

  function isDayTradeSummary(record) {
    return record
      && String(record.method || '').toUpperCase() === 'POST'
      && isSuccessful(record)
      && endpointName(record.url) === 'merge_day_trading';
  }

  function detailReadKey(params, targetDate) {
    return [
      params.get('user_id') || params.get('userid') || '',
      params.get('manual_id') || params.get('manualid') || '',
      params.get('fund_key') || '',
      params.get('rzrq_fund_key') || '',
      params.get('fundid') || '',
      params.get('custid') || '',
      targetDate
    ].join('|');
  }

  function detailRequestUrl(summaryUrl) {
    const url = new URL(absoluteUrl(summaryUrl));
    url.pathname = url.pathname.replace(
      /\/pc\/account\/v1\/merge_day_trading$/,
      '/pc/account/v2/get_money_history'
    );
    return url.href;
  }

  function calendarRequestUrl(accountListUrl) {
    const url = new URL(absoluteUrl(accountListUrl));
    url.pathname = url.pathname.replace(
      /\/pc\/account\/v1\/account_list$/,
      '/stock_common/v1/last_trading_day'
    );
    return url.href;
  }

  function ensureTradingCalendar(accountListRecord) {
    if (calendarReadPromise || typeof originalFetch !== 'function') return;
    if (tradingCalendar && Date.now() - calendarReadAt < calendarRefreshMs) return;
    tradingCalendar = null;
    const url = calendarRequestUrl(accountListRecord.url);
    calendarReadPromise = (async () => {
      const response = await originalFetch.call(window, url, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: String(accountListRecord.requestPostData || '')
      });
      const responseText = await response.clone().text();
      captureResponse({
        type: 'fetch',
        method: 'POST',
        status: response.status,
        url: response.url || url,
        requestPostData: String(accountListRecord.requestPostData || ''),
        responseText
      });
    })().catch((error) => {
      console.warn('[tzzb-stable-capture] trading calendar read failed', error);
    }).finally(() => {
      calendarReadPromise = null;
      flushPendingSummaries();
      scheduleAccountBackfill();
    });
  }

  function detailRequestBody(summaryParams, targetDate, page) {
    return new URLSearchParams({
      terminal: summaryParams.get('terminal') || '1',
      version: summaryParams.get('version') || '0.0.0',
      userid: summaryParams.get('userid') || summaryParams.get('user_id') || '',
      user_id: summaryParams.get('user_id') || summaryParams.get('userid') || '',
      manual_id: summaryParams.get('manual_id') || summaryParams.get('manualid') || '',
      fund_key: summaryParams.get('fund_key') || '',
      rzrq_fund_key: summaryParams.get('rzrq_fund_key') || '',
      fundid: summaryParams.get('fundid') || '',
      custid: summaryParams.get('custid') || '',
      start_date: targetDate,
      end_date: targetDate,
      query_list: '[]',
      page: String(page),
      count: '200',
      sort_type: '',
      sort_order: '1',
      h5id: String(Date.now() + page)
    }).toString();
  }

  function accountRequestBody(templateBody, account, endpoint, targetDate, page = 1) {
    const params = new URLSearchParams(templateBody || '');
    params.set('manual_id', account.manualId);
    if (params.has('manualid')) params.set('manualid', account.manualId);
    params.set('fund_key', account.fundKey);
    params.set('rzrq_fund_key', account.rzrqFundKey);
    if (params.has('fundid') || account.fundid) params.set('fundid', account.fundid);
    if (params.has('custid') || account.custid) params.set('custid', account.custid);
    if (endpoint === 'get_money_history') {
      params.set('start_date', targetDate);
      params.set('end_date', targetDate);
      params.set('page', String(page));
      params.set('count', params.get('count') || '200');
      if (!params.has('query_list')) params.set('query_list', '[]');
    }
    return params.toString();
  }

  async function fetchAndCapture(template, body) {
    const response = await originalFetch.call(window, template.url, {
      method: template.method,
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body
    });
    const responseText = await response.clone().text();
    const record = {
      type: 'fetch',
      method: template.method,
      status: response.status,
      url: response.url || template.url,
      requestPostData: body,
      responseText
    };
    captureResponse(record);
    return { response, responseText };
  }

  async function backfillAccountEndpoint(endpoint, template, account, targetDate) {
    if (endpoint !== 'get_money_history') {
      await fetchAndCapture(template, accountRequestBody(
        template.requestPostData,
        account,
        endpoint,
        targetDate
      ));
      return;
    }

    let page = 1;
    let maxPage = 1;
    do {
      const { response, responseText } = await fetchAndCapture(template, accountRequestBody(
        template.requestPostData,
        account,
        endpoint,
        targetDate,
        page
      ));
      if (response.ok === false) break;
      try {
        const payload = JSON.parse(responseText);
        maxPage = Math.max(
          1,
          Math.min(maxDetailPages, Number(payload && payload.ex_data && payload.ex_data.max_page) || 1)
        );
      } catch {
        break;
      }
      page += 1;
    } while (page <= maxPage);
  }

  function accountBackfillKey(endpoint, account, targetDate) {
    return `${endpoint}|${account.key}|${targetDate}`;
  }

  function hasPendingAccountBackfill() {
    if (calendarReadPromise) return false;
    const targetDate = reviewDate(tradingCalendar);
    if (!targetDate || !activeAccounts.length || !requestTemplates.size) return false;
    const now = Date.now();
    for (const endpoint of requestTemplates.keys()) {
      for (const account of activeAccounts) {
        const lastReadAt = backfillReadAt.get(accountBackfillKey(endpoint, account, targetDate)) || 0;
        if (now - lastReadAt >= detailReadWindowMs) return true;
      }
    }
    return false;
  }

  async function runAccountBackfill() {
    const targetDate = reviewDate(tradingCalendar);
    if (!targetDate || !activeAccounts.length) return;
    for (const [endpoint, template] of requestTemplates) {
      for (const account of activeAccounts) {
        const key = accountBackfillKey(endpoint, account, targetDate);
        const now = Date.now();
        if (now - (backfillReadAt.get(key) || 0) < detailReadWindowMs) continue;
        backfillReadAt.set(key, now);
        try {
          await backfillAccountEndpoint(endpoint, template, account, targetDate);
        } catch (error) {
          console.warn(`[tzzb-stable-capture] ${endpoint} backfill failed`, error);
        }
      }
    }
  }

  function scheduleAccountBackfill() {
    if (backfillScheduled || !hasPendingAccountBackfill()) return;
    backfillScheduled = true;
    backfillChain = backfillChain
      .then(runAccountBackfill)
      .catch((error) => {
        console.warn('[tzzb-stable-capture] account backfill failed', error);
      })
      .finally(() => {
        backfillScheduled = false;
        if (hasPendingAccountBackfill()) scheduleAccountBackfill();
      });
  }

  function rememberRequestTemplate(record) {
    const endpoint = endpointName(record.url);
    if (!backfillEndpoints.has(endpoint)) return;
    if (!requestTemplates.has(endpoint)) {
      requestTemplates.set(endpoint, {
        url: absoluteUrl(record.url),
        method: String(record.method || 'POST').toUpperCase(),
        requestPostData: String(record.requestPostData || '')
      });
    }
    scheduleAccountBackfill();
  }

  async function captureTradeDetails(summaryUrl, summaryBody) {
    if (typeof originalFetch !== 'function' || calendarReadPromise) return;
    const targetDate = reviewDate(tradingCalendar);
    if (!targetDate) return;

    const summaryParams = new URLSearchParams(summaryBody || '');
    const readKey = detailReadKey(summaryParams, targetDate);
    if (!readKey.replaceAll('|', '')) return;

    const now = Date.now();
    const account = accountFromRequestParams(summaryParams);
    const sharedBackfillKey = account
      ? accountBackfillKey('get_money_history', account, targetDate)
      : '';
    const lastReadAt = Math.max(
      detailReadAt.get(readKey) || 0,
      sharedBackfillKey ? (backfillReadAt.get(sharedBackfillKey) || 0) : 0
    );
    if (now - lastReadAt < detailReadWindowMs) return;
    detailReadAt.set(readKey, now);
    if (sharedBackfillKey) backfillReadAt.set(sharedBackfillKey, now);

    const url = detailRequestUrl(summaryUrl);
    let page = 1;
    let maxPage = 1;
    do {
      const body = detailRequestBody(summaryParams, targetDate, page);
      const response = await originalFetch.call(window, url, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body
      });
      const responseText = await response.clone().text();
      captureResponse({
        type: 'fetch',
        method: 'POST',
        status: response.status,
        url: response.url || url,
        requestPostData: body,
        responseText
      });
      if (response.ok === false) break;

      try {
        const payload = JSON.parse(responseText);
        maxPage = Math.max(
          1,
          Math.min(maxDetailPages, Number(payload && payload.ex_data && payload.ex_data.max_page) || 1)
        );
      } catch {
        break;
      }
      page += 1;
    } while (page <= maxPage);
  }

  function flushPendingSummaries() {
    if (calendarReadPromise || !reviewDate(tradingCalendar)) return;
    const pending = [...pendingSummaries.values()];
    pendingSummaries.clear();
    for (const summary of pending) {
      captureTradeDetails(summary.url, summary.requestPostData).catch((error) => {
        console.warn('[tzzb-stable-capture] trade detail read failed', error);
      });
    }
  }

  function queueTradeDetails(record) {
    const params = new URLSearchParams(record.requestPostData || '');
    const key = detailReadKey(params, 'pending');
    pendingSummaries.set(key, record);
    flushPendingSummaries();
  }

  function captureResponse(record) {
    emitRecord(record);
    if (isSuccessful(record) && endpointName(record.url) === 'account_list') {
      activeAccounts = parseActiveAccounts(record);
      ensureTradingCalendar(record);
      scheduleAccountBackfill();
      return;
    }
    if (isSuccessful(record) && endpointName(record.url) === 'last_trading_day') {
      const payload = parseResponsePayload(record);
      tradingCalendar = payload && payload.ex_data && typeof payload.ex_data === 'object'
        ? payload.ex_data
        : null;
      calendarReadAt = Date.now();
      if (tradingCalendar) flushPendingSummaries();
      scheduleAccountBackfill();
      return;
    }
    if (isSuccessful(record)) rememberRequestTemplate(record);
    if (isDayTradeSummary(record)) queueTradeDetails(record);
  }

  if (typeof originalFetch === 'function') {
    window.fetch = async function patchedFetch(input, init) {
      const response = await originalFetch.apply(this, arguments);
      const url = typeof input === 'string' ? input : input && input.url;
      const method = (init && init.method) || (input && input.method) || 'GET';

      if (shouldCapture(url || response.url, method)) {
        response.clone().text().then((text) => captureResponse({
          type: 'fetch',
          method: String(method || 'GET').toUpperCase(),
          status: response.status,
          url: response.url || absoluteUrl(url),
          requestPostData: init && typeof init.body === 'string' ? init.body : '',
          responseText: text
        })).catch((error) => console.warn('[tzzb-stable-capture] fetch read failed', error));
      }

      return response;
    };
  }

  const OriginalXHR = window.XMLHttpRequest;
  if (typeof OriginalXHR === 'function') {
    window.XMLHttpRequest = function PatchedXMLHttpRequest() {
      const xhr = new OriginalXHR();
      let requestMethod = 'GET';
      let requestUrl = '';
      let requestBody = '';

      const originalOpen = xhr.open;
      xhr.open = function patchedOpen(method, url) {
        requestMethod = String(method || 'GET').toUpperCase();
        requestUrl = absoluteUrl(url);
        return originalOpen.apply(xhr, arguments);
      };

      const originalSend = xhr.send;
      xhr.send = function patchedSend(body) {
        requestBody = typeof body === 'string' ? body : '';
        return originalSend.apply(xhr, arguments);
      };

      xhr.addEventListener('load', function onLoad() {
        if (!shouldCapture(requestUrl, requestMethod)) return;
        captureResponse({
          type: 'xhr',
          method: requestMethod,
          status: xhr.status,
          url: requestUrl,
          requestPostData: requestBody,
          responseText: xhr.responseText
        });
      });

      return xhr;
    };
  }

  console.info('[tzzb-stable-capture] installed');
}());
