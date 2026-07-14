import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const helperPort = 8799;
const helperUrl = `http://127.0.0.1:${helperPort}`;
const nodePath = process.execPath;
const tempDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tzzb-helper-test-'));
const rawArchiveDir = path.join(tempDataDir, 'raw-captures');
await fs.mkdir(rawArchiveDir, { recursive: true });
const staleArchivePath = path.join(rawArchiveDir, 'stale-capture.json');
await fs.writeFile(staleArchivePath, '{"stale":true}', 'utf8');
const staleTime = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
await fs.utimes(staleArchivePath, staleTime, staleTime);
const accountRequest = 'userid=user-secret&manual_id=manual-A&fund_key=fund-A&cookie=cookie-secret';
const secondAccountRequest = 'userid=user-secret&manual_id=manual-B&fund_key=fund-B&cookie=cookie-secret';
const beforeMidnight = '2026-07-14T15:59:00.000Z';
const afterMidnight = '2026-07-14T16:09:00.000Z';
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

function record(url, response, requestPostData = accountRequest) {
  return {
    capturedAt: beforeMidnight,
    type: 'fetch',
    method: 'POST',
    status: 200,
    url,
    requestPostData,
    responseText: JSON.stringify(response)
  };
}

const verifiedPayload = {
  source: 'edge-extension',
  pageUrl: 'https://tzzb.10jqka.com.cn/pc/index.html#/myAccount/a/demo',
  pushedAt: afterMidnight,
  capturedAt: afterMidnight,
  captureDate: '1999-01-01',
  records: [
    record(
      'https://tzzb.10jqka.com.cn/caishen_fund/pc/account/v1/account_list',
      {
        ex_data: {
          common: [
            { manual_id: 'manual-A', fund_key: 'fund-A' },
            { manual_id: 'manual-B', fund_key: 'fund-B' }
          ]
        }
      }
    ),
    record(
      'https://tzzb.10jqka.com.cn/caishen_fund/stock_common/v1/last_trading_day',
      {
        ex_data: {
          is_trading_day: 1,
          last_trading_day: '2026-07-15',
          prev_trading_day: '2026-07-14',
          before_prev_trading_day: '2026-07-13',
          system_time: 1784045384264
        }
      }
    ),
    record(
      'https://tzzb.10jqka.com.cn/caishen_fund/pc/asset/v1/stock_position',
      {
        ex_data: {
          total_asset: '10000',
          total_liability: '0',
          total_value: '9000',
          position_rate: '0.9',
          money_remain: '1000',
          position: [{ code: '000001', name: '可靠持仓', count: '100', price: '90', value: '9000' }]
        }
      }
    ),
    record(
      'https://tzzb.10jqka.com.cn/caishen_fund/pc/asset/v1/asset_trend',
      {
        ex_data: {
          month_profit: [
            { date: '20260713', asset: '9950', fund_in: '0', fund_out: '0', profit: '100' },
            { date: '20260714', asset: '10000', fund_in: '0', fund_out: '0', profit: '150' }
          ],
          year_profit: [
            { date: '20260713', asset: '9950', fund_in: '0', fund_out: '0', profit: '100' },
            { date: '20260714', asset: '10000', fund_in: '0', fund_out: '0', profit: '150' }
          ],
          total_asset: [
            { date: '20260713', asset: '9950', fund_in: '0', fund_out: '0', profit: '100' },
            { date: '20260714', asset: '10000', fund_in: '0', fund_out: '0', profit: '150' }
          ]
        }
      }
    ),
    record(
      'https://tzzb.10jqka.com.cn/caishen_fund/pc/asset/v1/get_money_history',
      {
        ex_data: {
          page: 1,
          max_page: 2,
          total: 2,
          list: [{
            entry_date: '2026-07-14',
            entry_time: '10:00:00',
            code: '000001',
            name: '可靠交易A1',
            op_name: '买入',
            entry_price: '90',
            entry_count: '50',
            entry_money: '4500',
            business_no: 'trade-A1'
          }]
        }
      },
      `${accountRequest}&start_date=20260714&end_date=20260714&page=1&count=200`
    ),
    record(
      'https://tzzb.10jqka.com.cn/caishen_fund/pc/asset/v1/stock_position',
      {
        ex_data: {
          total_asset: '5000',
          total_liability: '0',
          total_value: '4000',
          position_rate: '0.8',
          money_remain: '1000',
          position: [{ code: '000002', name: '可靠持仓B', count: '100', price: '40', value: '4000' }]
        }
      },
      secondAccountRequest
    )
  ]
};

