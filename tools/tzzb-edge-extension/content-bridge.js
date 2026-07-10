(function installTzzbContentBridge() {
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data || {};
    if (data.source !== 'tzzb-stable-capture' || !data.record) return;
    chrome.runtime.sendMessage({
      type: 'TZZB_CAPTURE_RECORD',
      pageUrl: data.pageUrl || location.href,
      record: data.record
    });
  });
}());
