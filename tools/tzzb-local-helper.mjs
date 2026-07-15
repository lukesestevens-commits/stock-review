import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapTzzbCaptureToReview } from './tzzb-review-mapper.mjs';
import { fetchMarketSnapshot } from './market-public-data.mjs';
import { createMarketSnapshotCache } from './market-snapshot-cache.mjs';
import { analyzeTzzbEndpointCoverage } from './tzzb-endpoint-coverage.mjs';
import { createDailyReviewSync } from './daily-review-sync.mjs';
import { normalizeCaptureEvidence } from './tzzb-evidence-adapter.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const helperVersion = '2026.07.15-daily-review-private-r12';
const dataDir = process.env.TZZB_DATA_DIR
  ? path.resolve(process.env.TZZB_DATA_DIR)
  : path.join(rootDir, 'data', 'tzzb');
const latestPath = path.join(dataDir, 'latest-capture.json');
const helperAuthTokenPath = path.join(dataDir, 'helper-auth-token.json');
const cloudSyncStatusPath = path.join(dataDir, 'cloud-sync-status.json');
const cloudOutboxDir = path.join(dataDir, 'cloud-outbox');
const dailyReviewStorePath = path.join(dataDir, 'daily-review-store.json');
const normalizedEvidencePath = path.join(dataDir, 'normalized-evidence-accumulator.json');
const rawArchiveDir = path.join(dataDir, 'raw-captures');
const dailyStateDir = path.join(dataDir, 'daily-state');
const rawCaptureRetentionMs = 30 * 24 * 60 * 60 * 1000;
const port = Number(process.env.TZZB_HELPER_PORT || 8787);
const syncAccessKey = process.env.TZZB_SYNC_ACCESS_KEY || '';
const cloudSyncUrl = process.env.TZZB_CLOUD_SYNC_URL || '';
const cloudSyncKey = process.env.TZZB_CLOUD_SYNC_KEY || '';
const sitesBypassToken = process.env.TZZB_SITES_BYPASS_TOKEN || '';
let cloudUploadTail = Promise.resolve();
let evidenceAccumulatorTail = Promise.resolve();
const marketSnapshots = createMarketSnapshotCache({
  load: () => fetchMarketSnapshot(),
  ttlMs: 60_000
});

function shanghaiDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const read = (type) => parts.find((part) => part.type === type)?.value || '';
  return `${read('year')}-${read('month')}-${read('day')}`;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(stableValue(value)));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function atomicWriteJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${globalThis.crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, JSON.stringify(value, null, 2), 'utf8');
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