const secondBatchPayload = {
  source: 'edge-extension',
  pageUrl: verifiedPayload.pageUrl,
  pushedAt: '2026-07-14T16:09:10.000Z',
  capturedAt: '2026-07-14T16:09:10.000Z',
  records: [
    record(
      'https://tzzb.10jqka.com.cn/caishen_fund/pc/asset/v1/asset_trend',
      {
        ex_data: {
          month_profit: [
            { date: '20260713', asset: '4980', fund_in: '0', fund_out: '0', profit: '40' },
            { date: '20260714', asset: '5000', fund_in: '0', fund_out: '0', profit: '60' }
          ],
          year_profit: [
            { date: '20260713', asset: '4980', fund_in: '0', fund_out: '0', profit: '40' },
            { date: '20260714', asset: '5000', fund_in: '0', fund_out: '0', profit: '60' }
          ],
          total_asset: [
            { date: '20260713', asset: '4980', fund_in: '0', fund_out: '0', profit: '40' },
            { date: '20260714', asset: '5000', fund_in: '0', fund_out: '0', profit: '60' }
          ]
        }
      },
      secondAccountRequest
    ),
    record(
      'https://tzzb.10jqka.com.cn/caishen_fund/pc/asset/v1/get_money_history',
      {
        ex_data: {
          page: 2,
          max_page: 2,
          total: 2,
          list: [{
            entry_date: '2026-07-14',
            entry_time: '10:01:00',
            code: '000001',
            name: '可靠交易A2',
            op_name: '买入',
            entry_price: '90',
            entry_count: '50',
            entry_money: '4500',
            business_no: 'trade-A2'
          }]
        }
      },
      `${accountRequest}&start_date=20260714&end_date=20260714&page=2&count=200`
    ),
    record(
      'https://tzzb.10jqka.com.cn/caishen_fund/pc/asset/v1/get_money_history',
      {
        ex_data: {
          page: 1,
          max_page: 1,
          total: 1,
          list: [{
            entry_date: '2026-07-14',
            entry_time: '10:02:00',
            code: '000002',
            name: '可靠交易B',
            op_name: '买入',
            entry_price: '40',
            entry_count: '100',
            entry_money: '4000',
            business_no: 'trade-B1'
          }]
        }
      },
      `${secondAccountRequest}&start_date=20260714&end_date=20260714&page=1&count=200`
    ),
    record(
      'https://tzzb.10jqka.com.cn/caishen_fund/pc/account/v1/merge_day_trading',
      {
        ex_data: {
          data: [
            { zqdm: '000001', zqmc: '可靠交易A1', czlx: '买入', cjjg: '90', cjsl: '50', moneychg: '4500', entrust_no: 'trade-A1' },
            { zqdm: '000001', zqmc: '可靠交易A2', czlx: '买入', cjjg: '90', cjsl: '50', moneychg: '4500', entrust_no: 'trade-A2' }
          ]
        }
      },
      accountRequest
    ),
    record(
      'https://tzzb.10jqka.com.cn/caishen_fund/pc/account/v1/merge_day_trading',
      {
        ex_data: {
          data: [
            { zqdm: '000002', zqmc: '可靠交易B', czlx: '买入', cjjg: '40', cjsl: '100', moneychg: '4000', entrust_no: 'trade-B1' }
          ]
        }
      },
      secondAccountRequest
    )
  ]
};

