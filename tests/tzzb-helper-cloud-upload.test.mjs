import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const helperPort = 8802;
const cloudPort = 8803;
const helperUrl = `http://127.0.0.1:${helperPort}`;
const cloudUrl = `http://127.0.0.1:${cloudPort}`;
const nodePath = process.execPath;
const tempDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tzzb-helper-cloud-upload-test-'));
const outboxDir = path.join(tempDataDir, 'cloud-outbox');
const statusPath = path.join(tempDataDir, 'cloud-sync-status.json');
const writeKey = 'write-only-secret';
const sitesBypassToken = 'sites-bypass-secret';
const receivedUploads = [];
let activeUploads = 0;
let maxConcurrentUploads = 0;
let rejectNextUpload = true;
let invalidateNextUpload = false;

const rawPayload = {
  source: 'edge-extension',
  pageUrl: 'https://tzzb.10jqka.com.cn/private-account?user=user-secret&cookie=cookie-secret',
  pushedAt: '2026-07-14T16:09:01.000Z',
  capturedAt: '2026-07-14T16:09:00.000Z',
  captureDate: '2000-01-01',
  records: [
    {
      capturedAt: '2026-07-14T15:59:59.000Z',
      method: 'POST',
      status: 200,
      url: 'https://tzzb.10jqka.com.cn/caishen_fund/pc/account/v1/account_list',
      requestPostData: 'userid=user-secret&manual_id=manual-A&fund_key=fund-A&cookie=cookie-secret',
      responseText: JSON.stringify({
        ex_data: { common: [{ manual_id: 'manual-A', fund_key: 'fund-A', user: 'user-secret' }] },
        cookie: 'cookie-secret'
      })
    },
    {
      capturedAt: '2026-07-14T15:59:59.500Z',
      method: 'POST',
      status: 200,
      url: 'https://tzzb.10jqka.com.cn/caishen_fund/pc/asset/v1/stock_position',
      requestPostData: 'userid=user-secret&manual_id=manual-A&fund_key=fund-A&cookie=cookie-secret',
      responseText: JSON.stringify({
        ex_data: {
          total_asset: '10000',
          total_liability: '0',
          total_value: '9000',
          position_rate: '0.9',
          money_remain: '1000',
          position: [{ code: '000001', name: '脱敏持仓', count: '100', price: '90', value: '9000' }],
          user: 'user-secret',
          manual: 'manual-A',
          fund: 'fund-A',
          cookie: 'cookie-secret'
        }
      })
    }
  ]
};

function helperProcess() {
  const child = spawn(nodePath, ['tools/tzzb-local-helper.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      TZZB_HELPER_PORT: String(helperPort),
      TZZB_DATA_DIR: tempDataDir,
      TZZB_CLOUD_SYNC_URL: cloudUrl,
      TZZB_CLOUD_SYNC_KEY: writeKey,
      TZZB_SITES_BYPASS_TOKEN: sitesBypassToken
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  return { child, output: () => output };
}

async function stopHelper(helper) {
  if (!helper || helper.child.exitCode !== null) return;
  helper.child.kill();
  await new Promise((resolve) => helper.child.once('exit', resolve));
}

async function waitForHealth(helper) {
  const deadline = Date.now() + 5000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${helperUrl}/api/tzzb-health`);
      if (res.ok) return res.json();
      lastError = new Error(`HTTP ${res.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`helper did not become healthy: ${lastError?.message || helper.output()}`);
}

async function outboxFiles() {
  try {
    return (await fs.readdir(outboxDir)).filter((name) => name.endsWith('.json'));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function waitForUploads(count) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (receivedUploads.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`expected ${count} cloud uploads, received ${receivedUploads.length}`);
}

function allKeys(value, keys = []) {
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, keys);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      keys.push(key);
      allKeys(item, keys);
    }
  }
  return keys;
}

let helper = helperProcess();
let cloudServer;