async function loadOrCreateHelperAuthToken() {
  try {
    const stored = JSON.parse(await fs.readFile(helperAuthTokenPath, 'utf8'));
    if (/^[a-f0-9]{64}$/.test(String(stored?.token || ''))) return stored.token;
  } catch (error) {
    if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  const token = [...globalThis.crypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  await atomicWriteJson(helperAuthTokenPath, { token });
  await fs.chmod(helperAuthTokenPath, 0o600);
  return token;
}

const helperAuthToken = await loadOrCreateHelperAuthToken();

async function pruneRawCaptureArchives(now = Date.now()) {
  let entries = [];
  try {
    entries = await fs.readdir(rawArchiveDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  const cutoff = now - rawCaptureRetentionMs;
  await Promise.all(entries.filter((entry) => entry.isFile()).map(async (entry) => {
    const filePath = path.join(rawArchiveDir, entry.name);
    const stat = await fs.stat(filePath);
    if (stat.mtimeMs < cutoff) await fs.rm(filePath, { force: true });
  }));
}

function retentionTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return Number.NaN;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return Date.parse(`${value}T23:59:59.999+08:00`);
  }
  return Date.parse(value);
}

function firstRetentionTimestamp(value, fields) {
  for (const field of fields) {
    const timestamp = retentionTimestamp(value?.[field]);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return Number.NaN;
}

async function readJsonWithStat(filePath) {
  const stat = await fs.stat(filePath);
  try {
    return { value: JSON.parse(await fs.readFile(filePath, 'utf8')), stat };
  } catch {
    return { value: null, stat };
  }
}

async function pruneStaleJsonFile(filePath, now, fields, { preserveVerified = false } = {}) {
  let loaded;
  try {
    loaded = await readJsonWithStat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (
    preserveVerified
    && (
      loaded.value?.latestVerified?.dailyReview
      || (loaded.value?.dailyReview && loaded.value?.audit?.status === 'verified')
      || loaded.value?.status === 'verified'
      || loaded.value?.state === 'verified'
    )
  ) {
    return false;
  }
  const timestamp = firstRetentionTimestamp(loaded.value, fields);
  const effectiveTimestamp = Number.isFinite(timestamp) ? timestamp : loaded.stat.mtimeMs;
  if (effectiveTimestamp >= now - rawCaptureRetentionMs) return false;
  await fs.rm(filePath, { force: true });
  return true;
}

async function pruneStaleJsonDirectory(directory, now, options = {}) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  await Promise.all(entries.filter((entry) => entry.isFile()).map((entry) => (
    pruneStaleJsonFile(
      path.join(directory, entry.name),
      now,
      ['capturedAt', 'captureDate', 'receivedAt', 'createdAt', 'updatedAt'],
      options
    )
  )));
}

async function pruneNormalizedEvidenceAccumulator(now) {
  let state;
  try {
    state = JSON.parse(await fs.readFile(normalizedEvidencePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    const stat = await fs.stat(normalizedEvidencePath);
    if (stat.mtimeMs < now - rawCaptureRetentionMs) {
      await fs.rm(normalizedEvidencePath, { force: true });
    }
    return;
  }

  const cutoff = now - rawCaptureRetentionMs;
  const buckets = state?.buckets && typeof state.buckets === 'object' ? state.buckets : {};
  const routes = state?.routes && typeof state.routes === 'object' ? state.routes : {};
  const retainedBuckets = Object.fromEntries(Object.entries(buckets).filter(([, bucket]) => {
    const timestamp = firstRetentionTimestamp(bucket, ['lastCapturedAt', 'capturedAt', 'captureDate']);
    return Number.isFinite(timestamp) && timestamp >= cutoff;
  }));
  const retainedRoutes = Object.fromEntries(Object.entries(routes).filter(([captureDate, route]) => {
    const timestamp = firstRetentionTimestamp(
      { ...route, captureDate },
      ['resolvedAt', 'capturedAt', 'captureDate']
    );
    return Number.isFinite(timestamp) && timestamp >= cutoff;
  }));
  if (
    Object.keys(retainedBuckets).length !== Object.keys(buckets).length
    || Object.keys(retainedRoutes).length !== Object.keys(routes).length
  ) {
    await atomicWriteJson(normalizedEvidencePath, {
      ...state,
      buckets: retainedBuckets,
      routes: retainedRoutes
    });
  }
}

function dateBefore(date, days) {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return '';
  parsed.setUTCDate(parsed.getUTCDate() - days);
  return parsed.toISOString().slice(0, 10);
}

async function archiveRawCapture(payload, capturedAt) {
  const contentHash = await sha256(payload);
  const timestamp = capturedAt.replace(/[^0-9A-Za-z_-]/g, '-');
  await atomicWriteJson(path.join(rawArchiveDir, `${timestamp}-${contentHash.slice(0, 16)}.json`), payload);
  await pruneRawCaptureArchives();
}

function normalizedRecordKey(record = {}) {
  const base = [String(record.endpoint || ''), String(record.accountRef || '')];
  if (record.endpoint === 'get_money_history') {
    base.push(
      String(record.request?.startDate || ''),
      String(record.request?.endDate || ''),
      String(record.request?.page || record.payload?.page || 1)
    );
  }
  return base.join('\u001f');
}

function mergeNormalizedEvidence(...values) {
  let activeAccountRefs = [];
  const records = new Map();
  for (const value of values) {
    const incomingAccountRefs = (value?.activeAccountRefs || []).map(String);
    if (incomingAccountRefs.length) activeAccountRefs = incomingAccountRefs;
    for (const record of value?.records || []) {
      const key = normalizedRecordKey(record);
      const existing = records.get(key);
      if (!existing || String(record.capturedAt || '') >= String(existing.capturedAt || '')) {
        records.set(key, record);
      }
    }
  }
  return {
    activeAccountRefs: [...new Set(activeAccountRefs)].sort(),
    records: [...records.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, record]) => record)
  };
}

function routeIsFresh(route, capturedAt) {
  const routedAt = new Date(route?.resolvedAt || '').getTime();
  const current = new Date(capturedAt).getTime();
  return Number.isFinite(routedAt) && Number.isFinite(current) && Math.abs(current - routedAt) <= 2 * 60 * 60 * 1000;
}

function accumulateNormalizedEvidence({ captureDate, capturedAt, reviewDate, audit, evidence }) {
  const operation = evidenceAccumulatorTail.then(async () => {
    let state = { buckets: {}, routes: {} };
    try {
      const stored = JSON.parse(await fs.readFile(normalizedEvidencePath, 'utf8'));
      state = {
        buckets: stored?.buckets && typeof stored.buckets === 'object' ? stored.buckets : {},
        routes: stored?.routes && typeof stored.routes === 'object' ? stored.routes : {}
      };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }

    const hasCalendar = !Array.isArray(audit?.issueCodes)
      || !audit.issueCodes.includes('TRADING_CALENDAR_MISSING');
    const existingRoute = state.routes[captureDate];
    let targetReviewDate = reviewDate;
    if (hasCalendar) {
      state.routes[captureDate] = { reviewDate, resolvedAt: capturedAt };
      const provisional = state.buckets[captureDate];
      if (
        captureDate !== reviewDate
        && provisional?.provisional
        && routeIsFresh({ resolvedAt: provisional.lastCapturedAt }, capturedAt)
      ) {
        const target = state.buckets[reviewDate];
        state.buckets[reviewDate] = {
          reviewDate,
          captureDate,
          lastCapturedAt: capturedAt,
          provisional: false,
          evidence: mergeNormalizedEvidence(target?.evidence, provisional.evidence)
        };
        delete state.buckets[captureDate];
      }
    } else if (routeIsFresh(existingRoute, capturedAt)) {
      targetReviewDate = existingRoute.reviewDate;
    }

    const bucket = state.buckets[targetReviewDate];
    const accumulated = mergeNormalizedEvidence(bucket?.evidence, evidence);
    state.buckets[targetReviewDate] = {
      reviewDate: targetReviewDate,
      captureDate,
      lastCapturedAt: capturedAt,
      provisional: !hasCalendar && targetReviewDate === captureDate,
      evidence: accumulated
    };
    await atomicWriteJson(normalizedEvidencePath, state);
    return accumulated;
  });
  evidenceAccumulatorTail = operation.then(() => undefined, () => undefined);
  return operation;
}

function createLocalDailyReviewStore(filePath) {
  let mutationTail = Promise.resolve();

  async function readState() {
    try {
      const state = JSON.parse(await fs.readFile(filePath, 'utf8'));
      return {
        attempts: state?.attempts && typeof state.attempts === 'object' ? state.attempts : {},
        latestVerified: state?.latestVerified || null
      };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      return { attempts: {}, latestVerified: null };
    }
  }

  function mutate(update) {
    const operation = mutationTail.then(async () => {
      const state = await readState();
      const result = await update(state);
      await atomicWriteJson(filePath, state);
      return result;
    });
    mutationTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  return {
    async readAttempt(idempotencyKey) {
      await mutationTail;
      return (await readState()).attempts[idempotencyKey] || null;
    },
    async saveAttempt(attempt) {
      return mutate((state) => {
        state.attempts[attempt.idempotencyKey] = structuredClone(attempt);
      });
    },
    async readLatestVerified() {
      await mutationTail;
      const state = await readState();
      const pendingAttempt = Object.values(state.attempts)
        .filter((attempt) => attempt?.state !== 'verified')
        .sort((left, right) => (
          String(left.capturedAt).localeCompare(String(right.capturedAt))
          || String(left.idempotencyKey).localeCompare(String(right.idempotencyKey))
        ))
        .at(-1) || null;
      return {
        dailyReview: state.latestVerified?.dailyReview || null,
        audit: state.latestVerified?.audit || null,
        pendingAttempt
      };
    },
    async saveVerified(value) {
      return mutate((state) => {
        const incomingCapturedAt = Date.parse(value.attempt.capturedAt);
        for (const [key, attempt] of Object.entries(state.attempts)) {
          const attemptCapturedAt = Date.parse(attempt?.capturedAt);
          if (
            attempt?.state !== 'verified'
            && attempt?.captureDate === value.attempt.captureDate
            && Number.isFinite(attemptCapturedAt)
            && Number.isFinite(incomingCapturedAt)
            && attemptCapturedAt <= incomingCapturedAt
          ) {
            delete state.attempts[key];
          }
        }
        state.attempts[value.attempt.idempotencyKey] = structuredClone(value.attempt);
        const currentDate = String(state.latestVerified?.dailyReview?.reviewDate || '');
        const incomingDate = String(value.dailyReview?.reviewDate || '');
        const currentCapturedAt = Date.parse(
          state.latestVerified?.dailyReview?.capturedAt
          || state.latestVerified?.audit?.capturedAt
          || ''
        );
        const sameDayIsNotOlder = !Number.isFinite(currentCapturedAt)
          || (Number.isFinite(incomingCapturedAt) && incomingCapturedAt >= currentCapturedAt);
        if (
          !currentDate
          || incomingDate > currentDate
          || (incomingDate === currentDate && sameDayIsNotOlder)
        ) {
          state.latestVerified = structuredClone({ dailyReview: value.dailyReview, audit: value.audit });
        }
      });
    },
    async pruneCandidates(beforeDate) {
      return mutate((state) => {
        for (const [key, attempt] of Object.entries(state.attempts)) {
          if (String(attempt?.captureDate || '') < beforeDate) delete state.attempts[key];
        }
      });
    }
  };
}

const localDailyReviewStore = createLocalDailyReviewStore(dailyReviewStorePath);
const dailyReviewSync = createDailyReviewSync({ store: localDailyReviewStore });

async function pruneLocalRetention(now = Date.now()) {
  const beforeDate = dateBefore(shanghaiDate(new Date(now)), 30);
  const cleanups = [
    ['原始捕获归档', pruneRawCaptureArchives(now)],
    ['最近一次原始捕获', pruneStaleJsonFile(
      latestPath,
      now,
      ['capturedAt', 'receivedAt', 'pushedAt', 'captureDate']
    )],
    ['规范证据累积器', pruneNormalizedEvidenceAccumulator(now)],
    ['云端待上传队列', pruneStaleJsonDirectory(cloudOutboxDir, now)],
    ['本机按日原始状态', pruneStaleJsonDirectory(dailyStateDir, now, { preserveVerified: true })],
    ['本机复盘候选证据', beforeDate ? localDailyReviewStore.pruneCandidates(beforeDate) : Promise.resolve()]
  ];
  const results = await Promise.allSettled(cleanups.map(([, cleanup]) => cleanup));
  for (let index = 0; index < results.length; index += 1) {
    if (results[index].status === 'rejected') {
      console.error(`清理${cleanups[index][0]}失败：${results[index].reason?.message || results[index].reason}`);
    }
  }
}

function send(res, status, body, headers = {}) {
  const corsHeaders = res.tzzbAllowedOrigin ? {
    'Access-Control-Allow-Origin': res.tzzbAllowedOrigin,
    'Vary': 'Origin'
  } : {};
  res.writeHead(status, {
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-TZZB-Helper-Token',
    ...corsHeaders,
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
  return `javascript:${encodeURIComponent(source.replace('__TZZB_HELPER_TOKEN__', helperAuthToken))}`;
}

async function handleCapture(req, res) {
  const body = await readRequestBody(req);
  const payload = JSON.parse(body || '{}');
  const capturedAt = String(payload.capturedAt || payload.pushedAt || new Date().toISOString());
  const captureDate = shanghaiDate(capturedAt);
  if (!captureDate) throw new Error('捕获时间无效。');
  const records = Array.isArray(payload.records) ? payload.records : [];
  await archiveRawCapture(payload, capturedAt);
  const endpointCoverage = analyzeTzzbEndpointCoverage(records);
  const stored = {
    ...payload,
    capturedAt,
    captureDate,
    targetDate: captureDate,
    receivedAt: new Date().toISOString(),
    records,
    endpointCoverage
  };
  await atomicWriteJson(latestPath, stored);
  const batchEvidence = await normalizeCaptureEvidence(stored);
  const hasNormalizedEvidence = batchEvidence.activeAccountRefs.length > 0 || batchEvidence.records.length > 0;
  if (!hasNormalizedEvidence) {
    sendJson(res, 200, {
      ok: true,
      records: records.length,
      storedRecords: records.length,
      endpointCoverage,
      state: 'ignored',
      reviewDate: '',
      audit: {
        status: 'ignored',
        issueCodes: ['NO_REVIEW_EVIDENCE'],
        issues: [{ code: 'NO_REVIEW_EVIDENCE' }],
        warnings: []
      },
      cloudSync: { enabled: Boolean(cloudSyncUrl && cloudSyncKey), ok: true, status: 0, error: '' }
    });
    return;
  }
  const batchContentHash = await sha256({ capturedAt, captureDate, evidence: batchEvidence });
  const batchResult = await dailyReviewSync.submitCapture({
    idempotencyKey: `capture-${batchContentHash}`,
    capturedAt,
    captureDate,
    evidence: batchEvidence
  });
  const evidence = await accumulateNormalizedEvidence({
    captureDate,
    capturedAt,
    reviewDate: batchResult.reviewDate,
    audit: batchResult.audit,
    evidence: batchEvidence
  });
  const contentHash = await sha256({ capturedAt, captureDate, evidence });
  const attempt = {
    idempotencyKey: `capture-${contentHash}`,
    capturedAt,
    captureDate,
    evidence
  };
  if (cloudSyncUrl && cloudSyncKey) await writeCloudOutboxAttempt(attempt);
  const syncResult = await dailyReviewSync.submitCapture(attempt);
  const cloudSync = cloudSyncUrl && cloudSyncKey
    ? await queueCloudOutboxDrain()
    : { enabled: false, ok: false, status: 0, error: '' };
  sendJson(res, 200, {
    ok: true,
    records: records.length,
    storedRecords: records.length,
    endpointCoverage,
    state: syncResult.state,
    reviewDate: syncResult.reviewDate,
    audit: syncResult.audit,
    cloudSync
  });
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

function cloudUploadResult(status, data = {}, transportError = '') {
  const ok = status >= 200 && status < 300 && data.ok === true;
  return {
    enabled: true,
    ok,
    status,
    error: ok ? '' : (data.error || transportError || `HTTP ${status}`),
    data
  };
}

async function uploadCloudSyncAttempt(attempt) {
  try {
    const response = await fetch(`${cloudSyncUrl.replace(/\/$/, '')}/api/sync/tzzb`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-TZZB-Sync-Key': cloudSyncKey,
        'OAI-Sites-Authorization': `Bearer ${sitesBypassToken}`
      },
      body: JSON.stringify(attempt),
      signal: AbortSignal.timeout(20000)
    });
    let data = {};
    try {
      data = await response.json();
    } catch {
      data = {};
    }
    return cloudUploadResult(response.status, data);
  } catch (error) {
    return cloudUploadResult(0, {}, error.message);
  }
}

function cloudOutboxPath(idempotencyKey) {
  return path.join(cloudOutboxDir, `${idempotencyKey.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
}

async function writeCloudOutboxAttempt(attempt) {
  await atomicWriteJson(cloudOutboxPath(attempt.idempotencyKey), attempt);
}

async function readCloudOutboxAttempts() {
  let entries = [];
  try {
    entries = await fs.readdir(cloudOutboxDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const attempts = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const filePath = path.join(cloudOutboxDir, entry.name);
    try {
      attempts.push({ filePath, attempt: JSON.parse(await fs.readFile(filePath, 'utf8')) });
    } catch (error) {
      console.error(`云同步 outbox 文件无法读取，已保留待检查：${entry.name} (${error.message})`);
    }
  }
  return attempts.sort((left, right) => (
    String(left.attempt.capturedAt || '').localeCompare(String(right.attempt.capturedAt || ''))
    || String(left.attempt.idempotencyKey || '').localeCompare(String(right.attempt.idempotencyKey || ''))
  ));
}

async function writeCloudSyncStatus(attempt, result) {
  const contentHash = await sha256({
    capturedAt: attempt.capturedAt,
    captureDate: attempt.captureDate,
    evidence: attempt.evidence
  });
  const status = {
    state: result.ok ? String(result.data?.state || 'accepted') : 'upload-failed',
    reviewDate: result.ok ? String(result.data?.reviewDate || '') : '',
    captureDate: String(attempt.captureDate || ''),
    uploadedAt: new Date().toISOString(),
    contentHash,
    evidenceRecordCount: Array.isArray(attempt.evidence?.records) ? attempt.evidence.records.length : 0,
    idempotencyKey: String(attempt.idempotencyKey || ''),
    httpStatus: result.status,
    error: result.error || ''
  };
  await atomicWriteJson(cloudSyncStatusPath, status);
  return status;
}

async function readCloudSyncStatus() {
  try {
    return JSON.parse(await fs.readFile(cloudSyncStatusPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function drainCloudOutbox() {
  if (!cloudSyncUrl || !cloudSyncKey) return { enabled: false, ok: false, status: 0, error: '' };
  const pending = await readCloudOutboxAttempts();
  if (!pending.length) return { enabled: true, ok: true, status: 204, error: '' };

  let latestResult = { enabled: true, ok: true, status: 204, error: '' };
  for (const item of pending) {
    latestResult = await uploadCloudSyncAttempt(item.attempt);
    await writeCloudSyncStatus(item.attempt, latestResult);
    if (!latestResult.ok) return latestResult;
    await fs.rm(item.filePath, { force: true });
  }
  return latestResult;
}

function queueCloudOutboxDrain() {
  const upload = cloudUploadTail.then(() => drainCloudOutbox());
  cloudUploadTail = upload.then(() => undefined, () => undefined);
  return upload;
}

async function replayCloudOutboxOnStartup() {
  if (!cloudSyncUrl || !cloudSyncKey) return;
  const result = await queueCloudOutboxDrain();
  if (result.ok && result.status !== 204) {
    console.log('已把本机待传复盘证据补传到云端。');
  } else if (!result.ok) {
    console.error(`启动补传云端失败，outbox 已保留：${result.error || `HTTP ${result.status}`}`);
  }
}

async function handleCloudSyncUpload(req, res) {
  const body = await readRequestBody(req);
  const payload = JSON.parse(body || '{}');
  const result = await dailyReviewSync.submitCapture(payload);
  sendJson(res, 200, { ok: true, ...result });
}

async function handleCloudSyncLatest(res) {
  const latest = await dailyReviewSync.readLatestVerified();
  sendJson(res, 200, { ok: true, ...latest });
}

async function handleCloudSyncHealth(res) {
  const latest = await dailyReviewSync.readLatestVerified();
  sendJson(res, 200, {
    ok: true,
    readyForReview: Boolean(latest.dailyReview),
    reviewDate: latest.dailyReview?.reviewDate || '',
    latestReceivedAt: latest.dailyReview?.capturedAt || latest.pendingAttempt?.capturedAt || '',
    pending: Boolean(latest.pendingAttempt),
    audit: latest.audit
  });
}

async function handleLatest(res) {
  const latest = await dailyReviewSync.readLatestVerified();
  sendJson(res, 200, {
    ok: true,
    dailyReview: latest.dailyReview,
    audit: latest.audit,
    pendingAttempt: latest.pendingAttempt
  });
}

async function handleHealth(res) {
  let cloudSyncStatus = null;
  try {
    cloudSyncStatus = await readCloudSyncStatus();
  } catch {
    cloudSyncStatus = null;
  }
  try {
    const payload = await readLatestCapture();
    const records = Array.isArray(payload.records) ? payload.records : [];
    const endpointCoverage = analyzeTzzbEndpointCoverage(records);
    const review = mapTzzbCaptureToReview(records, {
      targetDate: payload.targetDate || shanghaiDate(payload.receivedAt || new Date())
    });
    sendJson(res, 200, {
      ok: true,
      version: helperVersion,
      targetDate: payload.targetDate || shanghaiDate(payload.receivedAt || new Date()),
      latestReceivedAt: payload.receivedAt || '',
      latestRecordCount: records.length,
      readyForReview: endpointCoverage.readyForReview,
      endpointCoverage,
      importAudit: review.tzzb.importAudit,
      cloudSyncStatus
    });
  } catch {
    sendJson(res, 200, {
      ok: true,
      version: helperVersion,
      targetDate: shanghaiDate(new Date()),
      latestReceivedAt: '',
      latestRecordCount: 0,
      readyForReview: false,
      endpointCoverage: analyzeTzzbEndpointCoverage([]),
      cloudSyncStatus
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
      market: await marketSnapshots.get()
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
    helperToken: helperAuthToken,
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
  if (url.pathname !== '/' && url.pathname !== '/index.html') {
    send(res, 404, 'Not Found');
    return;
  }
  const absolute = path.join(rootDir, 'index.html');
  const body = await fs.readFile(absolute);
  send(res, 200, body, { 'Content-Type': contentType(absolute) });
}

function allowedRequestOrigin(req) {
  const origin = String(req.headers.origin || '').trim();
  if (!origin) return { allowed: true, origin: '' };
  const localOrigins = new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    'https://tzzb.10jqka.com.cn'
  ]);
  if (localOrigins.has(origin) || /^chrome-extension:\/\/[a-p]{32}$/.test(origin)) {
    return { allowed: true, origin };
  }
  return { allowed: false, origin: '' };
}

function secretsEqual(actual, expected) {
  if (!actual || !expected || actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) {
    difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

function localMutationAuthorized(req) {
  const origin = String(req.headers.origin || '').trim();
  if (!origin || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`) return true;
  return secretsEqual(String(req.headers['x-tzzb-helper-token'] || ''), helperAuthToken);
}

function assertLocalMutationAuthorized(req, res) {
  if (localMutationAuthorized(req)) return true;
  sendJson(res, 401, { ok: false, error: '本机助手写入令牌无效。' });
  return false;
}

function remoteLedgerOrigin(req) {
  return String(req.headers.origin || '') === 'https://tzzb.10jqka.com.cn';
}

const server = http.createServer(async (req, res) => {
  try {
    const origin = allowedRequestOrigin(req);
    if (!origin.allowed) {
      sendJson(res, 403, { ok: false, error: '请求来源不受信任。' });
      return;
    }
    res.tzzbAllowedOrigin = origin.origin;

    if (req.method === 'OPTIONS') {
      send(res, 204, '');
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);

    if (remoteLedgerOrigin(req) && req.method === 'GET') {
      res.tzzbAllowedOrigin = '';
      sendJson(res, 403, { ok: false, error: '同花顺页面无权读取本机复盘数据。' });
      return;
    }

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
      if (remoteLedgerOrigin(req)) {
        sendJson(res, 403, { ok: false, error: '该入口仅供本机页面和捕获扩展读取。' });
        return;
      }
      sendJson(res, 200, extensionInfo());
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/market-snapshot') {
      await handleMarketSnapshot(res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/tzzb-bookmarklet') {
      if (remoteLedgerOrigin(req)) {
        sendJson(res, 403, { ok: false, error: '请从本机复盘助手页面安装书签脚本。' });
        return;
      }
      sendJson(res, 200, { bookmarklet: await buildBookmarklet() });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/tzzb/bookmarklet.js') {
      if (remoteLedgerOrigin(req)) {
        sendJson(res, 403, { ok: false, error: '请从本机复盘助手页面安装书签脚本。' });
        return;
      }
      const source = await fs.readFile(path.join(rootDir, 'tools', 'tzzb-bookmarklet-source.js'), 'utf8');
      const body = source.replace('__TZZB_HELPER_TOKEN__', helperAuthToken);
      send(res, 200, body, { 'Content-Type': 'text/javascript; charset=utf-8' });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/tzzb-capture') {
      if (!assertLocalMutationAuthorized(req, res)) return;
      await handleCapture(req, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/tzzb-clear') {
      if (!assertLocalMutationAuthorized(req, res)) return;
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

await pruneLocalRetention();

server.listen(port, '127.0.0.1', () => {
  console.log(`复盘助手已启动: http://127.0.0.1:${port}/`);
  console.log(`书签脚本地址: http://127.0.0.1:${port}/api/tzzb-bookmarklet`);
  void replayCloudOutboxOnStartup().catch((error) => {
    console.error(`启动补传云端失败，outbox 已保留：${error.message}`);
  });
});
