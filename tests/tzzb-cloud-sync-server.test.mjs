import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const helperPort = 8801;
const helperUrl = `http://127.0.0.1:${helperPort}`;
const nodePath = process.execPath;
const tempDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tzzb-cloud-sync-test-'));
const today = new Date().toISOString().slice(0, 10);
const accessKey = 'mobile-sync-secret';

const helper = spawn(nodePath, ['tools/tzzb-local-helper.mjs'], {
  cwd: new URL('..', import.meta.url),
  env: {
    ...process.env,
    TZZB_HELPER_PORT: String(helperPort),
    TZZB_DATA_DIR: tempDataDir,
    TZZB_SYNC_ACCESS_KEY: accessKey
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

const readyPayload = {
  source: 'edge-extension',
  pageUrl: 'https://tzzb.10jqka.com.cn/pc/index.html#/myAccount/a/cloud',
  pushedAt: `${today}T10:01:00.000Z`,
  records: [
    {
      capturedAt: `${today}T10:01:00.000Z`,
      type: 'fetch',
      method: 'POST',
      status: 200,
      url: 'https://tzzb.10jqka.com.cn/caishen_httpserver/tzzb/caishen_fund/pc/asset/v1/stock_position',
      responseText: JSON.stringify({
        ex_data: {
          total_asset: '10000',
          total_value: '9000',
          position: [{ name: '云端持仓', value: '9000', count: '100', price: '90', position_rate: '0.9000' }]
        }
      })
    },
    {
      capturedAt: `${today}T10:01:01.000Z`,
      type: 'fetch',
      method: 'POST',
      status: 200,
      url: 'https://tzzb.10jqka.com.cn/caishen_httpserver/tzzb/caishen_fund/pc/asset/v1/get_money_history',
      responseText: JSON.stringify({
        ex_data: {
          list: [{
            entry_date: today,
            entry_time: '10:00:00',
            name: '云端交易',
            op_name: '买入',
            entry_price: '10',
            entry_count: '100',
            entry_money: '1000'
          }]
        }
      })
    }
  ]
};

try {
  await waitForHealth();

  const deniedUpload = await fetch(`${helperUrl}/api/sync/tzzb`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(readyPayload)
  });
  assert.equal(deniedUpload.status, 401);

  const uploadRes = await fetch(`${helperUrl}/api/sync/tzzb`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-TZZB-Sync-Key': accessKey
    },
    body: JSON.stringify(readyPayload)
  });
  const upload = await uploadRes.json();
  assert.equal(uploadRes.status, 200);
  assert.equal(upload.ok, true);
  assert.equal(upload.raw.readyForReview, true);
  assert.equal(upload.raw.targetDate, today);

  const wrongKeyLatest = await fetch(`${helperUrl}/api/sync/latest?key=wrong`);
  assert.equal(wrongKeyLatest.status, 401);

  const healthRes = await fetch(`${helperUrl}/api/sync/health?key=${encodeURIComponent(accessKey)}`);
  const health = await healthRes.json();
  assert.equal(healthRes.status, 200);
  assert.equal(health.ok, true);
  assert.equal(health.readyForReview, true);
  assert.deepEqual(health.endpointCoverage.missing, []);

  const latestRes = await fetch(`${helperUrl}/api/sync/latest?key=${encodeURIComponent(accessKey)}`);
  const latest = await latestRes.json();
  assert.equal(latestRes.status, 200);
  assert.equal(latest.ok, true);
  assert.equal(latest.raw.readyForReview, true);
  assert.equal(latest.review.holdings[0].name, '云端持仓');
  assert.equal(latest.review.holdings[0].weight, '90.0%');
  assert.equal(latest.review.trades[0].name, '云端交易');

  console.log('PASS tzzb cloud sync server');
} finally {
  helper.kill();
  await fs.rm(tempDataDir, { recursive: true, force: true });
}
