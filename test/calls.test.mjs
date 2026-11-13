import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Readable} from 'node:stream';
import {Provider} from '../src/provider.mjs';
import {calls, recordings, recordingMedia} from '../src/calls.mjs';
import {serve} from '../src/service.mjs';
import {main} from '../src/cli.mjs';
import {config} from '../src/validation.mjs';

const NOW = Date.parse('2026-10-25T12:00:00.000Z');
const accountSid = `AC${'1'.repeat(32)}`, lineA = '+15551230001', lineB = '+15551230003', remote = '+15551230002';
const startAt = '2026-10-01T00:00:00.000Z', root = `/2010-04-01/Accounts/${accountSid}`;
const multi = config({accountSid, authToken: '2'.repeat(32), senders: [lineA, lineB], startAt}, NOW);
const single = config({accountSid, authToken: '2'.repeat(32), sender: lineA, startAt}, NOW);
const callSid = n => `CA${String(n).padStart(32, '0')}`, recSid = n => `RE${String(n).padStart(32, '0')}`;
const rfc = iso => new Date(iso).toUTCString().replace('GMT', '+0000');
const callRow = (n, at, fields = {}) => ({sid: callSid(n), account_sid: accountSid, from: remote, to: lineA, direction: 'inbound', status: 'completed',
  parent_call_sid: null, start_time: rfc(at), end_time: rfc(new Date(at).getTime() + 60000), duration: '60', answered_by: null, ...fields});
const recRow = (n, call, fields = {}) => ({sid: recSid(n), account_sid: accountSid, call_sid: callSid(call), status: 'completed', duration: '42',
  channels: 1, source: 'DialVerb', date_created: rfc('2026-10-24T10:01:00Z'), ...fields});
const audio = (body, type = 'audio/mpeg') => new Response(body, {status: 200, headers: {'content-type': type}});
const serving = (connection, value) => new Provider(connection, {fetch: async () => Response.json(value)});
const redirect = location => new Response(null, {status: 302, headers: {location}});

// A synthetic Twilio: lists are newest first, date filters are whole UTC days (inclusive), pages are `pageSize` rows.
function twilio({calls: callRows = [], recordings: recRows = [], notifications = {}, media = {}, external, pageSize = 2} = {}) {
  const requests = [], denied = new Set();
  const json = (value, status = 200) => Response.json(value, {status});
  const missing = () => json({code: 20404, message: 'The requested resource was not found', status: 404}, 404);
  const day = ms => new Date(ms).toISOString().slice(0, 10);
  async function fetch(href, options) {
    const url = new URL(href), q = url.searchParams;
    requests.push({host: url.host, pathname: url.pathname, query: q, authorization: options.headers?.Authorization, redirect: options.redirect});
    if (url.host !== 'api.twilio.com') return external?.(url) ?? new Response('unexpected host', {status: 500});
    const path = url.pathname.slice(root.length);
    if (denied.has(path.split(/[/.]/)[1])) return json({code: 20003, message: 'denied', status: 403}, 403);
    const paged = (field, rows) => {
      const page = Number(q.get('Page') ?? 0), next = new URLSearchParams(q);
      next.set('Page', String(page + 1));
      return json({[field]: rows.slice(page * pageSize, (page + 1) * pageSize), next_page_uri: (page + 1) * pageSize < rows.length ? `${url.pathname}?${next}` : null});
    };
    let m;
    if (path === '/Messages.json') return json({messages: [], next_page_uri: null});
    if (path === '/IncomingPhoneNumbers.json') return json({incoming_phone_numbers: [{account_sid: accountSid, phone_number: q.get('PhoneNumber'), capabilities: {sms: true}}]});
    if (path === '/Calls.json') {
      const at = row => row.start_time ? Date.parse(row.start_time) : 0;
      return paged('calls', callRows.filter(row => (!q.has('To') || row.to === q.get('To')) && (!q.has('From') || row.from === q.get('From')) &&
        (!row.start_time || day(at(row)) >= q.get('StartTime>=') && day(at(row)) <= q.get('StartTime<='))).sort((a, b) => at(b) - at(a)));
    }
    if (path === '/Recordings.json') return json({recordings: recRows.slice(0, 1), next_page_uri: null});
    if ((m = path.match(/^\/Calls\/(CA\w+)\/Recordings\.json$/))) return callRows.some(row => row.sid === m[1]) ? paged('recordings', recRows.filter(row => row.call_sid === m[1])) : missing();
    if ((m = path.match(/^\/Calls\/(CA\w+)\/Notifications\.json$/))) return json({notifications: notifications[m[1]] ?? [], next_page_uri: null});
    if ((m = path.match(/^\/Recordings\/(RE\w+)\.json$/))) { const row = recRows.find(item => item.sid === m[1]); return row ? json(row) : missing(); }
    if ((m = path.match(/^\/Recordings\/(RE\w+)\.(mp3|wav)$/))) return (media[m[1]] ?? (() => audio('synthetic audio')))(m[2]);
    return missing();
  }
  return {fetch, requests, denied, provider: (connection = multi) => new Provider(connection, {fetch})};
}

