import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, rm, copyFile, mkdir, stat, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Readable} from 'node:stream';
import {Store} from '../src/store.mjs';
import {Transport} from '../src/transport.mjs';
import {Provider, message} from '../src/provider.mjs';
import {serve} from '../src/service.mjs';
import {main} from '../src/cli.mjs';
import {fail} from '../src/errors.mjs';
import {config, senders, sendInput} from '../src/validation.mjs';

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
    listPath(direction,start,end,from=sender) { return `/2010-04-01/Accounts/${accountSid}/Messages.json?${new URLSearchParams({[direction==='inbound'?'To':'From']:from,'DateSent>=':start,'DateSent<=':end})}`; },
    async page(path) {
      calls.push(path);
      if (failure) { const error=failure; failure=null; throw error; }
      const params=new URL(path,'https://api.twilio.com').searchParams;
      const candidates=rows.filter(row=>params.has('To') ? row.direction==='inbound'&&row.to===params.get('To') : row.direction!=='inbound'&&row.from===params.get('From'));
      const offset=Number(params.get('PageToken')??0);
      const next=offset+2<candidates.length ? (()=>{params.set('PageToken',String(offset+2));return `/2010-04-01/Accounts/${accountSid}/Messages.json?${params}`;})() : null;
      return {messages:candidates.slice(offset,offset+2),next};
    },
    async create(payload) { sent.push(payload); const row=outgoing(100+sent.length,{body:payload.text,from:payload.from,to:payload.to,status:'queued'}); rows.push(row); return row; },
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

test('second-precision provider timestamps retain SMS in the activation boundary second',async t=>{
  const {store}=await fixture(t),provider=mock([raw(1,{date_created:new Date(NOW).toUTCString()})]);
  const exactBoundary={...connection,startAt:new Date(NOW+500).toISOString()};
  const result=await new Transport(store,exactBoundary,{provider,now:()=>NOW+1000}).sync();
  assert.equal(result.complete,true);assert.equal(store.status().messages,1);
});

