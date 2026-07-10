import { TzzbSyncQueue, buildCaptureRecord, scheduleSyncDelayMs } from './shared-core.js';

const HELPER_BASE = 'http://127.0.0.1:8787';
const STORAGE_KEYS = {
  queue: 'tzzbQueue',
  lastPageUrl: 'tzzbLastPageUrl',
  lastError: 'tzzbLastError',
  helperOnline: 'tzzbHelperOnline'
};
let syncTimer = null;

function storageGet(keys) {
  return chrome.storage.local.get(keys);
}

function storageSet(value) {
  return chrome.storage.local.set(value);
}

async function loadQueue() {
  const data = await storageGet([STORAGE_KEYS.queue]);
  return TzzbSyncQueue.fromSnapshot(data[STORAGE_KEYS.queue] || {});
}

async function saveQueue(queue) {
  await storageSet({ [STORAGE_KEYS.queue]: queue.snapshot() });
  await updateBadge(queue);
}

async function updateBadge(queue) {
  const pending = queue.stats().pendingCount;
  await chrome.action.setBadgeText({ text: pending ? String(Math.min(pending, 999)) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: pending ? '#f04452' : '#00b578' });
}

async function helperHealth() {
  try {
    const response = await fetch(`${HELPER_BASE}/api/tzzb-health`, { cache: 'no-store' });
    const data = await response.json();
    const ok = Boolean(response.ok && data.ok);
    await storageSet({
      [STORAGE_KEYS.helperOnline]: ok,
      [STORAGE_KEYS.lastError]: ok ? '' : (data.error || `HTTP ${response.status}`)
    });
    return { ok, data };
  } catch (error) {
    await storageSet({
      [STORAGE_KEYS.helperOnline]: false,
      [STORAGE_KEYS.lastError]: error.message
    });
    return { ok: false, error: error.message };
  }
}

async function syncQueue() {
  const queue = await loadQueue();
  if (!queue.stats().pendingCount) {
    await helperHealth();
    await saveQueue(queue);
    return queue.stats();
  }

  const meta = await storageGet([STORAGE_KEYS.lastPageUrl]);
  const payload = queue.buildPayload({ pageUrl: meta[STORAGE_KEYS.lastPageUrl] || '' });

  try {
    const response = await fetch(`${HELPER_BASE}/api/tzzb-capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
    queue.markSynced(payload.records.length);
    await storageSet({
      [STORAGE_KEYS.helperOnline]: true,
      [STORAGE_KEYS.lastError]: ''
    });
  } catch (error) {
    await storageSet({
      [STORAGE_KEYS.helperOnline]: false,
      [STORAGE_KEYS.lastError]: error.message
    });
  }

  await saveQueue(queue);
  return queue.stats();
}

function scheduleSyncQueue() {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    syncQueue();
  }, scheduleSyncDelayMs());
}

async function status() {
  const queue = await loadQueue();
  const data = await storageGet([
    STORAGE_KEYS.helperOnline,
    STORAGE_KEYS.lastError,
    STORAGE_KEYS.lastPageUrl
  ]);
  return {
    ...queue.stats(),
    helperOnline: Boolean(data[STORAGE_KEYS.helperOnline]),
    lastError: data[STORAGE_KEYS.lastError] || '',
    lastPageUrl: data[STORAGE_KEYS.lastPageUrl] || ''
  };
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('tzzb-sync', { periodInMinutes: 1 });
  syncQueue();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('tzzb-sync', { periodInMinutes: 1 });
  syncQueue();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'tzzb-sync') syncQueue();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message.type === 'TZZB_CAPTURE_RECORD') {
      const queue = await loadQueue();
      queue.enqueue([buildCaptureRecord(message.record)]);
      await storageSet({ [STORAGE_KEYS.lastPageUrl]: message.pageUrl || sender.tab?.url || '' });
      await saveQueue(queue);
      scheduleSyncQueue();
      return { ok: true, ...queue.stats() };
    }

    if (message.type === 'TZZB_GET_STATUS') {
      await helperHealth();
      return { ok: true, ...(await status()) };
    }

    if (message.type === 'TZZB_SYNC_NOW') {
      return { ok: true, ...(await syncQueue()), ...(await status()) };
    }

    if (message.type === 'TZZB_CLEAR_QUEUE') {
      const queue = await loadQueue();
      queue.clear();
      await saveQueue(queue);
      return { ok: true, ...(await status()) };
    }

    return { ok: false, error: 'Unknown message type' };
  })().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
