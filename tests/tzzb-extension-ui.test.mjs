import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

assert.match(html, /安装\/检查捕获扩展/, 'review page should expose the extension install/check action');
assert.match(html, /\/api\/tzzb-health/, 'review page should check local helper health');
assert.match(html, /autoImportLatestTzzbData/, 'review page should auto-import newly synced tzzb captures');
assert.match(html, /lastTzzbImportedAt/, 'review page should remember the last imported capture timestamp');
assert.match(html, /applyMarketSnapshot/, 'review page should apply public market snapshot fields');
assert.match(html, /\/api\/market-snapshot/, 'review page should fetch public market snapshot from local helper');
assert.match(html, /readyForReview/, 'review page should gate tzzb import on readiness');
assert.match(html, /缺少/, 'review page should show missing tzzb endpoint diagnostics');
assert.match(html, /tzzbImportAudit/, 'review page should show import audit details');
assert.match(html, /clearTzzbCaptureData/, 'review page should let the user clear local capture data');
assert.match(html, /STORAGE_TZZB_IMPORT/, 'review page should persist the last imported capture marker');
assert.doesNotMatch(html, /复制捕获书签/, 'bookmarklet copy should no longer be the primary capture action');

console.log('PASS tzzb extension UI copy');
