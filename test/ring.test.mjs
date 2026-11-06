import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Readable} from 'node:stream';
import {Store} from '../src/store.mjs';
import {Transport} from '../src/transport.mjs';
import {Provider} from '../src/provider.mjs';
import {serve} from '../src/service.mjs';
import {main} from '../src/cli.mjs';
import {fail} from '../src/errors.mjs';
import {config, ringInput} from '../src/validation.mjs';

const NOW = Date.parse('2026-11-06T12:00:00.000Z');
const accountSid = `AC${'1'.repeat(32)}`, sender = '+15551230001', other = '+15551230003', remote = '+15551230002';
const startAt = '2026-11-01T00:00:00.000Z';
const connection = config({accountSid, authToken: '2'.repeat(32), sender, startAt}, NOW);
const multi = config({accountSid, authToken: '2'.repeat(32), senders: [sender, other], startAt}, NOW);
const callSid = n => `CA${String(n).padStart(32, '0')}`;
const rfc = ms => new Date(ms).toUTCString().replace('GMT', '+0000');

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ez-twilio-ring-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const store = new Store(directory); store.binding(connection);
  t.after(() => { try { store.close(); } catch {} });
  return {store, directory};
}

// A synthetic provider for rings: `status` is what Twilio says of every call when read back.
function mock() {
  const created = [], reads = [];
  const provider = {
    created, reads, status: 'ringing', duration: null,
    listPath: () => '/none',
    async page() { return {messages: [], next: null}; },
    async createCall(payload) {
      created.push(payload);
      return {sid: callSid(created.length), account_sid: accountSid, status: 'queued'};
    },
    async getCall(sid) {
      reads.push(sid);
      return {sid, account_sid: accountSid, status: provider.status, duration: provider.duration};
    },
    async doctor() { return {accountSid, sender, sms: true, voice: true}; },
  };
  return provider;
}

test('a ring places one call, kept by its key through a restart and a changed payload is refused', async t => {
  const {store, directory} = await fixture(t), provider = mock();
  let release; const original = provider.createCall;
  provider.createCall = async payload => { await new Promise(resolve => { release = resolve; }); return original(payload); };
  const transport = new Transport(store, connection, {provider, now: () => NOW});
  const first = transport.ring({to: remote, key: 'q:1:ring', seconds: 8});
  assert.equal((await transport.ring({to: remote, key: 'q:1:ring', seconds: 8})).state, 'uncertain');
  release(); const accepted = await first;
  assert.equal(accepted.state, 'accepted'); assert.equal(accepted.providerCallId, callSid(1));
  assert.equal(accepted.createdAt, new Date(NOW).toISOString());
  assert.deepEqual(provider.created, [{kind: 'ring', key: 'q:1:ring', accountSid, from: sender, to: remote, seconds: 8}]);
  await assert.rejects(transport.ring({to: remote, key: 'q:1:ring', seconds: 12}), /different payload/);
  await assert.rejects(transport.send({to: remote, text: 'A text', key: 'q:1:ring'}), /different payload/);
  store.close(); const reopened = new Store(directory); t.after(() => reopened.close());
  const replay = await new Transport(reopened, connection, {provider, now: () => NOW}).ring({to: remote, key: 'q:1:ring', seconds: 8});
  assert.equal(replay.providerCallId, callSid(1)); assert.equal(provider.created.length, 1);
});

test('a ring preview creates nothing and the input is bounded', async t => {
  const {store} = await fixture(t), provider = mock();
  const transport = new Transport(store, connection, {provider, now: () => NOW});
  const preview = await transport.ring({to: remote, key: 'p:1', preview: true});
  assert.equal(preview.preview, true); assert.equal(preview.payload.seconds, 10);
  assert.equal(provider.created.length, 0); assert.equal(store.operation('p:1'), null);
  assert.throws(() => ringInput({to: remote, key: 'p:2', seconds: 4}, connection), /ring seconds/);
  assert.throws(() => ringInput({to: remote, key: 'p:2', seconds: 61}, connection), /ring seconds/);
  assert.throws(() => ringInput({to: sender, key: 'p:2'}, connection), /differ from the selected sender/);
  assert.throws(() => ringInput({to: remote, key: 'p:2'}, multi), /Select a configured sender/);
  assert.equal(ringInput({from: other, to: remote, key: 'p:2'}, multi).from, other);
});

test('a lost create response stays uncertain and is never submitted again', async t => {
  const {store} = await fixture(t), provider = mock();
  provider.createCall = async payload => { provider.created.push(payload); throw fail('PROVIDER_UNAVAILABLE', 'Response lost', 5); };
  const transport = new Transport(store, connection, {provider, now: () => NOW});
  const ring = {to: remote, key: 'lost:ring'};
  assert.equal((await transport.ring(ring)).state, 'uncertain');
  assert.equal((await transport.ring(ring)).state, 'uncertain'); assert.equal(provider.created.length, 1);
});

test('a definitive provider refusal is a retained rejection', async t => {
  const {store} = await fixture(t), provider = mock();
  provider.createCall = async () => { throw fail('PROVIDER_HTTP', 'Twilio returned HTTP 400', 2, {httpStatus: 400, providerCode: 21214, definitive: true}); };
  const transport = new Transport(store, connection, {provider, now: () => NOW});
  const rejected = await transport.ring({to: remote, key: 'rej:ring'});
  assert.equal(rejected.state, 'rejected'); assert.equal(rejected.error.providerCode, 21214);
  assert.equal(store.operation('rej:ring').state, 'rejected');
});

