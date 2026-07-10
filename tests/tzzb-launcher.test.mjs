import assert from 'node:assert/strict';
import fs from 'node:fs';

const launcher = fs.readFileSync(new URL('../启动复盘助手.command', import.meta.url), 'utf8');

assert.match(launcher, /tzzb\.10jqka\.com\.cn\/pc\/index\.html#\/myAccount/, 'launcher should open Tonghuashun Investment Ledger');
assert.match(launcher, /TZZB_ACCOUNT_NAME="东方"/, 'launcher should target the 东方 account');
assert.match(launcher, /TZZB_URL="https:\/\/tzzb\.10jqka\.com\.cn\/pc\/index\.html#\/myAccount\/a\/qAgMWG2"/, 'launcher should open the 东方 account URL directly');
assert.match(launcher, /127\.0\.0\.1:8787\//, 'launcher should open the local review page');
assert.match(launcher, /Microsoft Edge/, 'launcher should prefer Edge for the ledger page');
assert.match(launcher, /nohup "\$NODE_BIN" tools\/tzzb-local-helper\.mjs/, 'launcher should detach the helper from the terminal window');
assert.match(launcher, /disown "\$SERVER_PID"/, 'launcher should keep the helper running after the terminal exits');
assert.match(launcher, /closeLauncherWindow/, 'launcher should close the startup terminal window after opening pages');
assert.match(launcher, /EXPECTED_HELPER_VERSION=/, 'launcher should know the helper version it expects');
assert.match(launcher, /helperVersion\(\)/, 'launcher should read the running helper version');
assert.match(launcher, /stopStaleHelper/, 'launcher should restart stale helper processes after code updates');
assert.match(launcher, /CLOUD_SYNC_ENV_FILE=/, 'launcher should support an optional cloud sync env file');
assert.match(launcher, /云同步配置\.env/, 'launcher should use a readable cloud sync config filename');
assert.match(launcher, /source "\$CLOUD_SYNC_ENV_FILE"/, 'launcher should load cloud sync env before starting helper');
assert.match(launcher, /--use-env-proxy/, 'launcher should detect Node environment-proxy support');
assert.match(launcher, /NODE_USE_ENV_PROXY=1/, 'launcher should let cloud uploads use the configured HTTPS proxy');
assert.match(launcher, /scutil --proxy/, 'launcher should read the macOS system proxy when Terminal has no proxy environment');
assert.match(launcher, /export HTTPS_PROXY=/, 'launcher should pass the system HTTPS proxy to the helper');
assert.match(launcher, /export HTTP_PROXY=/, 'launcher should pass the system HTTP proxy to the helper');
assert.doesNotMatch(launcher, /trap .*SERVER_PID.*EXIT/, 'launcher should not kill the helper when the terminal exits');
assert.doesNotMatch(launcher, /wait "\$SERVER_PID"/, 'launcher should not keep the terminal window open waiting for the helper');

const ledgerOpenIndex = launcher.indexOf('open -a "Microsoft Edge" "$TZZB_URL"');
const reviewOpenIndex = launcher.indexOf('open "$REVIEW_URL"');
assert.ok(ledgerOpenIndex >= 0, 'launcher should open the ledger page');
assert.ok(reviewOpenIndex >= 0, 'launcher should open the review page');
assert.ok(ledgerOpenIndex < reviewOpenIndex, 'launcher should open the ledger before the review page so focus ends on review');

console.log('PASS tzzb launcher');
