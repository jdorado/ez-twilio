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
    'message get MESSAGE_SID', 'send --to E164 --text TEXT --key KEY [--preview]', 'operation --key KEY',
    'backup', 'recovery acknowledge --reference OWNER_RECONCILIATION',
  ], configuration: {required: ['accountSid','sender'], credentials: 'apiKeySid + apiKeySecret, or authToken; stdin only', optional: ['messagingServiceSid','startAt','pollSeconds']},
    transport: 'One managed Docker service polls independently. No webhooks. Keep the operation key after uncertainty; never retry with a new key.',
    exitCodes: {0:'ok',1:'internal',2:'invalid input or provider error',3:'auth/account',4:'refused',5:'uncertain send/service response'}};
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
  else if (command === 'send') values = flags(rest, {to:'string',text:'string',key:'string',preview:'boolean'});
  else if (command === 'operation') values = flags(rest,{key:'string'});
  else if (command === 'acknowledge') values = flags(rest,{consumer:'string',cursor:'number',generation:'string'});
  else if (command === 'recovery' && rest[0] === 'acknowledge') { name = 'recovery-acknowledge'; values = flags(rest.slice(1),{reference:'string'}); }
  else throw fail('INVALID_INPUT','Invalid command; read --help');
  const result = await client(socketPath,name,values);
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
    else { if (++i >= args.length) throw fail('INVALID_INPUT','Argument value missing'); result[name] = spec[name] === 'number' ? Number(args[i]) : args[i]; }
  }
  return result;
}
async function stdinJSON(stream) {
  let text = '';
  for await (const chunk of stream) { text += chunk; if (Buffer.byteLength(text)>65536) throw fail('INVALID_INPUT','Configuration exceeds size limit'); }
  try { return JSON.parse(text); } catch { throw fail('INVALID_INPUT','Expected private configuration JSON on stdin'); }
}