test('calls merge both directions of every number, keep parent legs only, filter exactly and sort ascending',async()=>{
  const sim=twilio({calls:[
    callRow(1,'2026-10-24T10:00:00Z'),
    callRow(2,'2026-10-24T11:00:00Z',{from:lineB,to:remote,direction:'outbound-api',status:'busy',duration:'0'}),
    callRow(3,'2026-10-24T09:00:00Z'),
    callRow(4,'2026-10-24T10:30:00Z',{from:lineA,to:lineB,direction:'outbound-api'}),
    callRow(5,'2026-10-24T10:15:00Z',{parent_call_sid:callSid(1)}),
    callRow(6,'2026-10-24T10:20:00Z',{start_time:null,status:'queued'}),
    callRow(7,'2026-10-25T08:00:00Z',{to:lineB,status:'no-answer',end_time:null,duration:null,answered_by:'machine_start'}),
  ]});
  const after='2026-10-24T09:30:00.000Z',provider=sim.provider();
  const result=await calls(provider,multi,{after},NOW);
  assert.deepEqual(result.calls.map(row=>row.sid),[callSid(1),callSid(4),callSid(2),callSid(7)]);
  assert.equal(result.complete,true);
  assert.deepEqual(result.calls[0],{sid:callSid(1),accountSid,from:remote,to:lineA,direction:'inbound',status:'completed',
    startTime:'2026-10-24T10:00:00.000Z',endTime:'2026-10-24T10:01:00.000Z',durationSeconds:60,answeredBy:null,errorCode:null});
  assert.deepEqual(result.calls[3],{sid:callSid(7),accountSid,from:remote,to:lineB,direction:'inbound',status:'no-answer',
    startTime:'2026-10-25T08:00:00.000Z',endTime:null,durationSeconds:null,answeredBy:'machine_start',errorCode:null});
  const streams=sim.requests.map(request=>`${request.query.has('To')?'To':'From'}=${request.query.get('To')??request.query.get('From')}`);
  for(const stream of [`To=${lineA}`,`From=${lineA}`,`To=${lineB}`,`From=${lineB}`])assert(streams.includes(stream),stream);
  assert(sim.requests.every(request=>request.host==='api.twilio.com'&&request.authorization?.startsWith('Basic ')));
  assert.equal(sim.requests[0].query.get('StartTime>='),'2026-10-24');
  const limited=await calls(provider,multi,{after,limit:2},NOW);
  assert.deepEqual(limited.calls.map(row=>row.sid),[callSid(1),callSid(4)]);assert.equal(limited.complete,false);
  const exact=await calls(provider,multi,{after,limit:4},NOW);assert.equal(exact.complete,true);
  assert.deepEqual(await calls(provider,multi,{after:'2026-10-26T00:00:00Z'},NOW),{calls:[],complete:true});
});

