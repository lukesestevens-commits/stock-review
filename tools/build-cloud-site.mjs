import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverDir = path.join(root, 'dist', 'server');

await fs.rm(path.join(root, 'dist'), { recursive: true, force: true });
await fs.mkdir(serverDir, { recursive: true });

await fs.cp(path.join(root, 'cloud'), path.join(serverDir, 'cloud'), { recursive: true });
await fs.mkdir(path.join(serverDir, 'tools'), { recursive: true });

for (const file of [
  'daily-review-sync.mjs',
  'market-public-data.mjs',
  'tzzb-evidence-adapter.mjs',
  'tzzb-endpoint-coverage.mjs',
  'tzzb-review-mapper.mjs'
]) {
  await fs.copyFile(path.join(root, 'tools', file), path.join(serverDir, 'tools', file));
}

const indexHtml = await fs.readFile(path.join(root, 'index.html'), 'utf8');
const entry = [
  "import { createCloudWorker } from './cloud/worker.mjs';",
  `const worker = createCloudWorker({ indexHtml: ${JSON.stringify(indexHtml)} });`,
  'export default worker;',
  ''
].join('\n');

await fs.writeFile(path.join(serverDir, 'index.js'), entry, 'utf8');
console.log('Built dist/server/index.js');
