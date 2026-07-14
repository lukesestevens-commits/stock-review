import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CAPTURE_TIMES,
  calendarRefreshSlot,
  isSlotVerified,
  latestDueSlot,
  readTradingCalendarState,
  shouldRunSlot
} from '../tools/tzzb-review-schedule.mjs';

const tradingWednesday = {
  observedDate: '2026-07-15',
  isTradingDay: true,
  lastTradingDay: '2026-07-15',
  previousTradingDay: '2026-07-14'
};

assert.deepEqual(
  CAPTURE_TIMES,
  [
    '15:35', '15:40', '15:50', '16:10',
    '16:30', '17:00', '17:30', '18:00', '18:30', '19:00', '19:30',
    '20:00', '20:30', '21:00', '21:30', '22:00', '22:30', '23:00', '23:30'
  ],
  'capture cadence should include close bursts and half-hour checks through 23:30'
);

assert.deepEqual(
  latestDueSlot(new Date('2026-07-15T15:35:00+08:00'), tradingWednesday),
  { date: '2026-07-15', time: '15:35', key: '2026-07-15T15:35' }
);
assert.deepEqual(
  latestDueSlot(new Date('2026-07-15T18:47:00+08:00'), tradingWednesday),
  { date: '2026-07-15', time: '18:30', key: '2026-07-15T18:30' },
  'wake-up between slots should catch up the latest missed slot'
);
assert.deepEqual(
  latestDueSlot(new Date('2026-07-20T08:00:00+08:00'), {
    observedDate: '2026-07-20',
    isTradingDay: true,
    lastTradingDay: '2026-07-20',
    previousTradingDay: '2026-07-17'
  }),
  { date: '2026-07-17', time: '23:30', key: '2026-07-17T23:30' },
  'before close, the exchange calendar should select its previous completed trading day'
);
assert.deepEqual(
  latestDueSlot(new Date('2026-10-01T18:47:00+08:00'), {
    observedDate: '2026-10-01',
    isTradingDay: false,
    lastTradingDay: '2026-09-30',
    previousTradingDay: '2026-09-29'
  }),
  { date: '2026-09-30', time: '23:30', key: '2026-09-30T23:30' },
  'a statutory holiday should only catch up the latest completed exchange day'
);
assert.equal(
  latestDueSlot(new Date('2026-10-01T18:47:00+08:00'), null),
  null,
  'without exchange-calendar evidence the scheduler must fail closed instead of guessing from weekdays'
);
assert.deepEqual(
  calendarRefreshSlot(new Date('2026-10-01T08:00:00+08:00'), null),
  {
    date: '2026-10-01',
    time: 'calendar-refresh-startup',
    key: '2026-10-01Tcalendar-refresh-startup',
    calendarRefresh: true
  },
  'without a calendar the scheduler must first open the ledger once so the extension can obtain one'
);
assert.deepEqual(
  calendarRefreshSlot(new Date('2026-07-16T15:35:00+08:00'), tradingWednesday),
  {
    date: '2026-07-16',
    time: 'calendar-refresh-15:35',
    key: '2026-07-16Tcalendar-refresh-15:35',
    calendarRefresh: true
  },
  'a stale calendar must trigger one refresh on the next natural day instead of disabling future automation'
);
assert.notEqual(
  calendarRefreshSlot(new Date('2026-07-16T15:35:00+08:00'), tradingWednesday).key,
  calendarRefreshSlot(new Date('2026-07-16T15:40:00+08:00'), tradingWednesday).key,
  'a failed calendar refresh must retry at every configured close slot'
);
assert.equal(
  calendarRefreshSlot(new Date('2026-07-15T15:35:00+08:00'), tradingWednesday),
  null,
  'a current exchange calendar does not need an extra refresh launch'
);
assert.equal(
  latestDueSlot(new Date('2026-10-01T18:47:00+08:00'), {
    observedDate: '',
    isTradingDay: false,
    lastTradingDay: '2026-09-30',
    previousTradingDay: '2026-09-29'
  }),
  null,
  'malformed calendar evidence must fail closed'
);
assert.equal(shouldRunSlot('', latestDueSlot(new Date('2026-07-15T18:47:00+08:00'), tradingWednesday)), true);
assert.equal(shouldRunSlot('2026-07-15T18:30', latestDueSlot(new Date('2026-07-15T18:47:00+08:00'), tradingWednesday)), false);
assert.equal(isSlotVerified(
  { date: '2026-07-15', time: '16:10', key: '2026-07-15T16:10' },
  { state: 'verified', captureDate: '2026-07-16', reviewDate: '2026-07-15' }
), true, 'later retry slots should stop after a same-day cloud verification');
assert.equal(isSlotVerified(
  { date: '2026-07-15', time: '16:10', key: '2026-07-15T16:10' },
  { state: 'stored-unverified', captureDate: '2026-07-15', reviewDate: '2026-07-15' }
), false, 'held evidence must keep the retry cadence active');
assert.equal(isSlotVerified(
  { date: '2026-07-16', time: '15:35', key: '2026-07-16T15:35' },
  { state: 'verified', captureDate: '2026-07-15', reviewDate: '2026-07-15' }
), false, 'yesterday verification must not suppress a new close-day capture');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tzzb-schedule-calendar-'));
const accumulatorFile = path.join(tempDir, 'normalized-evidence-accumulator.json');
const latestCaptureFile = path.join(tempDir, 'latest-capture.json');
fs.writeFileSync(accumulatorFile, JSON.stringify({
  buckets: {
    '2026-10-01': {
      evidence: {
        records: [{
          endpoint: 'last_trading_day',
          capturedAt: '2026-10-01T07:36:00.000Z',
          payload: {
            isTradingDay: false,
            lastTradingDay: '2026-09-30',
            previousTradingDay: '2026-09-29',
            systemTime: Date.parse('2026-10-01T15:36:00+08:00')
          }
        }]
      }
    }
  }
}));
assert.deepEqual(
  readTradingCalendarState({ accumulatorFile, latestCaptureFile }),
  {
    observedDate: '2026-10-01',
    isTradingDay: false,
    lastTradingDay: '2026-09-30',
    previousTradingDay: '2026-09-29',
    capturedAt: '2026-10-01T07:36:00.000Z'
  },
  'scheduler should reuse the last_trading_day evidence already captured locally'
);
fs.writeFileSync(latestCaptureFile, JSON.stringify({
  records: [{
    capturedAt: '2026-10-02T07:36:00.000Z',
    status: 200,
    url: 'https://tzzb.10jqka.com.cn/caishen_fund/stock_common/v1/last_trading_day',
    responseText: JSON.stringify({
      error_code: '0',
      ex_data: {
        is_trading_day: '0',
        last_trading_day: '20261001',
        prev_trading_day: '20260930',
        system_time: Date.parse('2026-10-02T15:36:00+08:00')
      }
    })
  }]
}));
assert.equal(
  readTradingCalendarState({ accumulatorFile, latestCaptureFile }).observedDate,
  '2026-10-02',
  'a newer raw last_trading_day response should refresh an older accumulated calendar'
);
fs.rmSync(tempDir, { recursive: true, force: true });

