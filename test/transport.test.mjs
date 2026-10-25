import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, rm, copyFile, mkdir, stat, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Readable} from 'node:stream';
import {Store} from '../src/store.mjs';
import {Transport} from '../src/transport.mjs';
import {Provider, message} from '../src/provider.mjs';
import {serve} from '../src/service.mjs';
import {main} from '../src/cli.mjs';
import {fail} from '../src/errors.mjs';
import {config} from '../src/validation.mjs';

const NOW = Date.parse('2026-10-25T12:00:00.000Z');
const accountSid = `AC${'1'.repeat(32)}`, sender = '+15551230001', remote = '+15551230002';
const connection = config({accountSid, authToken: '2'.repeat(32), sender, startAt: '2026-10-20T00:00:00.000Z'}, NOW);
const id = n => `SM${String(n).padStart(32,'0')}`;
const raw = (n, fields = {}) => ({sid:id(n), account_sid:accountSid, from:remote, to:sender,
  body:`Synthetic SMS ${n}`, direction:'inbound', status:'received', num_media:'0', error_code:null,
  date_created:new Date(NOW-1000).toUTCString(),date_updated:new Date(NOW-1000).toUTCString(),date_sent:new Date(NOW-1000).toUTCString(), ...fields});
const outgoing = (n, fields = {}) => raw(n,{from:sender,to:remote,direction:'outbound-api',status:'sent',...fields});
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(),'ez-twilio-test-'));
  t.after(() => rm(directory,{recursive:true,force:true}));
  const store = new Store(directory); store.binding(connection);
  t.after(() => { try { store.close(); } catch {} });
  return {store,directory};
}
function mock(rows = []) {
  const calls = [], sent = [];
  let failure;
  return {
    calls,sent,rows,
    failPage(value) { failure = value; },
    listPath(direction,start,end) { return `/2010-04-01/Accounts/${accountSid}/Messages.json?${new URLSearchParams({[direction==='inbound'?'To':'From']:sender,'DateSent>=':start,'DateSent<=':end})}`; },
    async page(path) {
      calls.push(path);
      if (failure) { const error=failure; failure=null; throw error; }
      const params=new URL(path,'https://api.twilio.com').searchParams;
      const candidates=rows.filter(row=>(row.direction==='inbound')===params.has('To'));
      const offset=Number(params.get('PageToken')??0);
      const next=offset+2<candidates.length ? (()=>{params.set('PageToken',String(offset+2));return `/2010-04-01/Accounts/${accountSid}/Messages.json?${params}`;})() : null;
      return {messages:candidates.slice(offset,offset+2),next};
    },
    async create(payload) { sent.push(payload); const row=outgoing(100+sent.length,{body:payload.text,to:payload.to,status:'queued'}); rows.push(row); return row; },
    async get(sid) { const value=rows.find(row=>row.sid===sid); if(!value)throw fail('PROVIDER_HTTP','Twilio returned HTTP 404',2,{httpStatus:404,definitive:true});return value; },
    async doctor() { return {accountSid,sender,sms:true}; },
  };
}

test('bounded scan resumes every page after restart; overlap captures each message once',async t=>{
  const {store,directory}=await fixture(t), provider=mock([raw(1),raw(2),raw(3),outgoing(4)]);
  let transport=new Transport(store,connection,{provider,now:()=>NOW});
  const first=await transport.sync(1);
  assert.equal(first.complete,false); assert.equal(store.status().messages,2); assert.equal(store.meta('coverage'),null);
  store.close();
  const reopened=new Store(directory); t.after(()=>reopened.close());
  transport=new Transport(reopened,connection,{provider,now:()=>NOW});
  assert.equal((await transport.sync(1)).complete,false);
  assert.equal((await transport.sync(1)).complete,true);
  assert.equal(reopened.status().messages,4);
  const cursor=reopened.head();
  await transport.sync();
  assert.equal(reopened.head(),cursor); assert.equal(reopened.status().messages,4);
  assert.match(provider.calls[0],/DateSent%3E%3D=2026-10-20/);
});