test('a page cap never hides the oldest calls: dense history is read oldest first as a contiguous prefix',async()=>{
  const rows=[];for(let n=1;n<=14;n++)rows.push(callRow(n,`2026-10-${19+Math.floor((n-1)/2)}T${n%2?'09':'11'}:00:00Z`));
  const sim=twilio({calls:rows}),provider=sim.provider(single),expected=rows.map(row=>row.sid);
  // Page bound is 5 pages of 2 rows per stream: the 14-call history cannot be read as one window.
  const seen=[];let after='2026-10-01T00:00:00.000Z',rounds=0;
  for(;;){
    const result=await calls(provider,single,{after,limit:5},NOW);
    assert(++rounds<10);seen.push(...result.calls.map(row=>row.sid));
    if(result.complete)break;
    assert.notEqual(result.calls.at(-1).startTime,after);after=result.calls.at(-1).startTime;
  }
  assert.deepEqual([...new Set(seen)],expected);
  assert(Math.max(...sim.requests.map(request=>Number(request.query.get('Page')??0)))<=4);
  const first=await calls(provider,single,{after:'2026-10-01T00:00:00.000Z',limit:5},NOW);
  assert.deepEqual(first.calls.map(row=>row.sid),expected.slice(0,5));assert.equal(first.complete,false);
  // One UTC day over the bound fails instead of returning a list that skips calls.
  const day=Array.from({length:11},(_,n)=>callRow(n+1,`2026-10-24T${String(n).padStart(2,'0')}:00:00Z`));
  await assert.rejects(calls(twilio({calls:day}).provider(single),single,{after:'2026-10-20T00:00:00Z'},NOW),error=>error.code==='PROVIDER_RESPONSE'&&/UTC day/.test(error.message));
});

// Regression (Quarre, 2026-11-12): one inbound call with a withheld caller ID (`from` is the word 'anonymous') failed the whole
// read with PROVIDER_RESPONSE, so the consumer's cursor stopped there and every later call stayed unreadable.
test('a call whose other party is not an E.164 number is returned as it is and never fails the read',async()=>{
  const rows=[
    callRow(1,'2026-10-24T09:00:00Z'),
    callRow(2,'2026-10-24T09:10:00Z',{from:'anonymous'}),
    callRow(3,'2026-10-24T09:20:00Z',{from:'+464'}),
    callRow(4,'2026-10-24T09:30:00Z',{from:'client:alice'}),
    callRow(5,'2026-10-24T09:40:00Z',{from:lineA,to:'sip:desk@example.com',direction:'outbound-api'}),
    callRow(6,'2026-10-24T09:50:00Z',{from:lineA,to:remote,direction:'outbound-api'}),
  ];
  const result=await calls(twilio({calls:rows,pageSize:10}).provider(single),single,{after:'2026-10-24T00:00:00Z'},NOW);
  assert.deepEqual(result.calls.map(row=>row.sid),rows.map(row=>row.sid));
  assert.deepEqual(result.calls.map(row=>row.from),[remote,'anonymous','+464','client:alice',lineA,lineA]);
  assert.deepEqual(result.calls.map(row=>row.to),[lineA,lineA,lineA,lineA,'sip:desk@example.com',remote]);
  assert.equal(result.complete,true);
});

test('the other party is bounded and never rejected, so no value of it can stall a read',async()=>{
  const odd=['ACME Corp','sip:+15551230009@host;user=phone','a'.repeat(80),'été','  padded  ','',null,15551230002];
  const rows=odd.map((from,n)=>callRow(n+1,`2026-10-24T09:${String(n).padStart(2,'0')}:00Z`,{from}));
  const result=await calls(twilio({calls:rows,pageSize:10}).provider(single),single,{after:'2026-10-24T00:00:00Z'},NOW);
  assert.equal(result.calls.length,odd.length);
  assert.deepEqual(result.calls.map(row=>row.from),['ACME Corp','sip:+15551230009@host;user=phone','a'.repeat(64),'?t?','padded','unknown','unknown','unknown']);
  for(const row of result.calls)assert.match(row.from,/^[\x20-\x7E]{1,64}$/);
});