test('To/From listing does not mistake another owned line outbound copy for our incoming SMS',async t=>{
  const {store}=await fixture(t),provider=mock();
  provider.page=async path=>({messages:new URL(path,'https://api.twilio.com').searchParams.has('To')
    ?[raw(1),outgoing(2,{from:'+15551230003',to:sender})]:[],next:null});
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

const secondSender = '+15551230003';
const multiConnection = config({accountSid,authToken:'2'.repeat(32),senders:[secondSender,sender],startAt:connection.startAt},NOW);

test('multi-number configuration and send input require an explicit configured sender',()=>{
  assert.deepEqual(senders(multiConnection),[sender,secondSender]);
  assert.deepEqual(senders(connection),[sender]);
  const fields={accountSid,authToken:'2'.repeat(32),startAt:connection.startAt};
  assert.throws(()=>config({...fields,sender,senders:[sender]},NOW),/not both/);
  assert.throws(()=>config({...fields,senders:[sender,sender]},NOW),/unique/);
  assert.throws(()=>config({...fields,senders:[]},NOW),/1..1000/);
  const args={to:remote,text:'Caller selects the number',key:'numbers:1'};
  assert.throws(()=>sendInput(args,multiConnection),/Select a configured sender/);
  assert.throws(()=>sendInput({...args,from:'+15551230099'},multiConnection),/not configured/);
  assert.equal(sendInput({...args,from:secondSender},multiConnection).from,secondSender);
  assert.equal(sendInput(args,connection).from,sender);
});

test('multi-number polling resumes across pages and lines without advancing coverage early or duplicating messages',async t=>{
  const {store,directory}=await fixture(t);store.binding(multiConnection);
  const provider=mock([raw(1),raw(2),raw(3),raw(4,{to:secondSender}),outgoing(5),outgoing(6,{from:secondSender})]);
  let transport=new Transport(store,multiConnection,{provider,now:()=>NOW});
  assert.equal((await transport.sync(1)).complete,false);
  assert.equal(store.status().messages,2);assert.equal(store.meta('coverage'),null);
  store.close();const reopened=new Store(directory);t.after(()=>reopened.close());
  transport=new Transport(reopened,multiConnection,{provider,now:()=>NOW});
  await transport.sync(1);await transport.sync(1);
  assert.equal(reopened.meta('scan').sender,secondSender);assert.equal(reopened.meta('coverage'),null);
  assert.equal((await transport.sync(2)).complete,true);
  assert.equal(reopened.status().messages,6);assert.equal(reopened.status().quarantined,0);
  assert(provider.calls.some(path=>new URL(path,'https://api.twilio.com').searchParams.get('To')===secondSender));
  assert(provider.calls.some(path=>new URL(path,'https://api.twilio.com').searchParams.get('From')===secondSender));
  const head=reopened.head();await transport.sync();assert.equal(reopened.head(),head);
  provider.page=async()=>({messages:[raw(99,{to:'+15551230099'})],next:null});
  assert.equal((await transport.sync()).complete,false);
  assert.equal(reopened.getMessage(id(99)),null);
});

test('send receipts bind the explicit number and cannot replay a key through another line',async t=>{
  const {store,directory}=await fixture(t);store.binding(multiConnection);
  const provider=mock(),transport=new Transport(store,multiConnection,{provider,now:()=>NOW});
  const a={from:sender,to:remote,text:'First line',key:'line:1'},b={from:secondSender,to:remote,text:'Second line',key:'line:2'};
  assert.equal((await transport.send({...b,preview:true})).payload.from,secondSender);assert.equal(provider.sent.length,0);
  const [first,second]=await Promise.all([transport.send(a),transport.send(b)]);
  assert.equal(first.from,sender);assert.equal(second.from,secondSender);assert.equal(provider.sent.length,2);
  await assert.rejects(transport.send({...a,from:secondSender}),/different payload/);
  await transport.sync();store.close();const reopened=new Store(directory);t.after(()=>reopened.close());
  const restarted=new Transport(reopened,multiConnection,{provider,now:()=>NOW});
  assert.equal((await restarted.send(b)).providerMessageId,second.providerMessageId);assert.equal(provider.sent.length,2);
});

test('native conversations isolate the same remote contact by our number and reply through that exact line',async t=>{
  const {store}=await fixture(t);store.binding(multiConnection);
  const provider=mock(),transport=new Transport(store,multiConnection,{provider,now:()=>NOW});
  const accountId=transport.accountId(),a=`${sender}:${remote}`,b=`${secondSender}:${remote}`;
  assert.throws(()=>transport.watch({accountId,conversationId:remote,expiresAt:NOW+10000}),/OUR_E164:REMOTE_E164/);
  transport.watch({accountId,conversationId:a,expiresAt:NOW+10000});
  provider.rows.push(raw(1),raw(2,{to:secondSender}));await transport.sync();
  const batch=transport.events(0);assert.equal(batch.events.length,1);assert.equal(batch.events[0].conversationId,a);
  await assert.rejects(transport.taskSend({accountId,conversationId:b,text:'Unwatched line',key:'native:wrong'}),/absent or expired/);
  transport.watch({accountId,conversationId:b,expiresAt:NOW+10000});
  assert.equal(transport.check([`${id(2)}_message`]).events.length,0);
  provider.rows.push(raw(3,{to:secondSender}));await transport.sync();
  assert.equal(transport.check([`${id(3)}_message`]).events[0].conversationId,b);
  await transport.taskSend({accountId,conversationId:a,text:'From first',key:'native:a'});
  await transport.taskSend({accountId,conversationId:b,text:'From second',key:'native:b'});
  assert.deepEqual(provider.sent.map(row=>row.from),[sender,secondSender]);
  transport.unwatch({accountId,conversationId:a});assert.equal(transport.check([`${id(1)}_message`]).events.length,0);
  assert.equal(transport.check([`${id(3)}_message`]).events.length,1);
});

test('adding configured numbers retains the journal and receipts, resets coverage and invalidates old native attention',async t=>{
  const {store}=await fixture(t),provider=mock([raw(1)]),transport=new Transport(store,connection,{provider,now:()=>NOW});
  await transport.sync();const sent=await transport.send({to:remote,text:'Keep receipt',key:'expand:1'});
  const oldAccountId=transport.accountId();transport.watch({accountId:oldAccountId,conversationId:remote,expiresAt:NOW+10000});
  store.binding(multiConnection,false);assert(store.meta('coverage'));assert.equal(store.watches().length,1);
  store.binding(multiConnection);assert.equal(store.meta('coverage'),null);assert.equal(store.meta('scan'),null);assert.equal(store.watches().length,0);
  assert.equal(store.getMessage(id(1)).body,'Synthetic SMS 1');assert.equal(store.operation('expand:1').providerMessageId,sent.providerMessageId);
  const expanded=new Transport(store,multiConnection,{provider,now:()=>NOW});
  assert.notEqual(expanded.accountId(),oldAccountId);
  assert.throws(()=>expanded.watch({accountId:oldAccountId,conversationId:`${sender}:${remote}`,expiresAt:NOW+10000}),/another account/);
  assert.throws(()=>store.binding(connection),/removed sender/);
  store.setMeta('coverage',{completedThrough:new Date(NOW).toISOString()});
  store.binding(config({accountSid,authToken:'2'.repeat(32),senders:[secondSender,sender],startAt:connection.startAt},NOW));
  assert(store.meta('coverage'));
  const fifteen=config({accountSid,authToken:'2'.repeat(32),senders:Array.from({length:15},(_,n)=>`+1555123${String(n+1).padStart(4,'0')}`),startAt:connection.startAt},NOW);
  assert(new Transport(store,fifteen,{provider,now:()=>NOW}).accountId().length<=200);
});

test('HTTP provider checks each configured number and submits the exact caller-selected From',async()=>{
  const seen=[];
  const provider=new Provider(multiConnection,{fetch:async(url,options)=>{
    seen.push({url,options});
    if(options.method==='POST')return Response.json(outgoing(1));
    const from=new URL(url).searchParams.get('PhoneNumber');
    return Response.json({incoming_phone_numbers:[{account_sid:accountSid,phone_number:from,capabilities:{sms:true}}]});
  }});
  assert.deepEqual((await provider.doctor()).senders,[sender,secondSender]);assert.equal(seen.length,2);
  assert.throws(()=>provider.listPath('inbound','2026-10-25','2026-10-25'),/Select a configured sender/);
  assert.equal(new URL(provider.listPath('outbound','2026-10-25','2026-10-25',secondSender),'https://api.twilio.com').searchParams.get('From'),secondSender);
  await provider.create(sendInput({from:secondSender,to:remote,text:'Explicit line',key:'http:1'},multiConnection));
  assert.equal(new URLSearchParams(seen.at(-1).options.body).get('From'),secondSender);
  const invalid=new Provider(multiConnection,{fetch:async()=>Response.json({incoming_phone_numbers:[]})});
  await assert.rejects(invalid.doctor(),/not an SMS-capable number/);
});

test('service expansion waits for the old scan and preserves private configuration and operation receipts after restart',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'ez-twilio-expand-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const socketPath=join(directory,'service.sock'),provider=mock([raw(1),raw(2,{to:secondSender})]);
  let running=await serve({directory,socketPath,provider:()=>provider,now:()=>NOW});
  t.after(()=>running.close());
  await running.call('init',{configuration:{accountSid,authToken:'2'.repeat(32),sender,startAt:connection.startAt}});
  await running.call('sync');
  const sent=await running.call('send',{to:remote,text:'Retain legacy receipt',key:'service:1'});
  const original=provider.page;let release,started;const began=new Promise(resolve=>{started=resolve;});
  provider.page=async path=>{if(!release){await new Promise(resolve=>{release=resolve;started();});}return original(path);};
  const scan=running.call('sync');await began;
  const expansion=running.call('init',{configuration:{accountSid,authToken:'2'.repeat(32),senders:[sender,secondSender]}});
  await assert.rejects(running.call('sync'),/Configuration is being updated/);
  release();await scan;await expansion;
  await running.close();running=await serve({directory,socketPath,provider:()=>provider,now:()=>NOW});
  await running.call('sync');
  assert.deepEqual(running.store.meta('binding').senders,[sender,secondSender]);
  assert.equal(running.store.status().messages,3);
  assert.equal(running.store.operation('service:1').providerMessageId,sent.providerMessageId);
  assert.equal((await running.call('send',{from:sender,to:remote,text:'Retain legacy receipt',key:'service:1'})).providerMessageId,sent.providerMessageId);
  assert.equal(provider.sent.length,1);
});

test('startup completes sender expansion if the private configuration committed before the journal binding',async t=>{
  const {directory,store}=await fixture(t);store.capture(message(raw(1),connection,NOW));store.close();
  await writeFile(join(directory,'connection.json'),JSON.stringify(multiConnection),{mode:0o600});
  const running=await serve({directory,socketPath:join(directory,'service.sock'),provider:()=>mock(),now:()=>NOW});
  t.after(()=>running.close());
  assert.deepEqual(running.store.meta('binding').senders,[sender,secondSender]);
  assert.equal(running.store.status().messages,1);assert.equal(running.store.meta('coverage'),null);
});