try {
  const health = await waitForHealth();
  assert.equal(health.ok, true);
  assert.equal(health.version, '2026.07.15-daily-review-private-r11');
  assert.equal(typeof health.latestRecordCount, 'number');

  for (const sensitivePath of ['/云同步配置.env', '/.git/config', '/data/tzzb/latest-capture.json']) {
    const response = await fetch(`${helperUrl}${sensitivePath}`);
    assert.equal(response.status, 404, `${sensitivePath} must never be served by the local helper`);
  }

  const evilRead = await fetch(`${helperUrl}/api/tzzb-latest`, {
    headers: { Origin: 'https://evil.example.com' }
  });
  assert.equal(evilRead.status, 403);
  assert.equal(evilRead.headers.get('access-control-allow-origin'), null);

  const evilWrite = await fetch(`${helperUrl}/api/tzzb-capture`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' },
    body: JSON.stringify(verifiedPayload)
  });
  assert.equal(evilWrite.status, 403);
  const afterEvilWrite = await (await fetch(`${helperUrl}/api/tzzb-health`)).json();
  assert.equal(afterEvilWrite.latestRecordCount, 0, 'a rejected origin must not mutate local state');

  const extensionOrigin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
  const extensionHealth = await fetch(`${helperUrl}/api/tzzb-health`, {
    headers: { Origin: extensionOrigin }
  });
  assert.equal(extensionHealth.status, 200);
  assert.equal(extensionHealth.headers.get('access-control-allow-origin'), extensionOrigin);

  const extensionInfoResponse = await fetch(`${helperUrl}/api/tzzb-extension-info`, {
    headers: { Origin: extensionOrigin }
  });
  const extensionInfo = await extensionInfoResponse.json();
  assert.equal(extensionInfoResponse.status, 200);
  assert.match(extensionInfo.helperToken, /^[a-f0-9]{64}$/);
  const tokenStat = await fs.stat(path.join(tempDataDir, 'helper-auth-token.json'));
  assert.equal(tokenStat.mode & 0o777, 0o600, 'the per-machine helper token must not be world-readable');

  const tzzbInfo = await fetch(`${helperUrl}/api/tzzb-extension-info`, {
    headers: { Origin: 'https://tzzb.10jqka.com.cn' }
  });
  assert.equal(tzzbInfo.status, 403, 'the remote ledger page cannot read the local helper token');
  const tzzbLatest = await fetch(`${helperUrl}/api/tzzb-latest`, {
    headers: { Origin: 'https://tzzb.10jqka.com.cn' }
  });
  assert.equal(tzzbLatest.status, 403, 'the remote ledger page cannot read local verified review data');
  assert.equal(tzzbLatest.headers.get('access-control-allow-origin'), null);
  assert.equal((await fetch(`${helperUrl}/tzzb/bookmarklet.js`, {
    headers: { Origin: 'https://tzzb.10jqka.com.cn' }
  })).status, 403, 'the remote ledger page cannot download a token-bearing bookmarklet');
  const tzzbUnauthenticatedWrite = await fetch(`${helperUrl}/api/tzzb-capture`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://tzzb.10jqka.com.cn' },
    body: JSON.stringify(verifiedPayload)
  });
  assert.equal(tzzbUnauthenticatedWrite.status, 401, 'remote-origin mutations require the per-machine token');
  const authenticatedClear = await fetch(`${helperUrl}/api/tzzb-clear`, {
    method: 'POST',
    headers: { Origin: extensionOrigin, 'X-TZZB-Helper-Token': extensionInfo.helperToken }
  });
  assert.equal(authenticatedClear.status, 200, 'the installed extension may perform authenticated local mutations');

  const bookmarkletSource = await (await fetch(`${helperUrl}/tzzb/bookmarklet.js`)).text();
  assert.doesNotMatch(bookmarkletSource, /__TZZB_HELPER_TOKEN__/);
  assert.match(bookmarkletSource, /X-TZZB-Helper-Token/);

  const postRes = await fetch(`${helperUrl}/api/tzzb-capture`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(verifiedPayload)
  });
  const postData = await postRes.json();
  assert.equal(postRes.status, 200);
  assert.equal(postData.ok, true);
  assert.equal(postData.records, verifiedPayload.records.length, 'records captured before midnight must not be discarded after midnight');
  assert.equal(postData.state, 'stored-unverified', 'the first partial multi-account/page batch should remain pending');
  assert.equal(postData.reviewDate, '2026-07-14');

  const archivedFiles = await fs.readdir(rawArchiveDir);
  assert.equal(archivedFiles.includes('stale-capture.json'), false, 'raw captures older than 30 days must be pruned');
  assert.equal(archivedFiles.length, 1, 'the accepted raw capture must be archived locally');
  const archivedCapture = JSON.parse(await fs.readFile(path.join(rawArchiveDir, archivedFiles[0]), 'utf8'));
  assert.equal(archivedCapture.pageUrl, verifiedPayload.pageUrl);
  assert.equal(archivedCapture.records.length, verifiedPayload.records.length);
  assert.match(JSON.stringify(archivedCapture), /manual-A/, 'raw evidence may be retained locally but must not cross the cloud seam');

  const secondPostRes = await fetch(`${helperUrl}/api/tzzb-capture`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(secondBatchPayload)
  });
  const secondPostData = await secondPostRes.json();
  assert.equal(secondPostRes.status, 200);
  assert.equal(secondPostData.records, secondBatchPayload.records.length);
  assert.equal(secondPostData.state, 'verified', JSON.stringify(secondPostData.audit));
  assert.equal(secondPostData.reviewDate, '2026-07-14');

  const verifiedLatest = await (await fetch(`${helperUrl}/api/tzzb-latest`)).json();
  assert.deepEqual(Object.keys(verifiedLatest), ['ok', 'dailyReview', 'audit', 'pendingAttempt']);
  assert.equal(verifiedLatest.ok, true);
  assert.equal(verifiedLatest.dailyReview.reviewDate, '2026-07-14');
  assert.equal(verifiedLatest.dailyReview.pnl, '70.00');
  assert.deepEqual(verifiedLatest.dailyReview.holdings.map((holding) => holding.name), ['可靠持仓', '可靠持仓B']);
  assert.equal(verifiedLatest.dailyReview.trades.length, 3, 'all pages and accounts must survive normalized evidence accumulation');
  assert.equal(verifiedLatest.audit.status, 'verified');
  assert.equal(verifiedLatest.pendingAttempt, null);

  const activeAccountRefresh = {
    source: 'edge-extension',
    pushedAt: '2026-07-14T16:09:21.000Z',
    capturedAt: '2026-07-14T16:09:20.000Z',
    records: [record(
      'https://tzzb.10jqka.com.cn/caishen_fund/pc/account/v1/account_list',
      { ex_data: { common: [{ manual_id: 'manual-A', fund_key: 'fund-A' }] } }
    )]
  };
  const accountRefreshResult = await (await fetch(`${helperUrl}/api/tzzb-capture`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(activeAccountRefresh)
  })).json();
  assert.equal(accountRefreshResult.state, 'verified');
  const refreshedAccounts = await (await fetch(`${helperUrl}/api/tzzb-latest`)).json();
  assert.deepEqual(
    refreshedAccounts.dailyReview.holdings.map((holding) => holding.name),
    ['可靠持仓'],
    'the newest non-empty account list must replace deactivated accounts instead of unioning them forever'
  );
  assert.equal(refreshedAccounts.dailyReview.trades.length, 2);
  assert.equal(refreshedAccounts.dailyReview.pnl, '50.00');
  assert.equal(refreshedAccounts.pendingAttempt, null);

  const irrelevantPayload = {
    source: 'edge-extension',
    pushedAt: '2026-07-14T16:10:00.000Z',
    capturedAt: '2026-07-14T16:10:00.000Z',
    records: [record(
      'https://tzzb.10jqka.com.cn/caishen_fund/pc/quote/v1/pass_quotes',
      { quotes: ['incomplete'] }
    )]
  };
  const irrelevantResult = await (await fetch(`${helperUrl}/api/tzzb-capture`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(irrelevantPayload)
  })).json();
  assert.equal(irrelevantResult.state, 'ignored', 'unrelated quote traffic must not create a false pending review');
  assert.equal((await (await fetch(`${helperUrl}/api/tzzb-latest`)).json()).pendingAttempt, null);

  const badPayload = {
    source: 'edge-extension',
    pushedAt: '2026-07-14T16:10:10.000Z',
    capturedAt: '2026-07-14T16:10:10.000Z',
    records: [record(
      'https://tzzb.10jqka.com.cn/caishen_fund/pc/asset/v1/stock_position',
      {
        ex_data: {
          total_asset: 'bad-number',
          total_liability: '0',
          total_value: '9000',
          position_rate: '0.9',
          money_remain: '1000',
          position: [{ code: '000001', name: '坏候选', count: '100', price: '90', value: '9000' }]
        }
      }
    )]
  };
  const badResult = await (await fetch(`${helperUrl}/api/tzzb-capture`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(badPayload)
  })).json();
  assert.equal(badResult.state, 'stored-unverified');

  const preserved = await (await fetch(`${helperUrl}/api/tzzb-latest`)).json();
  assert.equal(preserved.dailyReview.reviewDate, '2026-07-14', 'an incomplete candidate must not replace the last verified review');
  assert.equal(preserved.dailyReview.pnl, '50.00');
  assert.equal(preserved.audit.status, 'verified');
  assert.equal(preserved.pendingAttempt.state, 'stored-unverified');
  assert.equal(preserved.pendingAttempt.captureDate, '2026-07-15', 'captureDate must always use Asia/Shanghai');

  const nextHealth = await (await fetch(`${helperUrl}/api/tzzb-health`)).json();
  assert.equal(nextHealth.latestRecordCount, 1);
  assert.equal(nextHealth.targetDate, '2026-07-15');
  assert.equal(nextHealth.readyForReview, false);
  assert.equal(typeof nextHealth.latestReceivedAt, 'string');

  const marketRes = await fetch(`${helperUrl}/api/market-snapshot`);
  const market = await marketRes.json();
  assert.equal(marketRes.status, 200);
  assert.equal(market.ok, true);
  assert.equal(market.market.indexState, '指数强');
  assert.equal(market.market.mood, '分化');

  console.log('PASS tzzb helper server');
} finally {
  helper.kill();
  await fs.rm(tempDataDir, { recursive: true, force: true });
}
