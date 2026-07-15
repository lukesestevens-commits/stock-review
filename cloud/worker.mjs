import {
  fetchMarketSnapshot,
  MARKET_ALGORITHM_VERSION
} from '../tools/market-public-data.mjs';
import { createMarketSnapshotStore } from './market-snapshot-store.mjs';
import {
  isFinalMarketSnapshot,
  isValidMarketSnapshot,
  marketSnapshotTradeDate
} from './market-snapshot-policy.mjs';
import { createDailyReviewSync } from '../tools/daily-review-sync.mjs';
import { normalizeCaptureEvidence } from '../tools/tzzb-evidence-adapter.mjs';
import { createDailyReviewStore } from './daily-review-store.mjs';
import { createReviewDraftStore } from './review-draft-store.mjs';

const CORS_HEADERS = {
  'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-TZZB-Sync-Key, OAI-Sites-Authorization'
};

function requestCorsHeaders(request) {
  if (!request) return CORS_HEADERS;
  const origin = request.headers.get('Origin') || '';
  const requestOrigin = new URL(request.url).origin;
  return {
    ...CORS_HEADERS,
    ...(origin === requestOrigin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {})
  };
}

function json(status, value, headers = {}, request = null) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: {
      ...requestCorsHeaders(request),
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers
    }
  });
}

function html(value) {
  return new Response(value, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache'
    }
  });
}