const scheduleSource = fs.readFileSync(new URL('../tools/tzzb-review-schedule.mjs', import.meta.url), 'utf8');
const template = fs.readFileSync(new URL('../tools/com.stockreview.tzzb-autocapture.plist.template', import.meta.url), 'utf8');
const helperTemplate = fs.readFileSync(new URL('../tools/com.stockreview.tzzb-helper.plist.template', import.meta.url), 'utf8');
const runner = fs.readFileSync(new URL('../tools/tzzb-scheduled-capture.command', import.meta.url), 'utf8');
assert.match(template, /<key>RunAtLoad<\/key>\s*<true\/>/, 'login/startup should invoke the catch-up scheduler');
assert.match(template, /<key>StartCalendarInterval<\/key>/, 'launchd should invoke every configured close slot');
for (const time of CAPTURE_TIMES) {
  const [hour, minute] = time.split(':').map(Number);
  const interval = new RegExp(`<integer>${hour}<\\/integer>[\\s\\S]*?<integer>${minute}<\\/integer>`);
  assert.match(template, interval, `LaunchAgent should include ${time}`);
}
assert.match(template, /tzzb-scheduled-capture\.command/, 'LaunchAgent should run the catch-up guard instead of the interactive launcher directly');
assert.match(template, /__LAUNCH_PROJECT_DIR__\/tools\/tzzb-scheduled-capture\.command/, 'capture LaunchAgent should execute through an ASCII-only stable project path');
assert.match(helperTemplate, /<string>__LAUNCH_HELPER__<\/string>/, 'helper LaunchAgent should execute through an ASCII-only stable script path');
assert.doesNotMatch(template, /__PROJECT_DIR__\/tools\/tzzb-scheduled-capture\.command/, 'capture LaunchAgent must not execute from a possibly non-ASCII project path');
assert.doesNotMatch(helperTemplate, /启动复盘助手\.command/, 'helper LaunchAgent must not receive a non-ASCII script filename');
assert.match(runner, /tzzb-review-schedule\.mjs/, 'scheduled runner should delegate due-slot decisions to the tested module');
assert.match(scheduleSource, /launch-helper\.command/, 'runtime scheduler should prefer the ASCII-only copied launcher');
assert.match(helperTemplate, /<key>RunAtLoad<\/key>\s*<true\/>/, 'helper daemon must start at login independently of capture-slot deduplication');
assert.match(helperTemplate, /<key>KeepAlive<\/key>\s*<true\/>/, 'launchd must restart the local helper if it exits');
assert.match(helperTemplate, /--daemon/, 'the helper LaunchAgent should use the non-interactive daemon launcher mode');
assert.doesNotMatch(runner, /REVIEW_URL|chatgpt\.site|127\.0\.0\.1:8787\//, 'capture scheduling must not open any review page');
assert.doesNotMatch(scheduleSource, /getUTCDay|isWeekday|previousWeekday/, 'scheduler must not treat weekdays as an exchange calendar');

console.log('PASS tzzb schedule');
