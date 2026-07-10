import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const helperPort = 8799;
const helperUrl = `http://127.0.0.1:${helperPort}`;
const nodePath = process.execPath;
const tempDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tzzb-helper-test-'));
const today = new Date().toISOString().slice(0, 10);
const marketFixture = JSON.stringify({
  data: {
    diff: [
      { f12: '000001', f14: '上证指数', f2: 3200.1, f3: 0.42, f4: 13.2 },
      { f12: '399001', f14: '深证成指', f2: 10000.2, f3: 0.61, f4: 60.1 },
      { f12: '399006', f14: '创业板指', f2: 2200.3, f3: -0.12, f4: -2.7 }
    ]
  }
});
const helper = spawn(nodePath, ['tools/tzzb-local-helper.mjs'], {
  cwd: new URL('..', import.meta.url),
  env: {
    ...process.env,
    TZZB_HELPER_PORT: String(helperPort),
    TZZB_DATA_DIR: tempDataDir,
    TZZB_MARKET_FIXTURE: marketFixture
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
      if (res.ok) return res.json();
      lastError = new Error(`HTTP ${res.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`helper did not become healthy: ${lastError?.message || helperOutput}`);
}

try {
  const health = await waitForHealth();
  assert.equal(health.ok, true);
  assert.equal(typeof health.version, 'string');
  assert.equal(typeof health.latestRecordCount, 'number');

  const capturePayload = {
    source: 'edge-extension',
    pageUrl: 'https://tzzb.10jqka.com.cn/pc/index.html#/myAccount/a/demo',
    pushedAt: `${today}T10:00:00.000Z`,
    records: [
      {
        capturedAt: '2000-01-01T09:00:00.000Z',
        type: 'fetch',
        method: 'POST',
        status: 200,
        url: 'https://tzzb.10jqka.com.cn/caishen_httpserver/tzzb/caishen_fund/pc/account/v1/init',
        responseText: '{"old":true}'
      },
      {
        capturedAt: `${today}T09:59:00.000Z`,
        type: 'fetch',
        method: 'POST',
        status: 200,
        url: 'https://tzzb.10jqka.com.cn/caishen_httpserver/tzzb/caishen_fund/pc/account/v1/init',
        responseText: '{"ok":true}'
      }
    ]
  };

  const postRes = await fetch(`${helperUrl}/api/tzzb-capture`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(capturePayload)
  });
  const postData = await postRes.json();
  assert.equal(postRes.status, 200);
  assert.equal(postData.ok, true);
  assert.equal(postData.records, 1);
  assert.equal(postData.endpointCoverage.readyForReview, false);

  const readyPayload = {
    source: 'edge-extension',
    pageUrl: 'https://tzzb.10jqka.com.cn/pc/index.html#/myAccount/a/demo',
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
            money_remain: '1000',
            position: [{ name: '今日持仓', value: '9000', count: '100', price: '90' }]
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
              name: '今日交易',
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
  const readyPost = await fetch(`${helperUrl}/api/tzzb-capture`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(readyPayload)
  });
  const readyData = await readyPost.json();
  assert.equal(readyData.ok, true);
  assert.equal(readyData.endpointCoverage.readyForReview, true);

  const quoteOnlyPayload = {
    source: 'edge-extension',
    pageUrl: 'https://tzzb.10jqka.com.cn/pc/index.html#/myAccount/a/demo',
    pushedAt: `${today}T10:02:00.000Z`,
    records: [{
      capturedAt: `${today}T10:02:00.000Z`,
      type: 'fetch',
      method: 'GET',
      status: 200,
      url: 'https://tzzb.10jqka.com.cn/caishen_httpserver/tzzb/caishen_fund/pc/quote/v1/pass_quotes',
      responseText: '{"ok":true}'
    }]
  };
  await fetch(`${helperUrl}/api/tzzb-capture`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(quoteOnlyPayload)
  });

  const latestRes = await fetch(`${helperUrl}/api/tzzb-latest`);
  const latest = await latestRes.json();
  assert.equal(latest.ok, true);
  assert.equal(latest.raw.records, 4);
  assert.equal(latest.raw.source, 'edge-extension');
  assert.equal(latest.raw.readyForReview, true);
  assert.equal(latest.review.tzzb.holdingCount, 1);
  assert.equal(latest.review.trades.length, 1);

  const nextHealth = await (await fetch(`${helperUrl}/api/tzzb-health`)).json();
  assert.equal(nextHealth.latestRecordCount, 4);
  assert.equal(nextHealth.readyForReview, true);
  assert.deepEqual(nextHealth.endpointCoverage.missing, []);
  assert.equal(typeof nextHealth.latestReceivedAt, 'string');
  assert.equal(nextHealth.importAudit.trustLevel, 'ready');
  assert.equal(nextHealth.importAudit.capitalSource, 'stock_position.calculated');
  assert.equal(nextHealth.importAudit.tradeSource, 'get_money_history');

  const marketRes = await fetch(`${helperUrl}/api/market-snapshot`);
  const market = await marketRes.json();
  assert.equal(marketRes.status, 200);
  assert.equal(market.ok, true);
  assert.equal(market.market.indexState, '指数强');
  assert.equal(market.market.mood, '分化');

  const clearRes = await fetch(`${helperUrl}/api/tzzb-clear`, { method: 'POST' });
  const clearData = await clearRes.json();
  assert.equal(clearRes.status, 200);
  assert.equal(clearData.ok, true);
  assert.equal(clearData.cleared, true);
  const clearedHealth = await (await fetch(`${helperUrl}/api/tzzb-health`)).json();
  assert.equal(clearedHealth.latestRecordCount, 0);
  assert.equal(clearedHealth.latestReceivedAt, '');

  console.log('PASS tzzb helper server');
} finally {
  helper.kill();
  await fs.rm(tempDataDir, { recursive: true, force: true });
}
