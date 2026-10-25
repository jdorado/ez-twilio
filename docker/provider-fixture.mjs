// Synthetic provider substituted only in the disposable manager smoke snapshot.
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {senders} from './validation.mjs';
const path='/state/twilio/synthetic-provider.json';
const accountSid=`AC${'1'.repeat(32)}`,sender='+15551230001',remote='+15551230002';
const sid=n=>`SM${String(n).padStart(32,'0')}`;
const row=(n,body,from=remote,to=sender,direction='inbound')=>({sid:sid(n),account_sid:accountSid,from,to,body,direction,status:direction==='inbound'?'received':'delivered',num_media:'0',date_created:new Date().toUTCString(),date_sent:new Date().toUTCString(),date_updated:new Date().toUTCString(),error_code:null});
const load=()=>existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{rows:[],creates:0,boots:0};
const save=value=>writeFileSync(path,JSON.stringify(value));
export class Provider {
 constructor(connection){this.connection=connection;const state=load(),numbers=senders(connection);state.boots++;if(!state.rows.length)numbers.forEach((number,n)=>state.rows.push(row(n+1,'Synthetic incoming',remote,number)));else if(state.boots===2)state.rows.push(row(9000,'Synthetic downtime reply',remote,numbers.at(-1)));save(state);}
 listPath(direction,start,end,from){return JSON.stringify({direction,from});}
 async page(path){const {direction,from}=JSON.parse(path);return {messages:load().rows.filter(r=>direction==='inbound'?r.direction==='inbound'&&r.to===from:r.direction!=='inbound'&&r.from===from),next:null};}
 async doctor(){return {accountSid,senders:senders(this.connection),sms:true};}
 async create(payload){const state=load();state.creates++;const sent=row(100+state.creates*2,payload.text,payload.from,payload.to,'outbound-api');state.rows.push(sent,row(101+state.creates*2,'Synthetic answer',payload.to,payload.from));save(state);return sent;}
 async get(id){return load().rows.find(row=>row.sid===id);}
}
// Keep production normalization unchanged; the only substituted boundary is HTTP.
export {message} from './message-production.mjs';