test('a failed page never advances coverage; long outage starts at the unproven boundary',async t=>{
  const {store}=await fixture(t),provider=mock([raw(1)]);
  const transport=new Transport(store,connection,{provider,now:()=>NOW});
  provider.failPage(fail('PROVIDER_UNAVAILABLE','Unavailable',5));
  await assert.rejects(transport.sync(),/Unavailable/);
  assert.equal(store.meta('coverage'),null);
  await transport.sync();
  assert.equal(store.status().messages,1);
  const later=NOW+10*86400000;
  const resumed=new Transport(store,connection,{provider,now:()=>later});
  await resumed.sync();
  assert.match(provider.calls.at(-2),/DateSent%3E%3D=2026-10-20/);
});

test('day-granular reads do not import or quarantine pre-activation redacted history',async t=>{
  const {store}=await fixture(t),provider=mock([raw(1),raw(2,{body:null,date_created:'Mon, 19 Oct 2026 00:00:00 GMT'})]);
  const result=await new Transport(store,connection,{provider,now:()=>NOW}).sync();
  assert.equal(result.complete,true);assert.equal(store.status().messages,1);assert.equal(store.status().quarantined,0);
});

test('consumer acknowledgment is separate, monotonic and bound to the store generation',async t=>{
  const {store}=await fixture(t); await new Transport(store,connection,{provider:mock([raw(1)]),now:()=>NOW}).sync();
  const inbox=store.inbox(0,1);
  assert.equal(inbox.events.length,1);
  assert.throws(()=>store.acknowledge('consumer',1,'wrong'),/does not belong/);
  store.acknowledge('consumer',inbox.nextCursor,inbox.generation);
  assert.throws(()=>store.acknowledge('consumer',0,inbox.generation),/backward/);
  assert.equal(store.inbox(0,1).events[0].id,inbox.events[0].id);
});

test('concurrent same-key sends submit once, keep receipts after restart and reject changed payload',async t=>{
  const {store,directory}=await fixture(t),provider=mock();
  let release; const original=provider.create;
  provider.create=async payload=>{await new Promise(resolve=>{release=resolve;});return original(payload);};
  const transport=new Transport(store,connection,{provider,now:()=>NOW});
  const first=transport.send({to:remote,text:'Hello',key:'conversation:1'});
  assert.equal((await transport.send({to:remote,text:'Hello',key:'conversation:1'})).state,'uncertain');
  release(); const accepted=await first; assert.equal(accepted.state,'accepted');assert.equal(provider.sent.length,1);
  await assert.rejects(transport.send({to:remote,text:'Changed',key:'conversation:1'}),/different payload/);
  store.close(); const reopened=new Store(directory);t.after(()=>reopened.close());
  const replay=await new Transport(reopened,connection,{provider,now:()=>NOW}).send({to:remote,text:'Hello',key:'conversation:1'});
  assert.equal(replay.providerMessageId,accepted.providerMessageId);assert.equal(provider.sent.length,1);
});

test('lost create response remains uncertain and history similarity never authorizes a resend',async t=>{
  const {store}=await fixture(t),provider=mock();let submits=0;
  provider.create=async payload=>{submits++;provider.rows.push(outgoing(77,{body:payload.text}));throw fail('PROVIDER_UNAVAILABLE','Response lost',5);};
  const transport=new Transport(store,connection,{provider,now:()=>NOW});
  const send={to:remote,text:'A single message',key:'lost:1'};
  assert.equal((await transport.send(send)).state,'uncertain');
  await transport.sync();
  assert.equal((await transport.send(send)).state,'uncertain');assert.equal(submits,1);
});

test('definitive rejection is retained and delivery status is recovered by polling a known SID',async t=>{
  const {store}=await fixture(t),provider=mock();
  const transport=new Transport(store,connection,{provider,now:()=>NOW});
  const accepted=await transport.send({to:remote,text:'Hello',key:'delivery:1'});
  const row=provider.rows.find(row=>row.sid===accepted.providerMessageId);row.status='delivered';
  await transport.sync();assert.equal(store.operation('delivery:1').state,'delivered');
  provider.create=async()=>{throw fail('PROVIDER_HTTP','Twilio returned HTTP 400',2,{httpStatus:400,providerCode:21610,definitive:true});};
  const rejected=await transport.send({to:remote,text:'Refused',key:'delivery:2'});
  assert.equal(rejected.state,'rejected');assert.equal(rejected.error.providerCode,21610);
});

