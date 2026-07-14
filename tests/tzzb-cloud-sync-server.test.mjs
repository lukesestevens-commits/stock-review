import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const helperPort = 8801;
const helperUrl = `http://127.0.0.1:${helperPort}`;
const nodePath = process.execPath;
const tempDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tzzb-cloud-sync-test-'));
const accessKey = 'legacy-local-read-secret';
const accountRef = 'a'.repeat(64);
const capturedAt = '2026-07-14T16:09:00.000Z';

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

const normalizedEvidence = {
  activeAccountRefs: [accountRef],
  records: [
    {
      endpoint: 'last_trading_day',
      capturedAt,
      accountRef: 'c'.repeat(64),
      request: {},
      payload: {
        isTradingDay: true,
        lastTradingDay: '2026-07-15',
        previousTradingDay: '2026-07-14',
        beforePreviousTradingDay: '2026-07-13',
        systemTime: 1784045384264
      }
    },
    {
      endpoint: 'stock_position',
      capturedAt,
      accountRef,
      request: {},
      payload: {
        totalAsset: '10000',
        totalLiability: '0',
        totalValue: '9000',
        positionRate: '0.9',
        cash: '1000',
        positions: [{ code: '000001', name: '云端持仓', quantity: '100', price: '90', value: '9000' }]
      }
    },
    {
      endpoint: 'asset_trend',
      capturedAt,
      accountRef,
      request: {},
      payload: {
        monthProfit: [
          { date: '2026-07-13', asset: '9950', fundIn: '0', fundOut: '0', profit: '100' },
          { date: '2026-07-14', asset: '10000', fundIn: '0', fundOut: '0', profit: '150' }
        ],
        yearProfit: [
          { date: '2026-07-13', asset: '9950', fundIn: '0', fundOut: '0', profit: '100' },
          { date: '2026-07-14', asset: '10000', fundIn: '0', fundOut: '0', profit: '150' }
        ],
        totalAssetHistory: [
          { date: '2026-07-13', asset: '9950', fundIn: '0', fundOut: '0', profit: '100' },
          { date: '2026-07-14', asset: '10000', fundIn: '0', fundOut: '0', profit: '150' }
        ]
      }
    },
    {
      endpoint: 'get_money_history',
      capturedAt,
      accountRef,
      request: { startDate: '2026-07-14', endDate: '2026-07-14', page: 1, count: 200 },
      payload: {
        page: 1,
        maxPage: 1,
        total: 1,
        trades: [{
          code: '000001',
          name: '云端交易',
          side: '买入',
          date: '2026-07-14',
          time: '10:00:00',
          price: '90',
          quantity: '100',
          amount: '9000',
          fee: '0',
          sequenceId: 'trade-1'
        }]
      }
    },
    {
      endpoint: 'merge_day_trading',
      capturedAt,
      accountRef,
      request: {},
      payload: {
        trades: [{
          code: '000001',
          name: '云端交易',
          side: '买入',
          date: '',
          time: '',
          price: '90',
          quantity: '100',
          amount: '9000',
          fee: '0',
          sequenceId: 'trade-1'
        }]
      }
    }
  ]
};

const verifiedAttempt = {
  idempotencyKey: 'local-cloud-capture-1',
  capturedAt,
  captureDate: '2026-07-15',
  evidence: normalizedEvidence
};

try {
  await waitForHealth();

  const deniedUpload = await fetch(`${helperUrl}/api/sync/tzzb`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(verifiedAttempt)
  });
  assert.equal(deniedUpload.status, 401);

  const uploadRes = await fetch(`${helperUrl}/api/sync/tzzb`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-TZZB-Sync-Key': accessKey
    },
    body: JSON.stringify(verifiedAttempt)
  });
  const upload = await uploadRes.json();
  assert.equal(uploadRes.status, 200);
  assert.equal(upload.ok, true);
  assert.equal(upload.state, 'verified', JSON.stringify(upload.audit));
  assert.equal(upload.reviewDate, '2026-07-14');

  const badAttempt = {
    idempotencyKey: 'local-cloud-capture-2',
    capturedAt: '2026-07-14T16:10:00.000Z',
    captureDate: '2026-07-15',
    evidence: { activeAccountRefs: [], records: [] }
  };
  const badUpload = await (await fetch(`${helperUrl}/api/sync/tzzb`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-TZZB-Sync-Key': accessKey
    },
    body: JSON.stringify(badAttempt)
  })).json();
  assert.equal(badUpload.state, 'stored-unverified');

  const wrongKeyLatest = await fetch(`${helperUrl}/api/sync/latest?key=wrong`);
  assert.equal(wrongKeyLatest.status, 401);

  const healthRes = await fetch(`${helperUrl}/api/sync/health?key=${encodeURIComponent(accessKey)}`);
  const health = await healthRes.json();
  assert.equal(healthRes.status, 200);
  assert.equal(health.ok, true);
  assert.equal(health.readyForReview, true);
  assert.equal(health.reviewDate, '2026-07-14');
  assert.equal(health.pending, true);

  const latestRes = await fetch(`${helperUrl}/api/sync/latest?key=${encodeURIComponent(accessKey)}`);
  const latest = await latestRes.json();
  assert.equal(latestRes.status, 200);
  assert.equal(latest.ok, true);
  assert.equal(latest.dailyReview.reviewDate, '2026-07-14');
  assert.equal(latest.dailyReview.holdings[0].name, '云端持仓');
  assert.equal(latest.dailyReview.trades[0].name, '云端交易');
  assert.equal(latest.audit.status, 'verified');
  assert.equal(latest.pendingAttempt.state, 'stored-unverified');
  assert.equal(Object.hasOwn(latest.pendingAttempt, 'normalizedEvidence'), false, 'compatibility reads must not expose normalized evidence');

  console.log('PASS tzzb cloud sync server');
} finally {
  helper.kill();
  await fs.rm(tempDataDir, { recursive: true, force: true });
}
