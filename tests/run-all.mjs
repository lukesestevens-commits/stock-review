import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const tests = (await fs.readdir(testsDir))
  .filter((file) => file.endsWith('.test.mjs'))
  .sort();

for (const test of tests) {
  const result = spawnSync(process.execPath, [path.join(testsDir, test)], {
    stdio: 'inherit'
  });
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log(`PASS all ${tests.length} test files`);
