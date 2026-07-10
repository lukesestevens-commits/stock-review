import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const probeDir = path.join(root, 'cloud');
const probePath = path.join(probeDir, '.build-probe');
await fs.mkdir(probeDir, { recursive: true });
await fs.writeFile(probePath, 'copied');

const build = spawnSync(process.execPath, ['tools/build-cloud-site.mjs'], {
  cwd: root,
  encoding: 'utf8'
});
await fs.rm(probePath, { force: true });

assert.equal(build.status, 0, build.stderr || build.stdout || 'cloud build failed');

const worker = await fs.readFile(path.join(root, 'dist', 'server', 'index.js'), 'utf8');
const hosting = JSON.parse(await fs.readFile(path.join(root, '.openai', 'hosting.json'), 'utf8'));

assert.match(worker, /今日复盘工作台/);
assert.match(worker, /export default worker/);
assert.equal(hosting.d1, 'DB');
assert.equal(hosting.r2, null);

for (const file of ['cloud/.build-probe', 'tools/tzzb-review-mapper.mjs']) {
  await fs.access(path.join(root, 'dist', 'server', file));
}

console.log('PASS cloud build');
