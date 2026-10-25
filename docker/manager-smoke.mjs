import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';

const core=process.env.EZ_CORE_SOURCE;
if(!core)throw Error('Set EZ_CORE_SOURCE to the reviewed Ez core checkout');
const {snapshot,init}=await import(pathToFileURL(join(resolve(core),'src/plugins/manager.mjs')).href);
const root=await mkdtemp(join(tmpdir(),'ez-twilio-manager-'));
const source=join(root,'source'),home=join(root,'tools'),mind=join(root,'mind');
const execute=promisify(execFile),cli=join(resolve(core),'bin/ezenciel-agents-tools.mjs');
let record;
async function call(args,input) {
 return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[cli,'--home',home,...args],{stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
  child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('error',reject);
  child.on('close',code=>{if(code!==0)return reject(Error(`Registered command failed (${code}): ${stderr.slice(-1000)}`));const parsed=JSON.parse(stdout);resolve(parsed.data??parsed);});
  child.stdin.end(input?JSON.stringify(input):undefined);
 });
}
try {
 await mkdir(source);await mkdir(mind);
 const original=await snapshot(resolve(dirname(fileURLToPath(import.meta.url)),'..'));
 for(const [name,file]of original.files){const target=join(source,name);await mkdir(dirname(target),{recursive:true});await writeFile(target,file.data,{mode:file.mode});}
 await copyFile(join(source,'src/provider.mjs'),join(source,'src/message-production.mjs'));
 await copyFile(join(source,'docker/provider-fixture.mjs'),join(source,'src/provider.mjs'));
 const candidate=await snapshot(source);await init(home,mind);
 await call(['plugins','install','twilio','--source',source,'--revision',candidate.revision]);
 record=JSON.parse(await readFile(join(home,'registry.json'),'utf8')).plugins.twilio;
 await call(['plugins','start','twilio']);
 await call(['twilio','init'],{accountSid:`AC${'1'.repeat(32)}`,authToken:'2'.repeat(32),sender:'+15551230001',startAt:new Date(Date.now()-60000).toISOString()});
 assert.equal((await call(['twilio','doctor'])).sms,true);
 await call(['twilio','sync']);
 const first=await call(['twilio','inbox','--after','0','--limit','100']);
 assert.equal(first.events.filter(e=>e.kind==='message').length,1);
 const args=['twilio','send','--to','+15551230002','--text','Synthetic registry reply','--key','manager:1'];
 const sent=await call(args);assert.equal(sent.state,'accepted');
 assert.equal((await call(args)).providerMessageId,sent.providerMessageId);
 await call(['twilio','sync']);
 const exchange=await call(['twilio','inbox','--after','0','--limit','100']);
 assert.equal(exchange.events.filter(e=>e.kind==='message').length,3);
 await call(['plugins','stop','twilio']);await call(['plugins','start','twilio']);await call(['twilio','sync']);
 const after=await call(['twilio','inbox','--after',String(exchange.nextCursor),'--generation',exchange.generation,'--limit','100']);
 assert.equal(after.events.filter(e=>e.kind==='message').length,1);
 assert.equal((await call(args)).providerMessageId,sent.providerMessageId);
 await call(['twilio','backup']);await call(['plugins','uninstall','twilio']);
 const volumes=(await execute('docker',['volume','ls','--filter',`label=com.docker.compose.project=${record.project}`,'--format','{{.Name}}'])).stdout.trim();assert(volumes);
 console.log('PASS: actual Ez manager install/start/registered CLI; synthetic two-way exchange; same-key send; stop/start catch-up; persistent receipts; consistent backup; data-preserving uninstall. No real provider sends.');
} finally {
 if(record){await execute('docker',['compose','-p',record.project,'-f',record.compose,'down','--volumes']).catch(()=>{});await execute('docker',['image','rm',`${record.project}-twilio:${record.revision.slice(7,23)}`]).catch(()=>{});}
 await rm(root,{recursive:true,force:true});
}
