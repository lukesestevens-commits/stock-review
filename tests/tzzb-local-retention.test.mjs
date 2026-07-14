import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const port = 8813;
const helperUrl = `http://127.0.0.1:${port}`;
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tzzb-local-retention-'));
const rawDir = path.join(dataDir, 'raw-captures');
const outboxDir = path.join(dataDir, 'cloud-outbox');
const dailyStateDir = path.join(dataDir, 'daily-state');
await Promise.all([rawDir, outboxDir, dailyStateDir].map((directory) => fs.mkdir(directory, { recursive: true })));

const dayMs = 24 * 60 * 60 * 1000;
const staleAt = new Date(Date.now() - 32 * dayMs).toISOString();
const freshAt = new Date(Date.now() - dayMs).toISOString();
const staleDate = staleAt.slice(0, 10);
const freshDate = freshAt.slice(0, 10);
const oldMtime = new Date(Date.now() - 32 * dayMs);

async function writeJson(filePath, value, mtime = null) {
  await fs.writeFile(filePath, JSON.stringify(value), 'utf8');
  if (mtime) await fs.utimes(filePath, mtime, mtime);
}

await writeJson(path.join(rawDir, 'stale.json'), { capturedAt: staleAt }, oldMtime);
await writeJson(path.join(dataDir, 'latest-capture.json'), { capturedAt: staleAt });
await writeJson(path.join(dataDir, 'normalized-evidence-accumulator.json'), {
  buckets: {
    stale: { captureDate: staleDate, lastCapturedAt: staleAt, evidence: { records: [] } },
    fresh: { captureDate: freshDate, lastCapturedAt: freshAt, evidence: { records: [] } }
  },
  routes: {
    [staleDate]: { reviewDate: staleDate, resolvedAt: staleAt },
    [freshDate]: { reviewDate: freshDate, resolvedAt: freshAt }
  }
});
await writeJson(path.join(outboxDir, 'stale.json'), { idempotencyKey: 'stale', capturedAt: staleAt, captureDate: staleDate });
await writeJson(path.join(outboxDir, 'fresh.json'), { idempotencyKey: 'fresh', capturedAt: freshAt, captureDate: freshDate });
await writeJson(path.join(dailyStateDir, 'stale-raw.json'), { capturedAt: staleAt, kind: 'raw' });
await writeJson(path.join(dailyStateDir, 'fresh-raw.json'), { capturedAt: freshAt, kind: 'raw' });
await writeJson(path.join(dailyStateDir, 'verified-result.json'), {
  capturedAt: staleAt,
  dailyReview: { reviewDate: staleDate },
  audit: { status: 'verified', reviewDate: staleDate }
}, oldMtime);
await writeJson(path.join(dataDir, 'daily-review-store.json'), {
  attempts: {
    stale: { idempotencyKey: 'stale', captureDate: staleDate, capturedAt: staleAt, state: 'stored-unverified' },
    fresh: { idempotencyKey: 'fresh', captureDate: freshDate, capturedAt: freshAt, state: 'verified' }
  },
  latestVerified: {
    dailyReview: { reviewDate: staleDate, capturedAt: staleAt, pnl: '1.00' },
    audit: { status: 'verified', reviewDate: staleDate, capturedAt: staleAt }
  }
});

const helper = spawn(process.execPath, ['tools/tzzb-local-helper.mjs'], {
  cwd: new URL('..', import.meta.url),
  env: {
    ...process.env,
    TZZB_HELPER_PORT: String(port),
    TZZB_DATA_DIR: dataDir,
    TZZB_CLOUD_SYNC_URL: '',
    TZZB_CLOUD_SYNC_KEY: ''
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let output = '';
helper.stdout.on('data', (chunk) => { output += chunk.toString(); });
helper.stderr.on('data', (chunk) => { output += chunk.toString(); });

async function waitForHealth() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${helperUrl}/api/tzzb-health`);
      if (response.ok) return;
    } catch {
      // Startup cleanup intentionally runs before the listener opens.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`helper did not start: ${output}`);
}

async function assertMissing(filePath, message) {
  await assert.rejects(fs.stat(filePath), (error) => error?.code === 'ENOENT', message);
}

try {
  await waitForHealth();
  await assertMissing(path.join(rawDir, 'stale.json'), 'stale raw archive should be deleted');
  await assertMissing(path.join(dataDir, 'latest-capture.json'), 'stale latest capture should be deleted');
  await assertMissing(path.join(outboxDir, 'stale.json'), 'stale cloud outbox item should be deleted');
  await assertMissing(path.join(dailyStateDir, 'stale-raw.json'), 'stale local raw daily state should be deleted');

  const accumulator = JSON.parse(await fs.readFile(
    path.join(dataDir, 'normalized-evidence-accumulator.json'),
    'utf8'
  ));
  assert.deepEqual(Object.keys(accumulator.buckets), ['fresh']);
  assert.deepEqual(Object.keys(accumulator.routes), [freshDate]);
  assert.deepEqual((await fs.readdir(outboxDir)).sort(), ['fresh.json']);
  assert.deepEqual((await fs.readdir(dailyStateDir)).sort(), ['fresh-raw.json', 'verified-result.json']);

  const dailyStore = JSON.parse(await fs.readFile(path.join(dataDir, 'daily-review-store.json'), 'utf8'));
  assert.deepEqual(Object.keys(dailyStore.attempts), ['fresh']);
  assert.equal(dailyStore.latestVerified.dailyReview.reviewDate, staleDate, 'verified review results must be retained long term');

  console.log('PASS tzzb local retention');
} finally {
  if (helper.exitCode === null) {
    helper.kill();
    await new Promise((resolve) => helper.once('exit', resolve));
  }
  await fs.rm(dataDir, { recursive: true, force: true });
}