test('a notifications lookup Twilio refuses for good leaves errorCode null and never stops the read; a transient one still fails it',async()=>{
  const failed=n=>callRow(n,`2026-10-24T10:0${n}:00Z`,{from:lineA,to:remote,direction:'outbound-api',status:'failed',duration:'0'});
  const rows=[callRow(1,'2026-10-24T09:00:00Z'),failed(2),failed(3)];
  const serve=notes=>new Provider(single,{fetch:async href=>{
    const url=new URL(href);
    if(url.pathname.endsWith('/Notifications.json'))return notes(url);
    return Response.json({calls:rows,next_page_uri:null});
  }});
  const after='2026-10-24T00:00:00Z',codes=result=>result.calls.map(row=>row.errorCode);
  // Refused for good: a key without Notifications access, the resource gone, or a page that is no longer a notifications page.
  for(const [name,answer] of Object.entries({forbidden:()=>Response.json({code:20003,message:'denied'},{status:403}),
    removed:()=>Response.json({code:20404,message:'gone'},{status:404}),'bad page':()=>Response.json({notifications:'none',next_page_uri:null}),
    'forbidden without JSON':()=>new Response('<html>Forbidden</html>',{status:403}),'removed without body':()=>new Response('',{status:404})})){
    const result=await calls(serve(answer),single,{after},NOW);
    assert.deepEqual(codes(result),[null,null,null],name);assert.equal(result.calls.length,3,name);
  }
  // A passing fault fails the read so the consumer retries it and the code is not lost for good.
  for(const [name,answer] of Object.entries({'server error':()=>Response.json({},{status:503}),throttled:()=>Response.json({},{status:429}),
    'request timeout':()=>Response.json({},{status:408}),interrupted:()=>{throw new Error('socket hang up');},
    // A gateway, CDN or proxy answers in HTML, text or nothing: its status still says it passes.
    'gateway page':()=>new Response('<html>Bad Gateway</html>',{status:502}),'empty 503':()=>new Response('',{status:503}),
    'throttled page':()=>new Response('<html>Slow down</html>',{status:429}),'text 500':()=>new Response('upstream error',{status:500})}))
    await assert.rejects(calls(serve(answer),single,{after},NOW),error=>['PROVIDER_HTTP','PROVIDER_UNAVAILABLE'].includes(error.code),name);
});

test('a read keeps its HTTP status when the answer is not JSON; a write stays PROVIDER_RESPONSE, its outcome uncertain',async()=>{
  const answer=(body,status)=>new Provider(single,{fetch:async()=>new Response(body,{status})});
  await assert.rejects(answer('<html>Bad Gateway</html>',502).request(`${root}/Calls.json`),
    error=>error.code==='PROVIDER_HTTP'&&error.details.httpStatus===502&&error.details.definitive===false);
  await assert.rejects(answer('',403).request(`${root}/Calls.json`),error=>error.code==='PROVIDER_AUTH'&&error.details.definitive===true);
  // A write is never judged from a body that is not Twilio's: no `definitive`, so the operation stays uncertain.
  for(const [body,status] of [['<html>Bad Gateway</html>',502],['',403],['<html>Bad Request</html>',400]])
    await assert.rejects(answer(body,status).request(`${root}/Messages.json`,{To:remote}),
      error=>error.code==='PROVIDER_RESPONSE'&&error.details.definitive===undefined,`write ${status}`);
  await assert.rejects(answer('not json',200).request(`${root}/Calls.json`),error=>error.code==='PROVIDER_RESPONSE');
});