function keysEqual(actual, expected) {
  if (!actual || !expected || actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) {
    difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

function authorizeWrite(request, env) {
  const expected = String(env.TZZB_SYNC_WRITE_KEY || env.TZZB_SYNC_ACCESS_KEY || '');
  const actual = String(request.headers.get('X-TZZB-Sync-Key') || '');
  if (!expected) return json(503, { ok: false, error: '云同步写入密钥未配置。' }, {}, request);
  if (!keysEqual(actual, expected)) {
    return json(401, { ok: false, error: '云同步写入密钥无效。' }, {}, request);
  }
  return null;
}

function authorizeRead(request, env) {
  const expected = String(env.TZZB_OWNER_EMAIL || '').trim().toLowerCase();
  const actual = String(request.headers.get('oai-authenticated-user-email') || '').trim().toLowerCase();
  if (!expected) {
    return json(503, { ok: false, error: '站点所有者账号未配置。' }, {}, request);
  }
  if (!actual) return json(401, { ok: false, error: '请先使用本人账号登录。' }, {}, request);
  if (!keysEqual(actual, expected)) {
    return json(403, { ok: false, error: '当前账号无权读取此复盘数据。' }, {}, request);
  }
  return null;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

async function stableDigest(value) {
  const encoded = new TextEncoder().encode(JSON.stringify(stableValue(value)));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', encoded);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function pendingSummary(attempt) {
  if (!attempt) return null;
  return {
    state: attempt.state || 'stored-unverified',
    capturedAt: attempt.capturedAt || '',
    captureDate: attempt.captureDate || '',
    reviewDate: attempt.reviewDate || '',
    audit: attempt.audit || null
  };
}

async function uploadSync(request, sync, now) {
  const payload = await readJson(request);
  if (!payload || typeof payload !== 'object') {
    return json(400, { ok: false, error: '同步数据格式无效。' }, {}, request);
  }

  const capturedAt = String(payload.capturedAt || payload.pushedAt || now().toISOString());
  const capturedDate = new Date(capturedAt);
  if (Number.isNaN(capturedDate.getTime())) {
    return json(400, { ok: false, error: '捕获时间无效。' }, {}, request);
  }
  const captureDate = String(payload.captureDate || shanghaiDate(capturedDate));
  const evidence = payload.evidence && typeof payload.evidence === 'object'
    ? payload.evidence
    : await normalizeCaptureEvidence({ ...payload, capturedAt });
  const idempotencyKey = String(
    payload.idempotencyKey
    || `legacy-${await stableDigest({ capturedAt, captureDate, evidence })}`
  );
  const result = await sync.submitCapture({ idempotencyKey, capturedAt, captureDate, evidence });
  return json(200, { ok: true, ...result }, {}, request);
}

async function latestSync(request, sync) {
  const latest = await sync.readLatestVerified();
  if (!latest?.dailyReview && !latest?.pendingAttempt) {
    return json(404, { ok: false, error: '云端还没有收到可用的复盘数据。' }, {}, request);
  }
  return json(200, {
    ok: true,
    dailyReview: latest.dailyReview || null,
    audit: latest.audit || null,
    pendingAttempt: pendingSummary(latest.pendingAttempt)
  }, {}, request);
}

async function syncHealth(request, sync) {
  const latest = await sync.readLatestVerified();
  if (!latest?.dailyReview && !latest?.pendingAttempt) {
    return json(404, { ok: false, error: '云端还没有收到可用的复盘数据。' }, {}, request);
  }
  const pending = pendingSummary(latest.pendingAttempt);
  const audit = latest.audit || pending?.audit || null;
  return json(200, {
    ok: true,
    reviewDate: latest.dailyReview?.reviewDate || audit?.reviewDate || pending?.reviewDate || '',
    latestReceivedAt: latest.dailyReview?.capturedAt || audit?.capturedAt || pending?.capturedAt || '',
    readyForReview: Boolean(latest.dailyReview && latest.audit?.status === 'verified'),
    pending: Boolean(pending),
    issueCodes: pending?.audit?.issueCodes || audit?.issueCodes || []
  }, {}, request);
}

function requestedReviewDate(url) {
  const value = String(url.searchParams.get('date') || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '';
}

async function readReviewDraft(request, url, store) {
  const reviewDate = requestedReviewDate(url);
  if (!reviewDate) return json(400, { ok: false, error: '请提供有效的复盘日期。' }, {}, request);
  const draft = await store.read(reviewDate);
  if (!draft) return json(404, { ok: false, error: '云端还没有这一天的草稿。' }, {}, request);
  return json(200, { ok: true, draft }, {}, request);
}

async function saveReviewDraft(request, store, now) {
  const payload = await readJson(request);
  const reviewDate = String(payload?.reviewDate || '');
  const expectedVersion = Number(payload?.expectedVersion);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(reviewDate)
    || !payload?.record
    || typeof payload.record !== 'object'
    || Array.isArray(payload.record)
    || String(payload.record.date || '') !== reviewDate
    || !Number.isSafeInteger(expectedVersion)
    || expectedVersion < 0
  ) {
    return json(400, { ok: false, error: '云端草稿格式无效。' }, {}, request);
  }
  try {
    const draft = await store.save({
      reviewDate,
      record: payload.record,
      expectedVersion,
      updatedAt: now().toISOString()
    });
    return json(200, { ok: true, draft }, {}, request);
  } catch (error) {
    if (error?.code === 'DRAFT_VERSION_CONFLICT') {
      return json(409, {
        ok: false,
        error: '云端已有更新的草稿。',
        current: error.current || null
      }, {}, request);
    }
    if (error instanceof TypeError) return json(400, { ok: false, error: error.message }, {}, request);
    throw error;
  }
}

function shanghaiDate(value) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(value);
  const read = (type) => parts.find((part) => part.type === type)?.value || '';
  return `${read('year')}-${read('month')}-${read('day')}`;
}

function dateBefore(date, days) {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) throw new TypeError('scheduled retention date is invalid');
  parsed.setUTCDate(parsed.getUTCDate() - days);
  return parsed.toISOString().slice(0, 10);
}

function isFreshMarketRecord(record, nowDate, ttlMs = 60_000) {
  const updatedAt = Date.parse(record?.updatedAt || '');
  if (!Number.isFinite(updatedAt)) return false;
  const age = nowDate.getTime() - updatedAt;
  return age >= 0 && age < ttlMs;
}

function marketRecordResponse(record, options = {}) {
  const finalized = Boolean(record.finalizedAt);
  return json(200, {
    ok: true,
    market: {
      ...record.market,
      tradeDate: record.tradeDate,
      finalized,
      finalizedAt: record.finalizedAt || ''
    },
    cache: {
      tradeDate: record.tradeDate,
      updatedAt: record.updatedAt,
      finalized,
      finalizedAt: record.finalizedAt || '',
      stale: Boolean(options.stale),
      versionExpired: Boolean(options.versionExpired),
      algorithmVersion: record.market?.algorithmVersion || '',
      source: options.source || 'cloud-cache'
    }
  });
}

async function marketSnapshot(fetchImpl, env, url, now) {
  const nowDate = now();
  const requestedDate = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('date') || '')
    ? url.searchParams.get('date')
    : shanghaiDate(nowDate);
  let store;
  let cached;
  try {
    store = createMarketSnapshotStore(env.DB);
    cached = await store.read(requestedDate);
  } catch {
    return json(503, { ok: false, error: '云端市场快照存储暂不可用。' });
  }

  const cachedIsCurrent = cached?.market?.algorithmVersion === MARKET_ALGORITHM_VERSION;
  if (cachedIsCurrent && cached?.finalizedAt) return marketRecordResponse(cached);
  if (cachedIsCurrent && isFreshMarketRecord(cached, nowDate)) return marketRecordResponse(cached);

  try {
    const fetched = await fetchMarketSnapshot({ fetchImpl });
    if (!isValidMarketSnapshot(fetched)) throw new Error('公开市场快照字段不完整。');
    const updatedAt = nowDate.toISOString();
    const market = { ...fetched, updatedAt };
    const tradeDate = marketSnapshotTradeDate(market) || requestedDate;
    const finalizedAt = isFinalMarketSnapshot(market) ? updatedAt : '';
    const forceVersionUpgrade = Boolean(
      cached
      && cached.tradeDate === tradeDate
      && !cachedIsCurrent
      && market.algorithmVersion === MARKET_ALGORITHM_VERSION
    );
    const stored = await store.write(
      { tradeDate, updatedAt, finalizedAt, market },
      { force: forceVersionUpgrade }
    );
    return marketRecordResponse(stored, { source: 'upstream' });
  } catch (error) {
    if (cached) return marketRecordResponse(cached, {
      stale: true,
      versionExpired: !cachedIsCurrent
    });
    return json(502, { ok: false, error: error.message || '公开市场数据暂不可用。' });
  }
}