test('bad provider rows are quarantined without starving healthy capture; stale status cannot regress a receipt',async t=>{
  const {store}=await fixture(t),provider=mock([raw(1)]),transport=new Transport(store,connection,{provider,now:()=>NOW});
  await transport.sync();provider.rows[0].body='Changed';provider.rows.push(raw(2,{body:null}),raw(3));
  const result=await transport.sync();assert.equal(result.complete,false);assert.equal(result.scanComplete,true);
  assert.equal(store.status().quarantined,2);assert.equal(store.getMessage(id(3)).body,'Synthetic SMS 3');
  assert.equal(store.meta('scan'),null);assert.equal(store.meta('coverage').gaps,2);
  assert.equal(store.getMessage(id(1)).body,'Synthetic SMS 1');
  const accepted=await transport.send({to:remote,text:'Hello',key:'status:1'});
  store.transaction(()=>store.capture(message(outgoing(101,{body:'Hello',status:'delivered',date_updated:new Date(NOW+1000).toUTCString()}),connection,NOW)));
  store.transaction(()=>store.capture(message(outgoing(101,{body:'Hello',status:'sent'}),connection,NOW)));
  assert.equal(store.operation(accepted.key).state,'delivered');
});

test('restricted source watches isolate account/contact, survive restart and release no capture history',async t=>{
  const {store,directory}=await fixture(t),provider=mock();let now=NOW;
  let transport=new Transport(store,connection,{provider,now:()=>now});
  const accountId=transport.accountId();
  assert.throws(()=>transport.watch({accountId:'other',conversationId:remote,expiresAt:now+10000}),/another account/);
  transport.watch({accountId,conversationId:remote,expiresAt:now+10000});
  provider.rows.push(raw(1),raw(2,{from:'+15551230003'}));await transport.sync();
  const batch=transport.events(0);assert.equal(batch.events.length,1);assert.equal(batch.events[0].conversationId,remote);
  store.close();const reopened=new Store(directory);t.after(()=>reopened.close());
  transport=new Transport(reopened,connection,{provider,now:()=>now});
  assert.equal(transport.check([batch.events[0].id]).events.length,1);
  await assert.rejects(transport.taskSend({accountId,conversationId:'+15551230003',text:'No',key:'wrong:1'}),/absent or expired/);
  reopened.release([batch.events[0].id]);assert.equal(transport.check([batch.events[0].id]).events.length,0);
  assert.equal(reopened.inbox(0,100).events.length,4);
  now+=20000;await assert.rejects(transport.taskSend({accountId,conversationId:remote,text:'No',key:'expired:1'}),/absent or expired/);
});

test('consistent snapshot restores with a sending barrier and preserves existing operation identity',async t=>{
  const {store,directory}=await fixture(t),provider=mock(),transport=new Transport(store,connection,{provider,now:()=>NOW});
  const payload={to:remote,text:'Hello',key:'backup:1'};const accepted=await transport.send(payload);
  await store.backup();
  const restoredDirectory=join(directory,'restored');await mkdir(restoredDirectory);
  await copyFile(join(directory,'backup.sqlite'),join(restoredDirectory,'transport.sqlite'));
  const restored=new Store(restoredDirectory);t.after(()=>restored.close());
  const recovered=new Transport(restored,connection,{provider,now:()=>NOW});
  assert.equal((await recovered.send(payload)).providerMessageId,accepted.providerMessageId);
  await assert.rejects(recovered.send({...payload,key:'backup:2'}),/requires reconciliation/);
  assert.equal(provider.sent.length,1);
});