test('calls reject provider rows outside the account or numbers, malformed fields and unsafe pagination',async()=>{
  const good=callRow(1,'2026-10-24T10:00:00Z'),after='2026-10-24T00:00:00Z';
  assert.equal((await calls(serving(single,{calls:[good],next_page_uri:null}),single,{after},NOW)).calls.length,1);
  const bad={
    'another account':{account_sid:`AC${'9'.repeat(32)}`},'wrong SID prefix':{sid:`SM${'1'.repeat(32)}`},'short SID':{sid:'CA123'},
    'number outside the account':{to:'+15559990000'},'another number':{to:lineB},'our own number not E.164':{to:'anonymous'},'outbound own number not E.164':{from:'anonymous',to:remote,direction:'outbound-api'},
    'status':{status:'IN PROGRESS'},'start time':{start_time:'not a date'},'end time':{end_time:'whenever it ended'},'duration':{duration:'-5'},'answered by':{answered_by:'HUMAN!'},
  };
  for(const [name,patch] of Object.entries(bad))
    await assert.rejects(calls(serving(single,{calls:[{...good,...patch}],next_page_uri:null}),single,{after},NOW),error=>error.code==='PROVIDER_RESPONSE',name);
  for(const next of ['https://attacker.example/Calls.json?Page=1',`/2010-04-01/Accounts/AC${'3'.repeat(32)}/Calls.json?Page=1`,`${root}/Messages.json?Page=1`,'//attacker.example/Calls.json?Page=1']){
    let count=0;const provider=new Provider(single,{fetch:async()=>{count++;return Response.json({calls:[good],next_page_uri:next});}});
    await assert.rejects(calls(provider,single,{after},NOW),error=>error.code==='PROVIDER_RESPONSE'&&/pagination/.test(error.message),next);
    assert.equal(count,1);
  }
  const loop=new Provider(single,{fetch:async url=>Response.json({calls:[good],next_page_uri:`${new URL(url).pathname}${new URL(url).search}`})});
  await assert.rejects(calls(loop,single,{after},NOW),/did not advance/);
});

test('recordings list is account-bound and recording media is fetched only when completed, bounded and found',async()=>{
  const mp3=Buffer.from('ID3 synthetic mp3 bytes'),limit=2.5*1024*1024;
  let pulled=0;const endless=()=>audio(new ReadableStream({pull(controller){if(++pulled>1024)controller.close();else controller.enqueue(new Uint8Array(65536));}}));
  const listed=twilio({calls:[callRow(1,'2026-10-24T10:00:00Z')],recordings:[recRow(1,1,{duration:'61',channels:2}),recRow(2,1,{status:'in-progress',duration:null})]});
  assert.deepEqual(await recordings(listed.provider(),multi,{call:callSid(1)}),{recordings:[
    {sid:recSid(1),callSid:callSid(1),status:'completed',durationSeconds:61,channels:2,source:'DialVerb',createdAt:'2026-10-24T10:01:00.000Z',mediaFormats:['mp3','wav']},
    {sid:recSid(2),callSid:callSid(1),status:'in-progress',durationSeconds:null,channels:1,source:'DialVerb',createdAt:'2026-10-24T10:01:00.000Z',mediaFormats:['mp3','wav']}]});
  await assert.rejects(recordings(listed.provider(),multi,{call:callSid(9)}),error=>error.code==='NOT_FOUND'&&error.exitCode===2);
  await assert.rejects(recordings(listed.provider(),multi,{call:'CA123'}),error=>error.code==='INVALID_INPUT');
  const refused={'another account':recRow(1,1,{account_sid:`AC${'9'.repeat(32)}`}),'another call':recRow(1,2),'channels':recRow(1,1,{channels:3}),
    'source':recRow(1,1,{source:'bad source!'}),'status':recRow(1,1,{status:'DONE'}),'created':recRow(1,1,{date_created:null})};
  for(const [name,row] of Object.entries(refused))
    await assert.rejects(recordings(serving(multi,{recordings:[row],next_page_uri:null}),multi,{call:callSid(1)}),error=>error.code==='PROVIDER_RESPONSE',name);
  await assert.rejects(recordings(serving(multi,{recordings:[recRow(1,1)],next_page_uri:`${root}/Calls/${callSid(1)}/Recordings.json?Page=1`}),multi,{call:callSid(1)}),/more recordings/);

  const sim=twilio({recordings:[1,2,3,4,5,6].map(n=>recRow(n,1,n===2?{status:'in-progress'}:{})),
    media:{[recSid(1)]:format=>audio(mp3,format==='wav'?'audio/x-wav; charset=binary':'audio/mpeg'),[recSid(3)]:endless,
      [recSid(4)]:()=>audio(Buffer.alloc(limit,7)),[recSid(5)]:()=>audio('<html>login</html>','text/html'),[recSid(6)]:()=>audio(new Uint8Array(0))}});
  assert.deepEqual(await recordingMedia(sim.provider(),multi,{sid:recSid(1)}),{sid:recSid(1),format:'mp3',contentType:'audio/mpeg',bytes:mp3.length,
    sha256:createHash('sha256').update(mp3).digest('hex'),data:mp3.toString('base64')});
  const wav=await recordingMedia(sim.provider(),multi,{sid:recSid(1),format:'wav'});
  assert.equal(wav.format,'wav');assert.equal(wav.contentType,'audio/x-wav');assert(sim.requests.some(request=>request.pathname.endsWith(`/${recSid(1)}.wav`)));
  for(const args of [{sid:recSid(1),format:'flac'},{sid:'RE123'},{sid:callSid(1)}])
    await assert.rejects(recordingMedia(sim.provider(),multi,args),error=>error.code==='INVALID_INPUT');
  sim.requests.length=0;
  await assert.rejects(recordingMedia(sim.provider(),multi,{sid:recSid(2)}),error=>error.code==='RECORDING_NOT_COMPLETED'&&error.exitCode===4&&error.details.status==='in-progress');
  assert(sim.requests.every(request=>request.pathname.endsWith('.json')),'no media request for a recording that is not completed');
  await assert.rejects(recordingMedia(sim.provider(),multi,{sid:recSid(9)}),error=>error.code==='NOT_FOUND');
  // The bound is hard and streamed: a 64 MiB body is cut off after the limit, not buffered.
  await assert.rejects(recordingMedia(sim.provider(),multi,{sid:recSid(3)}),error=>error.code==='RECORDING_TOO_LARGE'&&error.exitCode===4);
  assert(pulled<=limit/65536+3,`read ${pulled} chunks`);
  const edge=await recordingMedia(sim.provider(),multi,{sid:recSid(4)});
  assert.equal(edge.bytes,limit);assert(JSON.stringify(edge).length<4*1024*1024,'the client accepts up to 4 MiB of reply');
  await assert.rejects(recordingMedia(sim.provider(),multi,{sid:recSid(5)}),error=>error.code==='PROVIDER_RESPONSE'&&/non-audio/.test(error.message));
  await assert.rejects(recordingMedia(sim.provider(),multi,{sid:recSid(6)}),error=>error.code==='PROVIDER_RESPONSE'&&/empty/.test(error.message));
});