export function createCloudWorker({
  indexHtml = '',
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  dailyReviewStoreFactory = ({ db }) => createDailyReviewStore(db),
  dailyReviewSyncFactory = ({ db }) => createDailyReviewSync({ store: dailyReviewStoreFactory({ db }), now }),
  reviewDraftStoreFactory = ({ db }) => createReviewDraftStore(db)
} = {}) {
  return {
    async fetch(request, env = {}) {
      const url = new URL(request.url);

      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: requestCorsHeaders(request) });
      }

      if (url.pathname === '/api/market-snapshot' && request.method === 'GET') {
        return marketSnapshot(fetchImpl, env, url, now);
      }

      if (url.pathname === '/api/review-draft') {
        const denied = authorizeRead(request, env);
        if (denied) return denied;
        try {
          const store = reviewDraftStoreFactory({ db: env.DB, env });
          if (request.method === 'GET') return await readReviewDraft(request, url, store);
          if (request.method === 'PUT') return await saveReviewDraft(request, store, now);
          return json(405, { ok: false, error: 'Method Not Allowed' }, {}, request);
        } catch {
          return json(503, { ok: false, error: '云端草稿存储暂不可用。' }, {}, request);
        }
      }

      const syncRoute = url.pathname === '/api/sync/tzzb'
        || url.pathname === '/api/sync/latest'
        || url.pathname === '/api/sync/health';
      if (syncRoute) {
        try {
          if (url.pathname === '/api/sync/tzzb' && request.method === 'POST') {
            const denied = authorizeWrite(request, env);
            if (denied) return denied;
            const sync = dailyReviewSyncFactory({ db: env.DB, env });
            return await uploadSync(request, sync, now);
          }
          if (url.pathname === '/api/sync/latest' && request.method === 'GET') {
            const denied = authorizeRead(request, env);
            if (denied) return denied;
            const sync = dailyReviewSyncFactory({ db: env.DB, env });
            return await latestSync(request, sync);
          }
          if (url.pathname === '/api/sync/health' && request.method === 'GET') {
            const denied = authorizeRead(request, env);
            if (denied) return denied;
            const sync = dailyReviewSyncFactory({ db: env.DB, env });
            return await syncHealth(request, sync);
          }
          return json(405, { ok: false, error: 'Method Not Allowed' }, {}, request);
        } catch (error) {
          if (error?.code === 'IDEMPOTENCY_CONFLICT') {
            return json(409, { ok: false, error: '同一批次的数据内容不一致。' }, {}, request);
          }
          if (['IDEMPOTENCY_KEY_REQUIRED', 'INVALID_CAPTURED_AT', 'CAPTURE_DATE_MISMATCH'].includes(error?.code)) {
            return json(400, { ok: false, error: error.message }, {}, request);
          }
          return json(503, { ok: false, error: '云端同步存储暂不可用。' }, {}, request);
        }
      }

      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return html(indexHtml);
      }

      return json(404, { ok: false, error: 'Not Found' });
    },

    async scheduled(controller = {}, env = {}, ctx = {}) {
      const scheduledTime = Number(controller.scheduledTime);
      let current = new Date(scheduledTime);
      if (!Number.isFinite(scheduledTime) || scheduledTime <= 0) {
        const fallbackNow = now();
        current = fallbackNow instanceof Date ? fallbackNow : new Date(fallbackNow);
      }
      const beforeDate = dateBefore(shanghaiDate(current), 90);
      const cleanup = Promise.resolve().then(() => {
        const store = dailyReviewStoreFactory({ db: env.DB, env });
        return store.pruneCandidates(beforeDate);
      });
      if (typeof ctx.waitUntil === 'function') ctx.waitUntil(cleanup);
      return cleanup;
    }
  };
}
