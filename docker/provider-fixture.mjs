// Synthetic provider substituted only in the disposable manager smoke snapshot.
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
const path='/state/twilio/synthetic-provider.json';
const accountSid=`AC${'1'.repeat(32)}`,sender='+15551230001',remote='+15551230002';
const sid=n=>`SM${String(n).padStart(32,'0')}`;
const row=(n,body,from=remote,to=sender)=>({sid:sid(n),account_sid:accountSid,from,to,body,direction:from===sender?'outbound-api':'inbound',status:from===sender?'delivered':'received',num_media:'0',date_created:new Date().toUTCString(),date_sent:new Date().toUTCString(),date_updated:new Date().toUTCString(),error_code:null});
const load=()=>existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{rows:[],creates:0,boots:0};
const save=value=>writeFileSync(path,JSON.stringify(value));
export class Provider {
 constructor(connection){this.connection=connection;const state=load();state.boots++;if(!state.rows.length)state.rows.push(row(1,'Synthetic incoming'));else if(state.boots===2)state.rows.push(row(4,'Synthetic downtime reply'));save(state);}
 listPath(direction){return direction;}
 async page(direction){return {messages:load().rows.filter(r=>(r.direction==='inbound')===(direction==='inbound')),next:null};}
 async doctor(){return {accountSid,sender,sms:true};}
 async create(payload){const state=load();state.creates++;const sent=row(2,payload.text,sender,payload.to);state.rows.push(sent,row(3,'Synthetic answer'));save(state);return sent;}
 async get(id){return load().rows.find(row=>row.sid===id);}
}
// Keep production normalization unchanged; the only substituted boundary is HTTP.
export {message} from './message-production.mjs';
