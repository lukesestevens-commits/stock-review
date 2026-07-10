function send(type) {
  return chrome.runtime.sendMessage({ type });
}

function formatTime(value) {
  if (!value) return '无';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false });
}

function setText(id, text, className = '') {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className = `value ${className}`.trim();
}

function render(status) {
  setText('helperOnline', status.helperOnline ? '在线' : '离线', status.helperOnline ? 'ok' : 'bad');
  setText('capturedCount', String(status.capturedCount || 0));
  setText('pendingCount', String(status.pendingCount || 0), status.pendingCount ? 'bad' : 'ok');
  const coverage = status.endpointCoverage || {};
  setText(
    'coverageStatus',
    coverage.readyForReview ? '可复盘' : `缺少${(coverage.missing || ['资金/持仓', '交易记录']).join('、')}`,
    coverage.readyForReview ? 'ok' : 'bad'
  );
  setText('lastSyncAt', formatTime(status.lastSyncAt));
  const error = document.getElementById('lastError');
  if (error) {
    error.textContent = status.lastError
      ? `同步提示：${status.lastError}`
      : '打开同花顺投资账本后会自动捕获，只同步到本机 127.0.0.1。';
  }
}

async function refresh() {
  const status = await send('TZZB_GET_STATUS');
  render(status);
}

document.getElementById('syncNow').addEventListener('click', async () => {
  render(await send('TZZB_SYNC_NOW'));
});

document.getElementById('clearQueue').addEventListener('click', async () => {
  render(await send('TZZB_CLEAR_QUEUE'));
});

refresh();
