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

  function localCompactDate(value = new Date()) {
    return [
      value.getFullYear(),
      String(value.getMonth() + 1).padStart(2, '0'),
      String(value.getDate()).padStart(2, '0')
    ].join('');
  }

  function isDayTradeSummary(record) {
    return record
      && record.method === 'POST'
      && record.status >= 200
      && record.status < 300
      && absoluteUrl(record.url).includes('/pc/account/v1/merge_day_trading');
  }

  const detailReadAt = new Map();
  const detailReadWindowMs = 30000;

  function detailReadKey(params, targetDate) {
    return [
      params.get('user_id') || params.get('userid') || '',
      params.get('manual_id') || '',
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

  async function captureSameDayTradeDetails(summaryUrl, summaryBody) {
    if (typeof originalFetch !== 'function') return;
    const summaryParams = new URLSearchParams(summaryBody || '');
    const targetDate = localCompactDate();
    const readKey = detailReadKey(summaryParams, targetDate);
    if (!readKey.replaceAll('|', '')) return;

    const lastReadAt = detailReadAt.get(readKey) || 0;
    if (Date.now() - lastReadAt < detailReadWindowMs) return;
    detailReadAt.set(readKey, Date.now());

    const url = detailRequestUrl(summaryUrl);
    let page = 1;
    let maxPage = 1;
    do {
      const body = new URLSearchParams({
        user_id: summaryParams.get('user_id') || summaryParams.get('userid') || '',
        manual_id: summaryParams.get('manual_id') || '',
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
        h5id: String(Date.now())
      }).toString();
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
        maxPage = Math.max(1, Math.min(50, Number(payload && payload.ex_data && payload.ex_data.max_page) || 1));
      } catch {
        break;
      }
      page += 1;
    } while (page <= maxPage);
  }

  function captureResponse(record) {
    emitRecord(record);
    if (!isDayTradeSummary(record)) return;
    captureSameDayTradeDetails(record.url, record.requestPostData).catch((error) => {
      console.warn('[tzzb-stable-capture] trade detail read failed', error);
    });
  }

  const originalFetch = window.fetch;
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