test('recording media follows one redirect to a Twilio host without credentials and refuses every other target',async()=>{
  const seen=[],external=url=>{seen.push(url.href);return url.pathname==='/again'?redirect('https://media.twiliocdn.com/final'):audio('cdn bytes');};
  const sim=twilio({recordings:[recRow(1,1)],external,media:{[recSid(1)]:()=>redirect('https://media.twiliocdn.com/signed/audio?signature=abc')}});
  const result=await recordingMedia(sim.provider(),multi,{sid:recSid(1)});
  assert.equal(Buffer.from(result.data,'base64').toString(),'cdn bytes');
  const media=sim.requests.filter(request=>!request.pathname.endsWith('.json'));
  assert.equal(media.length,2);assert.equal(media[0].host,'api.twilio.com');assert(media[0].authorization.startsWith('Basic '));assert.equal(media[0].redirect,'manual');
  assert.equal(media[1].host,'media.twiliocdn.com');assert.equal(media[1].authorization,undefined);assert.equal(media[1].redirect,'manual');
  assert.deepEqual(seen,['https://media.twiliocdn.com/signed/audio?signature=abc']);
  seen.length=0;const authorized=[];
  for(const target of ['https://attacker.example/audio','http://media.twiliocdn.com/audio','https://twilio.com.attacker.example/audio','https://api.twilio.com@attacker.example/audio',
    'https://user:secret@media.twiliocdn.com/audio','https://media.twiliocdn.com:8443/audio','https://evil-twilio.com/audio','https://media.twiliocdn.com/again']){
    const attempt=twilio({recordings:[recRow(1,1)],external,media:{[recSid(1)]:()=>redirect(target)}});
    await assert.rejects(recordingMedia(attempt.provider(),multi,{sid:recSid(1)}),error=>error.code==='PROVIDER_RESPONSE'&&/redirect/.test(error.message),target);
    authorized.push(...attempt.requests.filter(request=>request.authorization).map(request=>request.host));
  }
  // The only external request is the allowed first hop of the final case; its own redirect is refused.
  assert.deepEqual(seen,['https://media.twiliocdn.com/again']);
  assert(authorized.length>0&&authorized.every(host=>host==='api.twilio.com'),'credentials only ever reach api.twilio.com');
});

