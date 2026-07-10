import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapTzzbCaptureToReview } from './tzzb-review-mapper.mjs';
import { fetchMarketSnapshot } from './market-public-data.mjs';
import { analyzeTzzbEndpointCoverage, mergeCaptureRecords } from './tzzb-endpoint-coverage.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const helperVersion = '2026.07.10-sync-repair';
const dataDir = process.env.TZZB_DATA_DIR
  ? path.resolve(process.env.TZZB_DATA_DIR)
  : path.join(rootDir, 'data', 'tzzb');
const latestPath = path.join(dataDir, 'latest-capture.json');
const cloudSyncPath = path.join(dataDir, 'cloud-sync-latest.json');
const port = Number(process.env.TZZB_HELPER_PORT || 8787);
const syncAccessKey = process.env.TZZB_SYNC_ACCESS_KEY || '';
const cloudSyncUrl = process.env.TZZB_CLOUD_SYNC_URL || '';
const cloudSyncKey = process.env.TZZB_CLOUD_SYNC_KEY || '';

function localDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    ...headers
  });
  res.end(body);
}

function sendJson(res, status, value) {
  send(res, status, JSON.stringify(value, null, 2), {
    'Content-Type': 'application/json; charset=utf-8'
  });
}

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'text/plain; charset=utf-8';
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function buildBookmarklet() {
  const source = await fs.readFile(path.join(rootDir, 'tools', 'tzzb-bookmarklet-source.js'), 'utf8');
  return `javascript:${encodeURIComponent(source)}`;
}

async function handleCapture(req, res) {
  const body = await readRequestBody(req);
  const payload = JSON.parse(body || '{}');
  const targetDate = localDate(payload.pushedAt || new Date());
  const incomingRecords = (Array.isArray(payload.records) ? payload.records : [])
    .filter((record) => localDate(record.capturedAt || payload.pushedAt || new Date()) === targetDate);
  let existing = {};
  try {
    existing = await readLatestCapture();
  } catch {
    existing = {};
  }
  const existingRecords = existing.targetDate === targetDate && Array.isArray(existing.records)
    ? existing.records
    : [];
  const records = mergeCaptureRecords(existingRecords, incomingRecords, { targetDate });
  const endpointCoverage = analyzeTzzbEndpointCoverage(records);
  await fs.mkdir(dataDir, { recursive: true });
  const stored = {
    ...existing,
    ...payload,
    targetDate,
    receivedAt: new Date().toISOString(),
    records,
    endpointCoverage
  };
  await fs.writeFile(latestPath, JSON.stringify(stored, null, 2), 'utf8');
  const cloudSync = await uploadCloudSyncPayload(stored);
  sendJson(res, 200, { ok: true, records: incomingRecords.length, storedRecords: records.length, endpointCoverage, cloudSync });
}

async function readLatestCapture() {
  return JSON.parse(await fs.readFile(latestPath, 'utf8'));
}

function syncRequestKey(req, url) {
  const headerKey = req.headers['x-tzzb-sync-key'] || '';
  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return String(headerKey || bearer || url.searchParams.get('key') || '');
}

function isSyncAuthorized(req, url) {
  return Boolean(syncAccessKey && syncRequestKey(req, url) === syncAccessKey);
}

function assertSyncAuthorized(req, res, url) {
  if (!syncAccessKey) {
    sendJson(res, 503, { ok: false, error: '云同步访问码未配置。' });
    return false;
  }
  if (!isSyncAuthorized(req, url)) {
    sendJson(res, 401, { ok: false, error: '云同步访问码无效。' });
    return false;
  }
  return true;
}

async function readCloudSyncCapture() {
  return JSON.parse(await fs.readFile(cloudSyncPath, 'utf8'));
}

async function uploadCloudSyncPayload(payload) {
  if (!cloudSyncUrl || !cloudSyncKey) return { enabled: false };
  try {
    const response = await fetch(`${cloudSyncUrl.replace(/\/$/, '')}/api/sync/tzzb`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-TZZB-Sync-Key': cloudSyncKey
      },
      body: JSON.stringify(payload)
    });
    let data = {};
    try {
      data = await response.json();
    } catch {
      data = {};
    }
    return {
      enabled: true,
      ok: Boolean(response.ok && data.ok),
      status: response.status,
      error: response.ok && data.ok ? '' : (data.error || `HTTP ${response.status}`)
    };
  } catch (error) {
    return { enabled: true, ok: false, status: 0, error: error.message };
  }
}