test('a restored snapshot invalidates old cursors and source authority even when sequence numbers are reused',async t=>{
  const {store,directory}=await fixture(t),provider=mock([raw(1)]);
  const original=new Transport(store,connection,{provider,now:()=>NOW});await original.sync();
  const generation=store.meta('generation'),accountId=original.accountId();
  original.watch({accountId,conversationId:remote,expiresAt:NOW+10000});await store.backup();
  provider.rows.unshift(raw(2),raw(3));await original.sync();const oldCursor=store.head();
  const restoredDirectory=join(directory,'restored');await mkdir(restoredDirectory);
  await copyFile(join(directory,'backup.sqlite'),join(restoredDirectory,'transport.sqlite'));
  const restored=new Store(restoredDirectory);t.after(()=>restored.close());
  const recovered=new Transport(restored,connection,{provider,now:()=>NOW});
  provider.rows.unshift(raw(4));await recovered.sync();
  assert(restored.head()>oldCursor);assert.notEqual(recovered.accountId(),accountId);assert.equal(restored.watches().length,0);
  assert.throws(()=>restored.inbox(oldCursor,100,generation),/generation/);
  assert.throws(()=>recovered.events(0),/rebind source authority/);
  assert(restored.inbox(0,100).events.some(event=>event.message.id===id(4)));
});

test('known-SID polling rotates beyond twenty operations including permanent read failures',async t=>{
  const {store}=await fixture(t),provider=mock();let now=NOW;
  const transport=new Transport(store,connection,{provider,now:()=>now});
  for(let n=0;n<21;n++)await transport.send({to:remote,text:`Message ${n}`,key:`fair:${String(n).padStart(2,'0')}`});
  provider.page=async()=>({messages:[],next:null});
  const reads=[];const get=provider.get;
  provider.get=async sid=>{reads.push(sid);if(sid===id(101))throw fail('PROVIDER_HTTP','HTTP 404',2,{httpStatus:404,definitive:true});return get(sid);};
  now+=1000;await transport.sync();assert.equal(new Set(reads).size,20);
  now+=1000;await transport.sync();assert.equal(new Set(reads).size,21);
});

test('HTTP provider refuses cross-account pagination and never follows redirects or leaks error content',async()=>{
  let count=0;
  const provider=new Provider(connection,{fetch:async(url,options)=>{count++;assert.equal(options.redirect,'error');return Response.json({messages:[],next_page_uri:'https://attacker.example/Messages.json'});}});
  await assert.rejects(provider.page(provider.listPath('inbound','2026-10-25','2026-10-25')),/pagination/);
  await assert.rejects(provider.request(`/2010-04-01/Accounts/AC${'3'.repeat(32)}/Messages.json`),/resource/);
  assert.equal(count,1);
  const errorProvider=new Provider(connection,{fetch:async()=>new Response(JSON.stringify({code:20003,message:'private credential material'}),{status:401})});
  await assert.rejects(errorProvider.doctor(),error=>error.exitCode===3&&!JSON.stringify(error).includes('private credential'));
});

test('managed-service CLI keeps credentials on stdin, is single-writer and captures while clients are disconnected',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'ez-twilio-svc-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const socketPath=join(directory,'service.sock'),provider=mock([raw(1)]);
  const running=await serve({directory,socketPath,provider:()=>provider,now:()=>NOW});t.after(()=>running.close());
  const cli=(args,stdin)=>main(args,{socketPath,stdin:Readable.from([JSON.stringify(stdin??{})])});
  await cli(['init'],{accountSid,authToken:'2'.repeat(32),sender,startAt:connection.startAt});
  await cli(['sync']);assert.equal((await cli(['inbox'])).events[0].message.id,id(1));
  const status=await cli(['status']);assert.equal(JSON.stringify(status).includes('22222222'),false);
  assert.equal((await stat(join(directory,'connection.json'))).mode&0o777,0o600);
  assert.ok((await readFile(join(directory,'connection.json'),'utf8')).includes('authToken'));
  await assert.rejects(serve({directory,socketPath,provider:()=>provider}),/Another plugin service/);
  const response=await cli(['send','--to',remote,'--text','Hello','--key','cli:1']);assert.equal(response.state,'accepted');
  await assert.rejects(cli(['init','--auth-token','not-allowed']),/Invalid command/);
});
