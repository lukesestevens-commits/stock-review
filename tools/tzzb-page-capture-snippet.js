(function installTzzbCapture() {
  if (window.__tzzbCapture && window.__tzzbCapture.installed) {
    console.log('[tzzb-capture] already installed');
    return;
  }

  const records = [];
  const shouldCapture = (url, method) => {
    const text = String(url || '');
    return ['GET', 'POST'].includes(String(method || 'GET').toUpperCase())
      && text.includes('tzzb.10jqka.com.cn')
      && text.includes('/caishen_fund/');
  };

  const saveRecord = (record) => {
    records.push({
      capturedAt: new Date().toISOString(),
      ...record
    });
    console.log(`[tzzb-capture] ${record.status || ''} ${record.method} ${record.url}`);
  };

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
        url: response.url || String(url),
        responseText: text
      })).catch((error) => console.warn('[tzzb-capture] fetch read failed', error));
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
      requestUrl = String(url || '');
      return originalOpen.apply(xhr, arguments);
    };

    xhr.addEventListener('load', function onLoad() {
      const absoluteUrl = new URL(requestUrl, location.href).href;
      if (!shouldCapture(absoluteUrl, requestMethod)) return;

      saveRecord({
        type: 'xhr',
        method: requestMethod,
        status: xhr.status,
        url: absoluteUrl,
        responseText: xhr.responseText
      });
    });

    return xhr;
  };

  window.__tzzbCapture = {
    installed: true,
    records,
    download(filename = `tzzb-captured-${Date.now()}.json`) {
      const blob = new Blob([JSON.stringify(records, null, 2)], { type: 'application/json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      console.log(`[tzzb-capture] downloaded ${records.length} records`);
    }
  };

  console.log('[tzzb-capture] installed. Refresh this page, wait for account data to load, then run: __tzzbCapture.download()');
}());
