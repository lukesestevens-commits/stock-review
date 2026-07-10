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
const today = new Date().toISOString().slice(0, 10);
const accessKey = 'upload-secret';
const receivedUploads = [];

const startupPayload = {
  source: 'startup-fixture',
  targetDate: today,
  pushedAt: `${today}T09:55:00.000Z`,
  receivedAt: `${today}T09:55:01.000Z`,
  records: [{
    capturedAt: `${today}T09:55:00.000Z`,
    type: 'fetch',
    method: 'POST',
    status: 200,
    url: 'https://tzzb.10jqka.com.cn/caishen_httpserver/tzzb/caishen_fund/pc/asset/v1/stock_position',
    responseText: JSON.stringify({ ex_data: { total_asset: '10000', position: [] } })
  }]
};
await fs.writeFile(path.join(tempDataDir, 'latest-capture.json'), JSON.stringify(startupPayload), 'utf8');

const cloudServer = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  receivedUploads.push({
    method: req.method,
    url: req.url,
    key: req.headers['x-tzzb-sync-key'] || '',
    body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  });
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: true }));
});

await new Promise((resolve) => cloudServer.listen(cloudPort, '127.0.0.1', resolve));

const helper = spawn(nodePath, ['tools/tzzb-local-helper.mjs'], {
  cwd: new URL('..', import.meta.url),
  env: {
    ...process.env,
    TZZB_HELPER_PORT: String(helperPort),
    TZZB_DATA_DIR: tempDataDir,
    TZZB_CLOUD_SYNC_URL: cloudUrl,
    TZZB_CLOUD_SYNC_KEY: accessKey
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let helperOutput = '';
helper.stdout.on('data', (chunk) => { helperOutput += chunk.toString(); });
helper.stderr.on('data', (chunk) => { helperOutput += chunk.toString(); });

async function waitForHealth() {
  const deadline = Date.now() + 5000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${helperUrl}/api/tzzb-health`);
      if (res.ok) return;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`helper did not become healthy: ${lastError?.message || helperOutput}`);
}

async function waitForUpload() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (receivedUploads.length) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`helper did not upload its saved latest capture on startup: ${helperOutput}`);
}

try {
  await waitForHealth();
  await waitForUpload();
  assert.equal(receivedUploads[0].method, 'POST');
  assert.equal(receivedUploads[0].url, '/api/sync/tzzb');
  assert.equal(receivedUploads[0].key, accessKey);
  assert.equal(receivedUploads[0].body.source, 'startup-fixture');
  receivedUploads.length = 0;

  const capturePayload = {
    source: 'edge-extension',
    pageUrl: 'https://tzzb.10jqka.com.cn/pc/index.html#/myAccount/a/cloud',
    pushedAt: `${today}T10:01:00.000Z`,
    records: [{
      capturedAt: `${today}T10:01:00.000Z`,
      type: 'fetch',
      method: 'POST',
      status: 200,
      url: 'https://tzzb.10jqka.com.cn/caishen_httpserver/tzzb/caishen_fund/pc/asset/v1/stock_position',
      responseText: JSON.stringify({
        ex_data: {
          total_asset: '10000',
          total_value: '9000',
          position: [{ name: '云端持仓', value: '9000', count: '100', price: '90' }]
        }
      })
    }]
  };

  const postRes = await fetch(`${helperUrl}/api/tzzb-capture`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(capturePayload)
  });
  const postData = await postRes.json();
  assert.equal(postRes.status, 200);
  assert.equal(postData.ok, true);

  assert.equal(receivedUploads.length, 1);
  assert.equal(receivedUploads[0].method, 'POST');
  assert.equal(receivedUploads[0].url, '/api/sync/tzzb');
  assert.equal(receivedUploads[0].key, accessKey);
  assert.equal(receivedUploads[0].body.targetDate, today);
  assert.equal(receivedUploads[0].body.records.length, 2, 'new captures should upload the same-day merged local snapshot');

  console.log('PASS tzzb helper cloud upload');
} finally {
  helper.kill();
  await new Promise((resolve) => cloudServer.close(resolve));
  await fs.rm(tempDataDir, { recursive: true, force: true });
}
