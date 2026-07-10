import { fetchMarketSnapshot } from '../tools/market-public-data.mjs';
import { analyzeTzzbEndpointCoverage, mergeCaptureRecords } from '../tools/tzzb-endpoint-coverage.mjs';
import { mapTzzbCaptureToReview } from '../tools/tzzb-review-mapper.mjs';
import { createTzzbSyncStore } from './tzzb-sync-store.mjs';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-TZZB-Sync-Key, Authorization'
};

function json(status, value, headers = {}) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: {
      ...CORS_HEADERS,
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

function localDate(value = new Date()) {
  if (typeof value === 'string') {
    const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
    if (match) return match[1];
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0')
  ].join('-');
}

function requestKey(request, url) {
  const headerKey = request.headers.get('X-TZZB-Sync-Key') || '';
  const authorization = request.headers.get('Authorization') || '';
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  return String(headerKey || bearer || url.searchParams.get('key') || '');
}

function keysEqual(actual, expected) {
  if (!actual || !expected || actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) {
    difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

function authorize(request, env, url) {
  const expected = String(env.TZZB_SYNC_ACCESS_KEY || '');
  if (!expected) return json(503, { ok: false, error: '云同步访问码未配置。' });
  if (!keysEqual(requestKey(request, url), expected)) {
    return json(401, { ok: false, error: '云同步访问码无效。' });
  }
  return null;
}

function captureResponse(payload, fallbackSource = 'cloud-sync') {
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

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function uploadSync(request, env) {
  const payload = await readJson(request);
  if (!payload || typeof payload !== 'object') {
    return json(400, { ok: false, error: '同步数据格式无效。' });
  }

  const targetDate = payload.targetDate || localDate(payload.pushedAt || new Date());
  if (!targetDate) return json(400, { ok: false, error: '同步日期无效。' });

  const store = createTzzbSyncStore(env.DB);
  const existing = await store.readLatest();
  const existingRecords = existing?.targetDate === targetDate && Array.isArray(existing.records)
    ? existing.records
    : [];
  const records = mergeCaptureRecords(existingRecords, Array.isArray(payload.records) ? payload.records : [], {
    targetDate
  });
  const stored = {
    ...(existing?.targetDate === targetDate ? existing : {}),
    ...payload,
    source: payload.source || 'cloud-sync',
    targetDate,
    receivedAt: new Date().toISOString(),
    records,
    endpointCoverage: analyzeTzzbEndpointCoverage(records)
  };
  await store.writeLatest(stored);
  return json(200, captureResponse(stored));
}

async function latestSync(env) {
  const payload = await createTzzbSyncStore(env.DB).readLatest();
  if (!payload) return json(404, { ok: false, error: '云端还没有收到同花顺同步数据。' });
  return json(200, captureResponse(payload));
}

async function syncHealth(env) {
  const payload = await createTzzbSyncStore(env.DB).readLatest();
  if (!payload) return json(404, { ok: false, error: '云端还没有收到同花顺同步数据。' });

  const records = Array.isArray(payload.records) ? payload.records : [];
  const endpointCoverage = analyzeTzzbEndpointCoverage(records);
  const targetDate = payload.targetDate || localDate(payload.receivedAt || new Date());
  const review = mapTzzbCaptureToReview(records, { targetDate });
  return json(200, {
    ok: true,
    targetDate,
    latestReceivedAt: payload.receivedAt || '',
    latestRecordCount: records.length,
    readyForReview: endpointCoverage.readyForReview,
    endpointCoverage,
    importAudit: review.tzzb.importAudit
  });
}

async function marketSnapshot(fetchImpl) {
  try {
    return json(200, { ok: true, market: await fetchMarketSnapshot({ fetchImpl }) });
  } catch (error) {
    return json(502, { ok: false, error: error.message || '公开市场数据暂不可用。' });
  }
}

export function createCloudWorker({ indexHtml = '', fetchImpl = globalThis.fetch } = {}) {
  return {
    async fetch(request, env = {}) {
      const url = new URL(request.url);

      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      if (url.pathname === '/api/market-snapshot' && request.method === 'GET') {
        return marketSnapshot(fetchImpl);
      }

      const syncRoute = url.pathname === '/api/sync/tzzb'
        || url.pathname === '/api/sync/latest'
        || url.pathname === '/api/sync/health';
      if (syncRoute) {
        const denied = authorize(request, env, url);
        if (denied) return denied;
        try {
          if (url.pathname === '/api/sync/tzzb' && request.method === 'POST') {
            return await uploadSync(request, env);
          }
          if (url.pathname === '/api/sync/latest' && request.method === 'GET') {
            return await latestSync(env);
          }
          if (url.pathname === '/api/sync/health' && request.method === 'GET') {
            return await syncHealth(env);
          }
          return json(405, { ok: false, error: 'Method Not Allowed' });
        } catch {
          return json(503, { ok: false, error: '云端同步存储暂不可用。' });
        }
      }

      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return html(indexHtml);
      }

      return json(404, { ok: false, error: 'Not Found' });
    }
  };
}
