import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const CAPTURE_TIMES = Object.freeze([
  '15:35',
  '15:40',
  '15:50',
  '16:10',
  '16:30',
  '17:00',
  '17:30',
  '18:00',
  '18:30',
  '19:00',
  '19:30',
  '20:00',
  '20:30',
  '21:00',
  '21:30',
  '22:00',
  '22:30',
  '23:00',
  '23:30'
]);

const modulePath = fileURLToPath(import.meta.url);
const projectDir = path.dirname(path.dirname(modulePath));
const defaultStateFile = path.join(projectDir, 'data', 'tzzb', 'review-schedule-state.json');
const defaultCloudStatusFile = path.join(projectDir, 'data', 'tzzb', 'cloud-sync-status.json');
const defaultLatestCaptureFile = path.join(projectDir, 'data', 'tzzb', 'latest-capture.json');
const defaultAccumulatorFile = path.join(projectDir, 'data', 'tzzb', 'normalized-evidence-accumulator.json');

function timeMinutes(value) {
  const [hour, minute] = String(value || '').split(':').map(Number);
  return Number.isInteger(hour) && Number.isInteger(minute) ? hour * 60 + minute : -1;
}

function shanghaiClock(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${fields.year}-${fields.month}-${fields.day}`,
    minutes: Number(fields.hour) * 60 + Number(fields.minute)
  };
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function compactDate(value) {
  const text = String(value || '');
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  return validDate(text) ? text : '';
}

function observedDate(systemTime, capturedAt) {
  let timestamp = Number(systemTime);
  if (Number.isFinite(timestamp) && timestamp > 0 && timestamp < 1e12) timestamp *= 1000;
  const clock = shanghaiClock(Number.isFinite(timestamp) && timestamp > 0 ? timestamp : capturedAt);
  return clock?.date || '';
}

function calendarCandidate({ payload, capturedAt }) {
  if (!payload || typeof payload !== 'object' || typeof payload.isTradingDay !== 'boolean') return null;
  const lastTradingDay = compactDate(payload.lastTradingDay);
  const previousTradingDay = compactDate(payload.previousTradingDay);
  const date = observedDate(payload.systemTime, capturedAt);
  if (!validDate(date) || !validDate(lastTradingDay) || !validDate(previousTradingDay)) return null;
  if (previousTradingDay >= lastTradingDay || lastTradingDay > date) return null;
  return {
    observedDate: date,
    isTradingDay: payload.isTradingDay,
    lastTradingDay,
    previousTradingDay,
    capturedAt: String(capturedAt || '')
  };
}

function normalizedCalendarRecords(state) {
  const records = [];
  for (const bucket of Object.values(state?.buckets || {})) {
    for (const record of bucket?.evidence?.records || []) {
      if (record?.endpoint === 'last_trading_day') records.push(record);
    }
  }
  return records.map((record) => calendarCandidate({ payload: record.payload, capturedAt: record.capturedAt })).filter(Boolean);
}

function rawCalendarRecords(capture) {
  const candidates = [];
  for (const record of capture?.records || []) {
    if (!String(record?.url || '').split('?')[0].replace(/\/$/, '').endsWith('/last_trading_day')) continue;
    const status = Number(record.status);
    if (!Number.isInteger(status) || status < 200 || status >= 300) continue;
    let data = record.data;
    if (!data || typeof data !== 'object') {
      try {
        data = JSON.parse(String(record.responseText || ''));
      } catch {
        continue;
      }
    }
    if (String(data?.error_code ?? '') !== '0' || !data?.ex_data) continue;
    const flag = data.ex_data.is_trading_day;
    const candidate = calendarCandidate({
      capturedAt: record.capturedAt,
      payload: {
        isTradingDay: flag === true || flag === 1 || flag === '1'
          ? true
          : (flag === false || flag === 0 || flag === '0' ? false : null),
        lastTradingDay: data.ex_data.last_trading_day,
        previousTradingDay: data.ex_data.prev_trading_day,
        systemTime: data.ex_data.system_time
      }
    });
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export function readTradingCalendarState({
  accumulatorFile = process.env.TZZB_EVIDENCE_ACCUMULATOR_FILE || defaultAccumulatorFile,
  latestCaptureFile = process.env.TZZB_LATEST_CAPTURE_FILE || defaultLatestCaptureFile
} = {}) {
  const candidates = [
    ...normalizedCalendarRecords(readJson(accumulatorFile)),
    ...rawCalendarRecords(readJson(latestCaptureFile))
  ];
  candidates.sort((left, right) => {
    const leftTime = new Date(left.capturedAt || `${left.observedDate}T00:00:00+08:00`).getTime();
    const rightTime = new Date(right.capturedAt || `${right.observedDate}T00:00:00+08:00`).getTime();
    return leftTime - rightTime;
  });
  return candidates.at(-1) || null;
}

function slot(date, time) {
  return { date, time, key: `${date}T${time}` };
}

export function latestDueSlot(value = new Date(), calendar = null) {
  const clock = shanghaiClock(value);
  if (
    !clock
    || !calendar
    || !validDate(calendar.observedDate)
    || typeof calendar.isTradingDay !== 'boolean'
    || calendar.observedDate > clock.date
  ) return null;

  if (
    calendar.observedDate === clock.date
    && calendar.isTradingDay === true
    && calendar.lastTradingDay === clock.date
  ) {
    const dueToday = [...CAPTURE_TIMES]
      .reverse()
      .find((time) => timeMinutes(time) <= clock.minutes);
    if (dueToday) return slot(clock.date, dueToday);
    return validDate(calendar.previousTradingDay)
      ? slot(calendar.previousTradingDay, CAPTURE_TIMES[CAPTURE_TIMES.length - 1])
      : null;
  }

  return validDate(calendar.lastTradingDay) && calendar.lastTradingDay <= clock.date
    ? slot(calendar.lastTradingDay, CAPTURE_TIMES[CAPTURE_TIMES.length - 1])
    : null;
}

export function calendarRefreshSlot(value = new Date(), calendar = null) {
  const clock = shanghaiClock(value);
  if (!clock) return null;
  if (calendar && validDate(calendar.observedDate) && calendar.observedDate >= clock.date) return null;
  const dueTime = [...CAPTURE_TIMES]
    .reverse()
    .find((time) => timeMinutes(time) <= clock.minutes);
  const retryKey = dueTime || 'startup';
  return {
    date: clock.date,
    time: `calendar-refresh-${retryKey}`,
    key: `${clock.date}Tcalendar-refresh-${retryKey}`,
    calendarRefresh: true
  };
}

export function shouldRunSlot(lastSlotKey, dueSlot) {
  return Boolean(dueSlot && dueSlot.key && String(lastSlotKey || '') !== dueSlot.key);
}

export function isSlotVerified(dueSlot, cloudStatus) {
  return Boolean(
    dueSlot?.date
    && cloudStatus?.state === 'verified'
    && String(cloudStatus.reviewDate || cloudStatus.captureDate || '') === dueSlot.date
  );
}

function readState(stateFile) {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(stateFile, state) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const temporary = `${stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, stateFile);
}