test('polling reads a ring back until Twilio reports it finished, and leaves it then', async t => {
  const {store} = await fixture(t), provider = mock();
  const transport = new Transport(store, connection, {provider, now: () => NOW});
  await transport.ring({to: remote, key: 'poll:ring'});
  await transport.sync();
  assert.equal(store.operation('poll:ring').state, 'accepted'); assert.equal(store.operation('poll:ring').providerStatus, 'ringing');
  provider.status = 'no-answer'; provider.duration = '0';
  await transport.sync();
  const settled = store.operation('poll:ring');
  assert.equal(settled.state, 'settled'); assert.equal(settled.providerStatus, 'no-answer'); assert.equal(settled.durationSeconds, 0);
  const reads = provider.reads.length; await transport.sync();
  assert.equal(provider.reads.length, reads);
  assert.equal(store.status().operations.settled, 1);
});

test('HTTP provider creates a ring with a timeout and an inline hang-up, and reads the call back', async () => {
  const seen = [];
  const provider = new Provider(connection, {fetch: async (url, options) => {
    seen.push({url: new URL(url), options});
    return Response.json({sid: callSid(7), account_sid: accountSid, status: 'queued'});
  }});
  const payload = ringInput({to: remote, key: 'http:ring', seconds: 9}, connection);
  assert.equal((await provider.createCall(payload)).sid, callSid(7));
  const {url, options} = seen[0];
  assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
  assert.equal(url.pathname, `/2010-04-01/Accounts/${accountSid}/Calls.json`);
  const form = new URLSearchParams(options.body);
  assert.deepEqual([...form.keys()].sort(), ['From', 'Timeout', 'To', 'Twiml']);
  assert.equal(form.get('From'), sender); assert.equal(form.get('To'), remote); assert.equal(form.get('Timeout'), '9');
  assert.equal(form.get('Twiml'), '<Response><Hangup/></Response>');
  await provider.getCall(callSid(7));
  assert.equal(seen[1].url.pathname, `/2010-04-01/Accounts/${accountSid}/Calls/${callSid(7)}.json`);
  assert.equal(seen[1].options.method, 'GET');
  await assert.rejects(provider.getCall('SM1'), /Invalid Call SID/);
});

test('doctor reports whether every number can place a ring without failing the SMS checks', async () => {
  const numbers = {[sender]: {sms: true, voice: true}, [other]: {sms: true}};
  const provider = new Provider(multi, {fetch: async url => {
    const from = new URL(url).searchParams.get('PhoneNumber');
    return Response.json({incoming_phone_numbers: [{account_sid: accountSid, phone_number: from, capabilities: numbers[from]}]});
  }});
  const report = await provider.doctor();
  assert.equal(report.sms, true); assert.equal(report.voice, false);
});

test('the service places a ring over its socket, names it in the calls read and ends it with the CLI exit codes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ez-twilio-ring-svc-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const socketPath = join(directory, 'service.sock'), provider = mock();
  const startMs = NOW - 20000;
  provider.callsPath = (direction, from, to, number) => `/2010-04-01/Accounts/${accountSid}/Calls.json?${new URLSearchParams({[direction === 'inbound' ? 'To' : 'From']: number, 'StartTime>=': from, 'StartTime<=': to})}`;
  provider.page = async (path, resource, field) => {
    if (resource !== 'Calls') return {messages: [], next: null};
    const outbound = new URL(path, 'https://api.twilio.com').searchParams.has('From');
    const rows = outbound ? [
      {sid: callSid(1), account_sid: accountSid, from: sender, to: remote, direction: 'outbound-api', status: 'no-answer', parent_call_sid: null,
        start_time: rfc(startMs), end_time: rfc(startMs + 11000), duration: '0', answered_by: null},
      {sid: callSid(9), account_sid: accountSid, from: sender, to: remote, direction: 'outbound-api', status: 'completed', parent_call_sid: null,
        start_time: rfc(startMs - 5000), end_time: rfc(startMs), duration: '30', answered_by: null},
    ] : [];
    return {[field]: rows, next: null};
  };
  const running = await serve({directory, socketPath, provider: () => provider, now: () => NOW}); t.after(() => running.close());
  const cli = (args, stdin) => main(args, {socketPath, stdin: Readable.from([JSON.stringify(stdin ?? {})])});
  await cli(['init'], {accountSid, authToken: '2'.repeat(32), sender, startAt});
  const ring = await cli(['ring', '--to', remote, '--key', 'svc:ring', '--seconds', '8']);
  assert.equal(ring.state, 'accepted'); assert.equal(ring.providerCallId, callSid(1));
  const listed = await cli(['calls', '--after', '2026-11-06T00:00:00Z']);
  const byId = Object.fromEntries(listed.calls.map(call => [call.sid, call.operation]));
  assert.deepEqual(byId, {[callSid(1)]: 'svc:ring', [callSid(9)]: null});
  assert.equal((await cli(['operation', '--key', 'svc:ring'])).providerCallId, callSid(1));
  provider.createCall = async () => { throw fail('PROVIDER_UNAVAILABLE', 'lost', 5); };
  await assert.rejects(cli(['ring', '--to', remote, '--key', 'svc:lost']), error => error.code === 'UNCERTAIN_RING' && error.exitCode === 5);
  provider.createCall = async () => { throw fail('PROVIDER_HTTP', 'bad', 2, {httpStatus: 400, definitive: true}); };
  await assert.rejects(cli(['ring', '--to', remote, '--key', 'svc:bad']), error => error.code === 'RING_REJECTED' && error.exitCode === 4);
  const help = await main(['--help'], {socketPath});
  assert.ok(help.commands.some(line => line.startsWith('ring ')));
});
