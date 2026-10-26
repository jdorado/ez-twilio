import {createHash} from 'node:crypto';
import {fail} from './errors.mjs';
import {integer, phone, sid, senders, timestamp} from './validation.mjs';

// Bounded, read-only pass-through of Twilio calls and recordings. Nothing is journaled.
const DAY = 86400000, PAGES = 5, MAX_RECORDING = 2.5 * 1024 * 1024;
const INBOUND = new Set(['inbound', 'trunking-terminating']);
const day = millis => new Date(millis).toISOString().slice(0, 10);
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const invalid = what => fail('PROVIDER_RESPONSE', `Invalid ${what} fields`);
const orMissing = async work => {
  try { return await work; } catch (error) { throw error?.details?.httpStatus === 404 ? fail('NOT_FOUND', 'Call or recording not found') : error; }
};

function number(value, what) { try { return phone(value); } catch { throw invalid(what); } }
function time(value, what, required = false) {
  if (value === null || value === undefined) { if (required) throw invalid(what); return null; }
  if (typeof value !== 'string' || !/^[A-Za-z0-9 ,:.+-]{10,40}$/.test(value) || !Number.isFinite(Date.parse(value))) throw invalid(what);
  return new Date(value).toISOString();
}
function seconds(value, what) {
  if (value === null || value === undefined) return null;
  if (!/^\d{1,9}$/.test(String(value))) throw invalid(what);
  return Number(value);
}

// Returns null for parent-leg look-alikes the stream must not report: child legs,
// the other direction's copy of a call between two owned lines, and calls not yet dialed.
function call(raw, connection, line, inbound) {
  if (!raw || typeof raw !== 'object' || !sid(raw.sid, 'CA') || raw.account_sid !== connection.accountSid ||
      typeof raw.direction !== 'string' || !/^[a-z]{1,16}(?:-[a-z]{1,16}){0,2}$/.test(raw.direction)) throw invalid('call identity');
  if (raw.parent_call_sid || INBOUND.has(raw.direction) !== inbound) return null;
  const from = number(raw.from, 'call'), to = number(raw.to, 'call');
  if ((inbound ? to : from) !== line) throw fail('PROVIDER_RESPONSE', 'Call is outside the configured numbers');
  const startTime = time(raw.start_time, 'call');
  if (!startTime) return null;
  if (typeof raw.status !== 'string' || !/^[a-z][a-z-]{0,31}$/.test(raw.status) ||
      !(raw.answered_by === null || raw.answered_by === undefined || typeof raw.answered_by === 'string' && /^[a-z_]{1,32}$/.test(raw.answered_by))) throw invalid('call');
  return {sid: raw.sid, accountSid: raw.account_sid, from, to, direction: raw.direction, status: raw.status, startTime,
    endTime: time(raw.end_time, 'call'), durationSeconds: seconds(raw.duration, 'call'), answeredBy: raw.answered_by ?? null};
}

// Every number in both directions over whole UTC days [lo, hi]; a stream over the page bound is reported, not truncated.
async function read(provider, connection, after, lo, hi) {
  const rows = [];
  for (const line of senders(connection)) for (const inbound of [true, false]) {
    let path = provider.callsPath(inbound ? 'inbound' : 'outbound', day(lo), day(hi), line);
    for (let pages = 1; ; pages++) {
      const page = await provider.page(path, 'Calls', 'calls');
      for (const raw of page.calls) {
        const row = call(raw, connection, line, inbound);
        const start = row && Date.parse(row.startTime);
        if (row && start >= Date.parse(after) && start < hi + DAY) rows.push(row);
      }
      if (!page.next) break;
      if (page.next === path) throw fail('PROVIDER_RESPONSE', 'Provider pagination did not advance');
      if (pages === PAGES) return {truncated: true};
      path = page.next;
    }
  }
  return {rows};
}