export function markCurrentSlot({
  now = new Date(),
  stateFile = process.env.TZZB_SCHEDULE_STATE_FILE || defaultStateFile,
  calendar = readTradingCalendarState()
} = {}) {
  const dueSlot = latestDueSlot(now, calendar);
  if (!dueSlot) return null;
  writeState(stateFile, {
    lastSlotKey: dueSlot.key,
    handledAt: new Date().toISOString()
  });
  return dueSlot;
}

export function runDueCapture({
  now = new Date(),
  stateFile = process.env.TZZB_SCHEDULE_STATE_FILE || defaultStateFile,
  cloudStatusFile = process.env.TZZB_CLOUD_STATUS_FILE || defaultCloudStatusFile,
  calendar = readTradingCalendarState(),
  launcher = path.join(projectDir, '启动复盘助手.command')
} = {}) {
  const dueSlot = latestDueSlot(now, calendar) || calendarRefreshSlot(now, calendar);
  const state = readState(stateFile);
  const cloudStatus = readState(cloudStatusFile);
  if (isSlotVerified(dueSlot, cloudStatus)) {
    return { launched: false, dueSlot, verified: true };
  }
  if (!shouldRunSlot(state.lastSlotKey, dueSlot)) {
    return { launched: false, dueSlot };
  }

  const child = spawn('/bin/zsh', [launcher, '--scheduled', dueSlot.key], {
    cwd: projectDir,
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
  writeState(stateFile, {
    lastSlotKey: dueSlot.key,
    launchedAt: new Date().toISOString()
  });
  return { launched: true, dueSlot };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(modulePath)) {
  if (process.argv.includes('--mark-current')) {
    markCurrentSlot();
  } else {
    const result = runDueCapture();
    if (result.launched) {
      console.log(`Started scheduled capture for ${result.dueSlot.key}`);
    }
  }
}
