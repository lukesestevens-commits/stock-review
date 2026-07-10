import fs from 'node:fs/promises';
import path from 'node:path';

const input = process.argv[2];

if (!input) {
  console.error('Usage: node tools/tzzb-export.mjs data/tzzb/<captured-file>.json');
  process.exit(1);
}

const records = JSON.parse(await fs.readFile(input, 'utf8'));
const selected = records
  .filter((record) => String(record.url || '').includes('/caishen_fund/'))
  .map((record) => {
    let data = record.responseText;
    try {
      data = JSON.parse(record.responseText);
    } catch {
      // Keep the original text when the endpoint returns non-JSON content.
    }

    return {
      capturedAt: record.capturedAt,
      type: record.type || 'browser-response',
      method: record.method,
      status: record.status,
      url: record.url,
      data
    };
  });

const outputPath = path.resolve('data/tzzb/extracted.json');
await fs.writeFile(outputPath, JSON.stringify(selected, null, 2), 'utf8');
console.log(`Saved ${selected.length} extracted records to ${outputPath}`);
