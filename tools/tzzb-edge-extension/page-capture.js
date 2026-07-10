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
  if (typeof originalFetch === 'function') {
    window.fetch = async function patchedFetch(input, init) {
      const response = await originalFetch.apply(this, arguments);
      const url = typeof input === 'string' ? input : input && input.url;
      const method = (init && init.method) || (input && input.method) || 'GET';

      if (shouldCapture(url || response.url, method)) {
        response.clone().text().then((text) => emitRecord({
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
        emitRecord({
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