test('managed service exposes the three reads over the socket, keeps stable error codes, reports calls access and journals nothing',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'ez-twilio-calls-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const sim=twilio({calls:[callRow(1,'2026-10-24T10:00:00Z'),callRow(2,'2026-10-24T11:00:00Z',{to:lineB})],recordings:[recRow(1,1),recRow(2,1)],
    media:{[recSid(1)]:()=>audio('wav bytes','audio/x-wav'),[recSid(2)]:()=>audio(new Uint8Array(2.5*1024*1024+1))}});
  const socketPath=join(directory,'service.sock');
  const running=await serve({directory,socketPath,provider:connection=>new Provider(connection,{fetch:sim.fetch}),now:()=>NOW});t.after(()=>running.close());
  const cli=(args,stdin)=>main(args,{socketPath,stdin:Readable.from([JSON.stringify(stdin??{})])});
  await cli(['init'],{accountSid,authToken:'2'.repeat(32),senders:[lineA,lineB],startAt});
  const help=await cli(['--help']);assert.equal(help.commands.filter(command=>/^(calls|recordings|recording) /.test(command)).length,3);
  const head=running.store.head();
  assert.deepEqual(await cli(['doctor']).then(({sms,calls})=>({sms,calls})),{sms:true,calls:true});
  const page=await cli(['calls','--after','2026-10-24T00:00:00Z','--limit','1']);
  assert.deepEqual(page.calls.map(row=>row.sid),[callSid(1)]);assert.equal(page.complete,false);
  const rest=await cli(['calls','--after',page.calls[0].startTime]);assert.deepEqual(rest.calls.map(row=>row.sid),[callSid(1),callSid(2)]);assert.equal(rest.complete,true);
  assert.equal((await cli(['recordings','--call',callSid(1)])).recordings.length,2);
  const media=await cli(['recording','--sid',recSid(1),'--format','wav']);assert.equal(Buffer.from(media.data,'base64').toString(),'wav bytes');
  await assert.rejects(cli(['recording','--sid',recSid(2)]),error=>error.code==='RECORDING_TOO_LARGE'&&error.exitCode===4);
  await assert.rejects(cli(['recordings','--call',callSid(9)]),error=>error.code==='NOT_FOUND');
  for(const args of [['calls'],['calls','--after','yesterday'],['calls','--after','2026-10-24T00:00:00Z','--limit','101'],['recordings','--call','CA123'],['recording','--sid','x'],['recording','--sid',recSid(1),'--format','ogg']])
    await assert.rejects(cli(args),error=>error.code==='INVALID_INPUT',args.join(' '));
  assert.equal(running.store.status().messages,0);assert.equal(running.store.head(),head);
  sim.denied.add('Calls');
  const doctor=await cli(['doctor']);assert.equal(doctor.sms,true);assert.equal(doctor.calls,false);
});

test('calls say why Twilio failed a call, from its first error notification, and read nothing for other calls',async()=>{
  const out=(n,status)=>callRow(n,'2026-10-24T10:0'+n+':00Z',{from:lineA,to:remote,direction:'outbound-api',status,duration:'0'});
  const note=(n,code,log)=>({sid:`NO${String(n).padStart(32,'0')}`,account_sid:accountSid,call_sid:callSid(n),error_code:code,log});
  const sim=twilio({calls:[out(1,'failed'),out(2,'no-answer'),out(3,'failed'),out(4,'canceled')],
    notifications:{[callSid(1)]:[note(1,'21212','1'),note(1,'32009','0')]}});
  const result=await calls(sim.provider(single),single,{after:'2026-10-24T00:00:00.000Z'},NOW);
  assert.deepEqual(result.calls.map(row=>[row.status,row.errorCode]),[['failed',32009],['no-answer',null],['failed',null],['canceled',null]]);
  const read=sim.requests.filter(r=>r.pathname.endsWith('/Notifications.json')).map(r=>r.pathname.split('/')[5]);
  assert.deepEqual(read,[callSid(1),callSid(3)]);
});
