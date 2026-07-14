import assert from 'node:assert/strict';
import fs from 'node:fs';

const launcher = fs.readFileSync(new URL('../启动复盘助手.command', import.meta.url), 'utf8');
const helper = fs.readFileSync(new URL('../tools/tzzb-local-helper.mjs', import.meta.url), 'utf8');

assert.match(launcher, /tzzb\.10jqka\.com\.cn\/pc\/index\.html#\/myAccount/, 'launcher should open Tonghuashun Investment Ledger');
assert.match(launcher, /TZZB_ACCOUNT_NAME="东方"/, 'launcher should target the 东方 account');
assert.match(launcher, /TZZB_URL="https:\/\/tzzb\.10jqka\.com\.cn\/pc\/index\.html#\/myAccount\/a\/qAgMWG2"/, 'launcher should open the 东方 account URL directly');
assert.match(launcher, /REVIEW_URL="https:\/\/rqw-tzzb-review\.lukesestevens\.chatgpt\.site"/, 'manual launcher should open the one official private Sites review page');
assert.doesNotMatch(launcher, /REVIEW_URL="http:\/\/127\.0\.0\.1:8787\//, 'localhost must not be presented as the official review website');
assert.match(launcher, /Microsoft Edge/, 'launcher should prefer Edge for the ledger page');
assert.match(launcher, /nohup "\$NODE_BIN" tools\/tzzb-local-helper\.mjs/, 'launcher should detach the helper from the terminal window');
assert.match(launcher, /disown "\$SERVER_PID"/, 'launcher should keep the helper running after the terminal exits');
assert.match(launcher, /closeLauncherWindow/, 'launcher should close the startup terminal window after opening pages');
assert.match(launcher, /EXPECTED_HELPER_VERSION=/, 'launcher should know the helper version it expects');
const expectedVersion = launcher.match(/EXPECTED_HELPER_VERSION="([^"]+)"/)?.[1];
const helperVersion = helper.match(/const helperVersion = '([^']+)'/)?.[1];
assert.equal(expectedVersion, helperVersion, 'launcher should restart whenever the helper implementation version changes');
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
assert.match(launcher, /installCaptureSchedule/, 'manual launcher should install the close-capture schedule');
assert.match(launcher, /com\.stockreview\.tzzb-autocapture/, 'launcher should use a stable LaunchAgent label');
assert.match(launcher, /com\.stockreview\.tzzb-helper/, 'launcher should install an independent login-time helper daemon');
assert.match(launcher, /Library\/LaunchAgents/, 'launcher should install into the current user LaunchAgents folder');
assert.match(launcher, /launchctl bootstrap/, 'launcher should load a newly installed user agent');
assert.match(launcher, /launchctl print/, 'launcher should avoid loading an already active agent twice');
assert.match(launcher, /--scheduled/, 'scheduled launches should skip recursive LaunchAgent installation');
assert.match(launcher, /--daemon/, 'helper daemon mode should be non-interactive');
assert.match(launcher, /tzzb-review-schedule\.mjs" --mark-current/, 'manual launch should mark its own catch-up slot before RunAtLoad');
assert.doesNotMatch(launcher, /trap .*SERVER_PID.*EXIT/, 'launcher should not kill the helper when the terminal exits');
assert.doesNotMatch(launcher, /wait "\$SERVER_PID"/, 'launcher should not keep the terminal window open waiting for the helper');

const ledgerOpenIndex = launcher.indexOf('open -a "Microsoft Edge" "$TZZB_URL"');
const reviewOpenIndex = launcher.indexOf('open -a "Microsoft Edge" "$REVIEW_URL"');
assert.ok(ledgerOpenIndex >= 0, 'launcher should open the ledger page');
assert.ok(reviewOpenIndex >= 0, 'launcher should open the review page');
assert.ok(ledgerOpenIndex < reviewOpenIndex, 'launcher should open the ledger before the review page so focus ends on review');
assert.match(
  launcher,
  /if \[ "\$LAUNCH_MODE" != "--scheduled" \]; then[\s\S]*?"\$REVIEW_URL"/,
  'only a manual launch should open the official review site'
);

const markCurrentIndex = launcher.indexOf('tzzb-review-schedule.mjs" --mark-current');
const captureAgentInstallIndex = launcher.indexOf('installLaunchAgent "$LAUNCH_AGENT_LABEL"');
assert.ok(markCurrentIndex < captureAgentInstallIndex, 'manual launch should mark the current capture slot before loading the capture RunAtLoad agent');

console.log('PASS tzzb launcher');