try {
  await waitForHealth(helper);
  const offlineResponse = await fetch(`${helperUrl}/api/tzzb-capture`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(rawPayload)
  });
  const offlineResult = await offlineResponse.json();
  assert.equal(offlineResponse.status, 200, 'cloud outages must not reject the local capture');
  assert.equal(offlineResult.cloudSync.ok, false);
  assert.equal(offlineResult.cloudSync.status, 0);
  assert.equal((await outboxFiles()).length, 1, 'a network failure must retain the atomic outbox attempt');
  const failedStatus = JSON.parse(await fs.readFile(statusPath, 'utf8'));
  assert.equal(failedStatus.state, 'upload-failed', 'failed uploads must not claim a verified cloud status');
  assert.equal(failedStatus.captureDate, '2026-07-15');
  await stopHelper(helper);

  cloudServer = http.createServer(async (req, res) => {
    activeUploads += 1;
    maxConcurrentUploads = Math.max(maxConcurrentUploads, activeUploads);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    receivedUploads.push({
      method: req.method,
      url: req.url,
      writeKey: req.headers['x-tzzb-sync-key'] || '',
      sitesAuthorization: req.headers['oai-sites-authorization'] || '',
      outboxCount: (await outboxFiles()).length,
      body
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    activeUploads -= 1;
    if (rejectNextUpload) {
      rejectNextUpload = false;
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'temporary edge rejection' }));
      return;
    }
    if (invalidateNextUpload) {
      invalidateNextUpload = false;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'invalid acceptance body' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, state: 'verified', reviewDate: '2026-07-14' }));
  });
  await new Promise((resolve) => cloudServer.listen(cloudPort, '127.0.0.1', resolve));

  helper = helperProcess();
  await waitForHealth(helper);
  await waitForUploads(1);
  assert.equal(receivedUploads[0].outboxCount, 1, 'startup replay must read an already durable attempt');
  assert.equal((await outboxFiles()).length, 1, 'HTTP 403 must retain the outbox attempt');

  const retryResponse = await fetch(`${helperUrl}/api/tzzb-capture`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(rawPayload)
  });
  const retryResult = await retryResponse.json();
  assert.equal(retryResponse.status, 200);
  assert.equal(retryResult.cloudSync.ok, true);
  await waitForUploads(2);

  const [startupUpload, acceptedUpload] = receivedUploads;
  assert.equal(startupUpload.method, 'POST');
  assert.equal(startupUpload.url, '/api/sync/tzzb');
  assert.equal(startupUpload.writeKey, writeKey);
  assert.equal(startupUpload.sitesAuthorization, `Bearer ${sitesBypassToken}`);
  assert.deepEqual(Object.keys(startupUpload.body), ['idempotencyKey', 'capturedAt', 'captureDate', 'evidence']);
  assert.equal(startupUpload.body.captureDate, '2026-07-15', 'captureDate must be derived in Asia/Shanghai');
  assert.equal(startupUpload.body.idempotencyKey, acceptedUpload.body.idempotencyKey, 'the same content must retain one stable idempotency key');
  assert.deepEqual(startupUpload.body, acceptedUpload.body);
  assert.equal((await outboxFiles()).length, 0, 'a 2xx acceptance must delete the durable attempt');

  const forbiddenKeys = new Set(['url', 'responseText', 'pageUrl', 'user', 'manual', 'fund', 'cookie']);
  for (const key of allKeys(startupUpload.body)) {
    assert.equal(forbiddenKeys.has(key), false, `cloud payload must not contain raw key ${key}`);
  }
  const serializedCloudBody = JSON.stringify(startupUpload.body);
  for (const secret of ['user-secret', 'manual-A', 'fund-A', 'cookie-secret', 'private-account']) {
    assert.doesNotMatch(serializedCloudBody, new RegExp(secret), `cloud payload must not contain ${secret}`);
  }

  const status = JSON.parse(await fs.readFile(statusPath, 'utf8'));
  assert.equal(status.state, 'verified');
  assert.equal(status.reviewDate, '2026-07-14');
  assert.equal(status.captureDate, '2026-07-15');
  assert.match(status.uploadedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(status.contentHash, /^[a-f0-9]{64}$/);
  assert.equal(status.evidenceRecordCount, 1);

  const health = await (await fetch(`${helperUrl}/api/tzzb-health`)).json();
  assert.deepEqual(health.cloudSyncStatus, status, 'health must expose the persisted cloud receipt for the scheduler');

  const incrementalPayload = {
    source: 'edge-extension',
    pushedAt: '2026-07-14T16:10:01.000Z',
    capturedAt: '2026-07-14T16:10:00.000Z',
    records: [{
      capturedAt: '2026-07-14T16:10:00.000Z',
      method: 'POST',
      status: 200,
      url: 'https://tzzb.10jqka.com.cn/caishen_fund/pc/asset/v1/asset_trend',
      requestPostData: 'userid=user-secret&manual_id=manual-A&fund_key=fund-A&cookie=cookie-secret',
      responseText: JSON.stringify({ ex_data: { month_profit: [], year_profit: [], total_asset: [] } })
    }]
  };
  invalidateNextUpload = true;
  const invalidAcceptanceResponse = await fetch(`${helperUrl}/api/tzzb-capture`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(incrementalPayload)
  });
  const invalidAcceptance = await invalidAcceptanceResponse.json();
  assert.equal(invalidAcceptanceResponse.status, 200);
  assert.equal(invalidAcceptance.cloudSync.ok, false, 'HTTP 200 without data.ok=true must not acknowledge the outbox');
  await waitForUploads(3);
  assert.equal((await outboxFiles()).length, 1);
  assert.equal((JSON.parse(await fs.readFile(statusPath, 'utf8'))).state, 'upload-failed');

  const validRetry = await fetch(`${helperUrl}/api/tzzb-capture`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(incrementalPayload)
  });
  assert.equal(validRetry.status, 200);
  assert.equal((await validRetry.json()).cloudSync.ok, true);
  await waitForUploads(4);
  assert.equal((await outboxFiles()).length, 0);
  assert.deepEqual(
    receivedUploads[2].body.evidence.records.map((record) => record.endpoint),
    ['asset_trend', 'stock_position'],
    'each outbox attempt must carry the accumulated normalized snapshot, not only the newest extension batch'
  );
  assert.equal(receivedUploads[2].body.evidence.activeAccountRefs.length, 1);
  assert.equal(receivedUploads[2].body.idempotencyKey, receivedUploads[3].body.idempotencyKey);

  const concurrentPayloads = [1, 2].map((offset) => ({
    ...rawPayload,
    capturedAt: `2026-07-14T16:1${offset}:00.000Z`,
    pushedAt: `2026-07-14T16:1${offset}:01.000Z`
  }));
  const concurrentResponses = await Promise.all(concurrentPayloads.map((payload) => fetch(`${helperUrl}/api/tzzb-capture`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })));
  assert.deepEqual(concurrentResponses.map((response) => response.status), [200, 200]);
  await waitForUploads(6);
  assert.equal(maxConcurrentUploads, 1, 'startup and live outbox uploads must remain serialized');

  console.log('PASS tzzb helper cloud upload');
} finally {
  await stopHelper(helper);
  if (cloudServer) await new Promise((resolve) => cloudServer.close(resolve));
  await fs.rm(tempDataDir, { recursive: true, force: true });
}