export async function calls(provider, connection, args, now) {
  const after = timestamp(args.after), limit = integer(args.limit ?? 50, 1, 100, 'limit');
  // Twilio lists newest first, so a page cap alone would drop the oldest calls and the caller
  // would skip them. Read whole UTC days oldest first and halve the window toward `after`
  // when a stream exceeds the bound: the result is always a contiguous ascending prefix.
  const end = Math.floor(now / DAY) * DAY, found = new Map();
  let lo = Math.floor(Date.parse(after) / DAY) * DAY, hi = end;
  while (lo <= end) {
    const window = await read(provider, connection, after, lo, hi);
    if (window.truncated) {
      if (lo === hi) throw fail('PROVIDER_RESPONSE', 'One UTC day holds more calls than a read can bound');
      hi = lo + Math.floor((hi - lo) / DAY / 2) * DAY;
      continue;
    }
    for (const row of window.rows) found.set(row.sid, row);
    if (hi === end || found.size >= limit) break;
    lo = hi + DAY; hi = end;
  }
  const rows = [...found.values()].sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime) || (a.sid < b.sid ? -1 : 1));
  return {calls: rows.slice(0, limit), complete: hi === end && rows.length <= limit};
}

function recording(raw, connection) {
  if (!raw || typeof raw !== 'object' || !sid(raw.sid, 'RE') || !sid(raw.call_sid, 'CA') || raw.account_sid !== connection.accountSid) throw invalid('recording identity');
  if (typeof raw.status !== 'string' || !/^[a-z][a-z-]{0,31}$/.test(raw.status) || ![1, 2].includes(raw.channels) ||
      typeof raw.source !== 'string' || !/^[A-Za-z]{1,64}$/.test(raw.source)) throw invalid('recording');
  return {sid: raw.sid, callSid: raw.call_sid, status: raw.status, durationSeconds: seconds(raw.duration, 'recording'), channels: raw.channels,
    source: raw.source, createdAt: time(raw.date_created, 'recording', true), mediaFormats: ['mp3', 'wav']};
}

export async function recordings(provider, connection, args) {
  if (!sid(args.call, 'CA')) throw fail('INVALID_INPUT', 'Invalid Call SID');
  const page = await orMissing(provider.page(`${provider.root}/Calls/${args.call}/Recordings.json?PageSize=100`, `Calls/${args.call}/Recordings`, 'recordings'));
  if (page.next) throw fail('PROVIDER_RESPONSE', 'Call has more recordings than a read can bound');
  const rows = page.recordings.map(raw => recording(raw, connection));
  if (rows.some(row => !same(row.callSid, args.call))) throw fail('PROVIDER_RESPONSE', 'Recording belongs to another call');
  return {recordings: rows};
}

export async function recordingMedia(provider, connection, args) {
  const format = args.format ?? 'mp3';
  if (!sid(args.sid, 'RE')) throw fail('INVALID_INPUT', 'Invalid Recording SID');
  if (!['mp3', 'wav'].includes(format)) throw fail('INVALID_INPUT', 'Use mp3 or wav');
  // Other states can hold partial or no media: fetch only after the resource says completed.
  const row = recording(await orMissing(provider.request(`${provider.root}/Recordings/${args.sid}.json`)), connection);
  if (!same(row.sid, args.sid)) throw fail('PROVIDER_RESPONSE', 'Recording readback returned another SID');
  if (row.status !== 'completed') throw fail('RECORDING_NOT_COMPLETED', 'Only a completed recording can be fetched', 4, {status: row.status});
  const {contentType, bytes} = await orMissing(provider.media(`${provider.root}/Recordings/${args.sid}.${format}`, MAX_RECORDING));
  if (!bytes.length) throw fail('PROVIDER_RESPONSE', 'Provider returned empty recording media');
  return {sid: row.sid, format, contentType, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), data: bytes.toString('base64')};
}

// Read access only: a bounded list per resource. A denied key reports false and never fails SMS diagnostics.
export async function readable(provider) {
  try {
    await provider.page(`${provider.root}/Calls.json?PageSize=1`, 'Calls', 'calls');
    await provider.page(`${provider.root}/Recordings.json?PageSize=1`, 'Recordings', 'recordings');
    return true;
  } catch { return false; }
}
