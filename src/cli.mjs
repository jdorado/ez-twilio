import {readFile} from 'node:fs/promises';
import {client} from './client.mjs';
import {serve} from './service.mjs';
import {fail} from './errors.mjs';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url),'utf8'));
export async function main(argv, options = {}) {
  const args = [...argv];
  let socketPath = options.socketPath ?? '/plugins/twilio/service.sock';
  const socketIndex = args.indexOf('--socket');
  if (socketIndex !== -1) { socketPath = args[socketIndex+1]; if (!socketPath?.startsWith('/')) throw fail('INVALID_INPUT','Use an absolute socket path'); args.splice(socketIndex,2); }
  const jsonIndex = args.indexOf('--json'); if (jsonIndex !== -1) args.splice(jsonIndex,1);
  const [command, ...rest] = args;
  if (!command || command === '--help') return {commands: [
    'init < private-connection.json', 'doctor', 'status', 'sync [--max-pages 1..200]',
    'inbox [--after CURSOR --generation STORE_GENERATION] [--limit 1..100]', 'acknowledge --consumer NAME --cursor CURSOR --generation ID',
    'message get MESSAGE_SID', 'calls --after ISO_TIMESTAMP [--limit 1..100]', 'recordings --call CALL_SID', 'recording --sid RECORDING_SID [--format mp3|wav]', 'send [--from OUR_E164] --to E164 --text TEXT --key KEY [--preview]', 'ring [--from OUR_E164] --to E164 --key KEY [--seconds 5..60] [--preview]', 'operation --key KEY',
    'backup', 'recovery acknowledge --reference OWNER_RECONCILIATION',
  ], configuration: {required: ['accountSid','sender or senders[]'], credentials: 'apiKeySid + apiKeySecret, or authToken; stdin only', optional: ['messagingServiceSid','startAt','pollSeconds'], senders: 'Multiple configured numbers share one poller. Select --from when more than one is configured; selection policy belongs to the caller.'},
    ring: 'A missed call: one call from our number that Twilio itself ends after --seconds (default 10) of ringing, or at once if answered; no audio, no webhook. Returns the operation {key,state,providerCallId,providerStatus}: state accepted while it is in progress, settled when it ended as no-answer, busy or completed, failed when Twilio reports failed or canceled (it never rang), always with providerStatus. Same key, same call: a repeat reads the kept operation. The call reaches the mailbox only if the carrier answers before --seconds; keep it well under the carrier mailbox delay (about 20 seconds).',
    reads: {calls: 'Parent call legs on configured numbers with startTime >= --after (UTC ISO; inclusive), oldest first, --limit default 50: {calls:[{sid,accountSid,from,to,direction,status,startTime,endTime,durationSeconds,answeredBy,errorCode,operation}],complete}; errorCode is why Twilio failed a call (status failed: it never rang), the code of its first error-level notification, else of its first notification (e.g. 13224 invalid number, 32009 carrier refused), else null (also null when Twilio refuses the lookup, which never fails the read); from/to of the other party is the value Twilio reports, printable ASCII cut to 64 characters, unknown when absent; operation is the key of the ring this plugin placed as that call, else null. complete is false when --limit cut the list.',
      recordings: 'Recordings of one call: {recordings:[{sid,callSid,status,durationSeconds,channels,source,createdAt,mediaFormats}]}.',
      recording: 'Media of a completed recording: {sid,format,contentType,bytes,sha256,data}; data is base64. Above 2621440 bytes (2.5 MiB) it fails RECORDING_TOO_LARGE; a recording that is not completed fails RECORDING_NOT_COMPLETED.',
      scope: 'Bounded, read-only pass-through of Twilio-retained data: not journaled, no webhooks, no writes. A call or recording Twilio does not find is NOT_FOUND.'},
    transport: 'One managed Docker service polls independently. No webhooks. Keep the operation key after uncertainty; never retry with a new key.',
    exitCodes: {0:'ok',1:'internal',2:'invalid input or provider error',3:'auth/account',4:'refused',5:'uncertain send or ring/service response'}};
  if (command === '--version' && !rest.length) return {version: pkg.version};
  if (command === 'serve' && !rest.length) {
    if (!options.allowServe && process.env.EZ_TWILIO_SERVICE !== '1') throw fail('INVALID_INPUT','Start the registered container with ez plugins start twilio');
    const running = await serve({...options, socketPath});
    if (options.allowServe) return running;
    for (const signal of ['SIGTERM','SIGINT']) process.once(signal, () => void running.close().then(() => process.exit(0)));
    return undefined;
  }
  let name = command, values = {};
  if (command === 'init' && !rest.length) values.configuration = await stdinJSON(options.stdin ?? process.stdin);
  else if (['doctor','status','health','backup'].includes(command) && !rest.length) {}
  else if (command === 'message' && rest[0] === 'get' && rest.length === 2) values.id = rest[1];
  else if (command === 'inbox') values = flags(rest, {after:'number',limit:'number',generation:'string'});
  else if (command === 'sync') { const parsed = flags(rest, {'max-pages':'number'}); values = {maxPages: parsed['max-pages']}; }
  else if (command === 'send') values = flags(rest, {from:'string',to:'string',text:'string',key:'string',preview:'boolean'});
  else if (command === 'ring') values = flags(rest, {from:'string',to:'string',key:'string',seconds:'number',preview:'boolean'});
  else if (command === 'calls') values = flags(rest,{after:'string',limit:'number'});
  else if (command === 'recordings') values = flags(rest,{call:'string'});
  else if (command === 'recording') values = flags(rest,{sid:'string',format:'string'});
  else if (command === 'operation') values = flags(rest,{key:'string'});
  else if (command === 'acknowledge') values = flags(rest,{consumer:'string',cursor:'number',generation:'string'});
  else if (command === 'recovery' && rest[0] === 'acknowledge') { name = 'recovery-acknowledge'; values = flags(rest.slice(1),{reference:'string'}); }
  else throw fail('INVALID_INPUT','Invalid command; read --help');
  const result = await client(socketPath,name,values);
  if (command === 'ring' && result.state === 'uncertain') throw fail('UNCERTAIN_RING','Ring outcome is uncertain; inspect operation with the same key',5,{key:result.key,providerCallId:result.providerCallId});
  if (command === 'ring' && result.state === 'rejected') throw fail('RING_REJECTED','Provider rejected this operation; inspect its receipt',4,{key:result.key,reason:result.error?.code,...(result.error?.httpStatus ? {httpStatus:result.error.httpStatus} : {}),...(result.error?.providerCode ? {providerCode:result.error.providerCode} : {})});
  if (command === 'send' && result.state === 'uncertain') throw fail('UNCERTAIN_SEND','Send outcome is uncertain; inspect operation with the same key',5,{key:result.key,providerMessageId:result.providerMessageId});
  if (command === 'send' && result.state === 'rejected') throw fail('SEND_REJECTED','Provider rejected this operation; inspect its receipt',4,{key:result.key,...result.error});
  return result;
}
function flags(args, spec) {
  const result = {};
  for (let i=0;i<args.length;i++) {
    const name = args[i].startsWith('--') ? args[i].slice(2) : '';
    if (!spec[name] || result[name] !== undefined) throw fail('INVALID_INPUT','Unknown or repeated argument');
    if (spec[name] === 'boolean') result[name] = true;
    else {
      if (++i >= args.length) throw fail('INVALID_INPUT','Argument value missing');
      // A malformed number would reach the service as JSON null, which a default (`??`) turns into a real value.
      // Every numeric flag is a whole number of digits (a cursor, a limit, a page bound, seconds).
      if (spec[name] === 'number' && !/^\d{1,15}$/.test(args[i])) throw fail('INVALID_INPUT','Use a non-negative whole number');
      result[name] = spec[name] === 'number' ? Number(args[i]) : args[i];
    }
  }
  return result;
}
async function stdinJSON(stream) {
  let text = '';
  for await (const chunk of stream) { text += chunk; if (Buffer.byteLength(text)>65536) throw fail('INVALID_INPUT','Configuration exceeds size limit'); }
  try { return JSON.parse(text); } catch { throw fail('INVALID_INPUT','Expected private configuration JSON on stdin'); }
}