async function uploadSavedCaptureOnStartup() {
  if (!cloudSyncUrl || !cloudSyncKey) return;
  try {
    const result = await uploadCloudSyncPayload(await readLatestCapture());
    if (result.ok) {
      console.log('已把本机最新同花顺快照补传到云端。');
    } else {
      console.error(`启动补传云端失败：${result.error || `HTTP ${result.status}`}`);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') console.error(`启动补传云端失败：${error.message}`);
  }
}

function buildCaptureResponse(payload, fallbackSource = 'cloud-sync') {
  const records = Array.isArray(payload.records) ? payload.records : [];
  const endpointCoverage = analyzeTzzbEndpointCoverage(records);
  const targetDate = payload.targetDate || localDate(payload.receivedAt || new Date());
  const review = mapTzzbCaptureToReview(records, { targetDate });
  return {
    ok: true,
    raw: {
      source: payload.source || fallbackSource,
      targetDate,
      receivedAt: payload.receivedAt,
      pageUrl: payload.pageUrl,
      records: records.length,
      readyForReview: endpointCoverage.readyForReview,
      endpointCoverage,
      importAudit: review.tzzb.importAudit
    },
    review
  };
}

async function writeCloudSyncPayload(payload) {
  const targetDate = localDate(payload.pushedAt || new Date());
  const incomingRecords = (Array.isArray(payload.records) ? payload.records : [])
    .filter((record) => localDate(record.capturedAt || payload.pushedAt || new Date()) === targetDate);
  let existing = {};
  try {
    existing = await readCloudSyncCapture();
  } catch {
    existing = {};
  }
  const existingRecords = existing.targetDate === targetDate && Array.isArray(existing.records)
    ? existing.records
    : [];
  const records = mergeCaptureRecords(existingRecords, incomingRecords, { targetDate });
  const stored = {
    ...existing,
    ...payload,
    source: payload.source || 'cloud-sync',
    targetDate,
    receivedAt: new Date().toISOString(),
    records,
    endpointCoverage: analyzeTzzbEndpointCoverage(records)
  };
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(cloudSyncPath, JSON.stringify(stored, null, 2), 'utf8');
  return stored;
}

async function handleCloudSyncUpload(req, res) {
  const body = await readRequestBody(req);
  const payload = JSON.parse(body || '{}');
  const stored = await writeCloudSyncPayload(payload);
  sendJson(res, 200, buildCaptureResponse(stored, 'cloud-sync'));
}

async function handleCloudSyncLatest(res) {
  try {
    sendJson(res, 200, buildCaptureResponse(await readCloudSyncCapture(), 'cloud-sync'));
  } catch {
    sendJson(res, 404, {
      ok: false,
      error: '云端还没有收到同花顺同步数据。'
    });
  }
}

async function handleCloudSyncHealth(res) {
  try {
    const payload = await readCloudSyncCapture();
    const records = Array.isArray(payload.records) ? payload.records : [];
    const endpointCoverage = analyzeTzzbEndpointCoverage(records);
    const review = mapTzzbCaptureToReview(records, {
      targetDate: payload.targetDate || localDate(payload.receivedAt || new Date())
    });
    sendJson(res, 200, {
      ok: true,
      targetDate: payload.targetDate || localDate(payload.receivedAt || new Date()),
      latestReceivedAt: payload.receivedAt || '',
      latestRecordCount: records.length,
      readyForReview: endpointCoverage.readyForReview,
      endpointCoverage,
      importAudit: review.tzzb.importAudit
    });
  } catch {
    sendJson(res, 200, {
      ok: true,
      targetDate: localDate(new Date()),
      latestReceivedAt: '',
      latestRecordCount: 0,
      readyForReview: false,
      endpointCoverage: analyzeTzzbEndpointCoverage([])
    });
  }
}

async function handleLatest(res) {
  try {
    const payload = await readLatestCapture();
    const records = Array.isArray(payload.records) ? payload.records : [];
    const endpointCoverage = analyzeTzzbEndpointCoverage(records);
    const review = mapTzzbCaptureToReview(records, {
      targetDate: payload.targetDate || localDate(payload.receivedAt || new Date())
    });
    sendJson(res, 200, {
      ok: true,
      raw: {
        source: payload.source || 'bookmarklet',
        targetDate: payload.targetDate || localDate(payload.receivedAt || new Date()),
        receivedAt: payload.receivedAt,
        pageUrl: payload.pageUrl,
        records: records.length,
        readyForReview: endpointCoverage.readyForReview,
        endpointCoverage,
        importAudit: review.tzzb.importAudit
      },
      review
    });
  } catch (error) {
    sendJson(res, 404, {
      ok: false,
      error: '还没有收到同花顺捕获数据。请先在同花顺页面点击捕获书签。'
    });
  }
}

async function handleHealth(res) {
  try {
    const payload = await readLatestCapture();
    const records = Array.isArray(payload.records) ? payload.records : [];
    const endpointCoverage = analyzeTzzbEndpointCoverage(records);
    const review = mapTzzbCaptureToReview(records, {
      targetDate: payload.targetDate || localDate(payload.receivedAt || new Date())
    });
    sendJson(res, 200, {
      ok: true,
      version: helperVersion,
      targetDate: payload.targetDate || localDate(payload.receivedAt || new Date()),
      latestReceivedAt: payload.receivedAt || '',
      latestRecordCount: records.length,
      readyForReview: endpointCoverage.readyForReview,
      endpointCoverage,
      importAudit: review.tzzb.importAudit
    });
  } catch {
    sendJson(res, 200, {
      ok: true,
      version: helperVersion,
      targetDate: localDate(new Date()),
      latestReceivedAt: '',
      latestRecordCount: 0,
      readyForReview: false,
      endpointCoverage: analyzeTzzbEndpointCoverage([])
    });
  }
}

async function handleClear(res) {
  await fs.rm(latestPath, { force: true });
  sendJson(res, 200, { ok: true, cleared: true });
}

async function handleMarketSnapshot(res) {
  try {
    sendJson(res, 200, {
      ok: true,
      market: await fetchMarketSnapshot()
    });
  } catch (error) {
    sendJson(res, 502, {
      ok: false,
      error: `无法读取公开市场数据：${error.message}`
    });
  }
}

function extensionInfo() {
  return {
    ok: true,
    extensionDir: path.join(rootDir, 'tools', 'tzzb-edge-extension'),
    edgeExtensionsUrl: 'edge://extensions/',
    chromeExtensionsUrl: 'chrome://extensions/',
    instructions: [
      '打开 Edge 的扩展管理页 edge://extensions/',
      '打开“开发人员模式”。',
      '点击“加载解压缩的扩展”。',
      `选择本文件夹：${path.join(rootDir, 'tools', 'tzzb-edge-extension')}`,
      '之后打开或刷新同花顺投资账本页面，扩展会自动捕获并同步。'
    ]
  };
}

async function handleStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let filePath = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
  const absolute = path.join(rootDir, filePath);

  if (!absolute.startsWith(rootDir)) {
    send(res, 403, 'Forbidden');
    return;
  }

  const body = await fs.readFile(absolute);
  send(res, 200, body, { 'Content-Type': contentType(absolute) });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      send(res, 204, '');
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'GET' && url.pathname === '/api/tzzb-latest') {
      await handleLatest(res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/sync/tzzb') {
      if (!assertSyncAuthorized(req, res, url)) return;
      await handleCloudSyncUpload(req, res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/sync/latest') {
      if (!assertSyncAuthorized(req, res, url)) return;
      await handleCloudSyncLatest(res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/sync/health') {
      if (!assertSyncAuthorized(req, res, url)) return;
      await handleCloudSyncHealth(res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/tzzb-health') {
      await handleHealth(res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/tzzb-extension-info') {
      sendJson(res, 200, extensionInfo());
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/market-snapshot') {
      await handleMarketSnapshot(res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/tzzb-bookmarklet') {
      sendJson(res, 200, { bookmarklet: await buildBookmarklet() });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/tzzb/bookmarklet.js') {
      const body = await fs.readFile(path.join(rootDir, 'tools', 'tzzb-bookmarklet-source.js'));
      send(res, 200, body, { 'Content-Type': 'text/javascript; charset=utf-8' });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/tzzb-capture') {
      await handleCapture(req, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/tzzb-clear') {
      await handleClear(res);
      return;
    }

    if (req.method === 'GET') {
      await handleStatic(req, res);
      return;
    }

    send(res, 405, 'Method Not Allowed');
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`复盘助手已启动: http://127.0.0.1:${port}/`);
  console.log(`书签脚本地址: http://127.0.0.1:${port}/api/tzzb-bookmarklet`);
  void uploadSavedCaptureOnStartup();
});
