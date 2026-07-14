(function installTzzbAutoPush() {
  const helperUrl = 'http://127.0.0.1:8787/api/tzzb-capture';
  const helperToken = '__TZZB_HELPER_TOKEN__';

  if (window.__tzzbAutoPush && window.__tzzbAutoPush.installed) {
    window.__tzzbAutoPush.push();
    return;
  }

  const records = [];

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

  function saveRecord(record) {
    records.push({
      capturedAt: new Date().toISOString(),
      ...record
    });
    console.log('[tzzb-auto]', record.status || '', record.method, record.url);
  }

  async function pushRecords() {
    const payload = {
      pageUrl: location.href,
      pushedAt: new Date().toISOString(),
      records
    };

    const response = await fetch(helperUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-TZZB-Helper-Token': helperToken
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    alert(`同花顺数据已推送到复盘助手：${data.records || 0} 条响应。请切回复盘页点“读取最新同花顺数据”。`);
    return data;
  }

  const originalFetch = window.fetch;
  window.fetch = async function patchedFetch(input, init) {
    const response = await originalFetch.apply(this, arguments);
    const url = typeof input === 'string' ? input : input && input.url;
    const method = (init && init.method) || (input && input.method) || 'GET';

    if (shouldCapture(url || response.url, method)) {
      response.clone().text().then((text) => saveRecord({
        type: 'fetch',
        method: String(method).toUpperCase(),
        status: response.status,
        url: response.url || absoluteUrl(url),
        responseText: text
      })).catch((error) => console.warn('[tzzb-auto] fetch read failed', error));
    }

    return response;
  };

  const OriginalXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function PatchedXMLHttpRequest() {
    const xhr = new OriginalXHR();
    let requestMethod = 'GET';
    let requestUrl = '';

    const originalOpen = xhr.open;
    xhr.open = function patchedOpen(method, url) {
      requestMethod = String(method || 'GET').toUpperCase();
      requestUrl = absoluteUrl(url);
      return originalOpen.apply(xhr, arguments);
    };

    xhr.addEventListener('load', function onLoad() {
      if (!shouldCapture(requestUrl, requestMethod)) return;
      saveRecord({
        type: 'xhr',
        method: requestMethod,
        status: xhr.status,
        url: requestUrl,
        responseText: xhr.responseText
      });
    });

    return xhr;
  };

  window.__tzzbAutoPush = {
    installed: true,
    records,
    push: pushRecords
  };

  alert('同花顺复盘捕获已开启。请刷新或切换账户/持仓/资产页触发数据加载；数据加载后再次点击这个书签即可推送到复盘助手。');
}());
