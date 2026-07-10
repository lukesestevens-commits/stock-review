(function installTzzbStableCapture() {
  if (window.__tzzbStableCaptureInstalled) return;
  window.__tzzbStableCaptureInstalled = true;

  function absoluteUrl(url) {
    try {
      return new URL(url, location.href).href;
    } catch {
      return String(url || '');
    }
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

  const originalFetch = window.fetch;
  const detailRefreshMs = 30_000;
  const detailRequestedAt = new Map();

  function localCompactDate(value = new Date()) {
    return [
      value.getFullYear(),
      String(value.getMonth() + 1).padStart(2, '0'),
      String(value.getDate()).padStart(2, '0')
    ].join('');
  }

  function isDayTradeSummary(url, method, status) {
    return String(url || '').includes('/pc/account/v1/merge_day_trading')
      && String(method || '').toUpperCase() === 'POST'
      && Number(status || 0) >= 200
      && Number(status || 0) < 300;
  }

  function detailRequestBody(summaryParams, date, page) {
    return new URLSearchParams({
      terminal: summaryParams.get('terminal') || '1',
      version: summaryParams.get('version') || '0.0.0',
      userid: summaryParams.get('userid') || summaryParams.get('user_id') || '',
      user_id: summaryParams.get('user_id') || summaryParams.get('userid') || '',
      manual_id: summaryParams.get('manual_id') || '',
      fund_key: summaryParams.get('fund_key') || '',
      rzrq_fund_key: summaryParams.get('rzrq_fund_key') || '',
      fundid: summaryParams.get('fundid') || '',
      custid: summaryParams.get('custid') || '',
      start_date: date,
      end_date: date,
      query_list: '[]',
      page: String(page),
      count: '200',
      sort_type: '',
      sort_order: '1',
      h5id: String(Date.now() + page)
    }).toString();
  }

  async function captureSameDayTradeDetails(summaryUrl, summaryBody) {
    if (typeof originalFetch !== 'function') return;
    const summaryParams = new URLSearchParams(summaryBody || '');
    const accountId = [
      summaryParams.get('manual_id'),
      summaryParams.get('fund_key'),
      summaryParams.get('fundid'),
      summaryParams.get('custid'),
      summaryParams.get('user_id') || summaryParams.get('userid')
    ].filter(Boolean).join('|');
    if (!accountId) return;

    const date = localCompactDate();
    const requestKey = `${accountId}|${date}`;
    const now = Date.now();
    if (now - (detailRequestedAt.get(requestKey) || 0) < detailRefreshMs) return;
    detailRequestedAt.set(requestKey, now);

    const detailUrl = String(summaryUrl).replace(
      '/pc/account/v1/merge_day_trading',
      '/pc/account/v2/get_money_history'
    );
    let page = 1;
    let maxPage = 1;
    do {
      const body = detailRequestBody(summaryParams, date, page);
      const response = await originalFetch(detailUrl, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body
      });
      const text = await response.clone().text();
      emitRecord({
        type: 'fetch',
        method: 'POST',
        status: response.status,
        url: response.url || detailUrl,
        requestPostData: body,
        responseText: text
      });
      if (!response.ok) break;
      try {
        const payload = JSON.parse(text);
        maxPage = Math.max(1, Number(payload?.ex_data?.max_page || 1));
      } catch {
        maxPage = 1;
      }
      page += 1;
    } while (page <= maxPage);
  }

  function captureResponse(record) {
    emitRecord(record);
    if (!isDayTradeSummary(record.url, record.method, record.status)) return;
    captureSameDayTradeDetails(record.url, record.requestPostData).catch((error) => {
      console.warn('[tzzb-stable-capture] trade detail read failed', error);
    });
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
