import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { chronological, serializeJournal, downloadJournal } from '../lib/journal-export.js';
import { filterRuntimeLogs, formatRuntimeLogs, sortRuntimeLogs } from '../lib/runtime-logs.js';

const source=fs.readFileSync(new URL('../tools.js',import.meta.url),'utf8').replace(/^import[\s\S]*?;\n/gm,'');
async function harness(namespace='mock-runtime') {
  const data={namespace,logs:[],events:[],hold:null,failExport:false,exports:[],calls:[]};
  const nodes=new Map();
  const node=()=>({value:'',dataset:{},children:[],listeners:{},classList:{add(){},remove(){}},
    addEventListener(name,fn){this.listeners[name]=fn;},append(...items){this.children.push(...items);},
    replaceChildren(...items){this.children=items;},focus(){}});
  const document={hidden:true,getElementById(id){if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);},
    createElement:node,addEventListener(){},removeEventListener(){}};
  const api=new Proxy({},{get:(_,key)=>async()=>{
    data.calls.push(key);
    if(key==='getLogs'){
      const snapshot={event_namespace:data.namespace,entries:data.logs.slice()};
      if(data.hold)await data.hold;
      return snapshot;
    }
    if(key==='getEvents')return {event_namespace:data.namespace,events:data.events};
    if(key==='getReadiness')return {status:'ready',checks:[]};
    assert.ok(key.startsWith('get'),'observation controls must not mutate the runtime');
    return {};
  }});
  const context=vm.createContext({document,console,chronological,filterRuntimeLogs,formatRuntimeLogs,sortRuntimeLogs,
    downloadJournal:(rows,json,name)=>{if(data.failExport)throw new Error('mock-secret');data.exports.push({rows:JSON.parse(JSON.stringify(rows)),json,name});},
    window:{setInterval(){},clearInterval(){},setTimeout(){},addEventListener(){}},
    chrome:{runtime:{onMessage:{addListener(){}},sendMessage:async()=>{throw new Error('mock stream unavailable');}}},
    SpikeApiClient:api,StorageManager:{init:async()=>{},getActiveInstance:async()=>({id:'mock-instance',baseUrl:'https://example.test',secret:'mock-secret'})},
    initializeI18n:async()=>{},t:value=>value});
  await vm.runInContext(`(async()=>{${source}})()`,context);
  return {data,nodes,click:id=>nodes.get(id).listeners.click(),input:(id,value)=>{document.getElementById(id).value=value;nodes.get(id).listeners.input();},
    change:(id,value)=>{document.getElementById(id).value=value;nodes.get(id).listeners.change();}};
}
const makeLog=(id,message)=>({event_namespace:'mock-runtime',sequence:id,occurred_at_unix_ms:id*1000,level:'info',target:'mock.runtime',message,fields:{mock:id}});
const makeEvent=(id,summary)=>({sequence:id,occurred_at_unix_ms:id*1000,kind:'mock.event',category:'runtime',severity:'info',summary,data:{mock:[id,true]},action:{target:'groups',label:'Mock action'}});
const page=await harness();const {data,nodes,click,input,change}=page;
data.logs=[makeLog(1,'Mock Alpha'),makeLog(2,'Mock Beta'),makeLog(3,'Mock Alpha hidden')];
data.events=[makeEvent(1,'Mock First'),makeEvent(2,'Mock Second')];
await click('logs-refresh');await click('events-refresh');
input('logs-filter','alpha');input('logs-filter-exclude','hidden');
assert.equal(nodes.get('logs-filter-count').textContent,'1 / 3');
click('logs-export-jsonl');assert.deepEqual(data.exports.at(-1).rows,[data.logs[0]]);
click('logs-filter-clear');click('logs-pause');click('events-pause');
data.logs.push(makeLog(4,'Mock Fourth'));data.events.push(makeEvent(3,'Mock Third'));
await click('logs-refresh');await click('events-refresh');
assert.equal(nodes.get('logs-filter-count').textContent,'3 / 3');
assert.equal(nodes.get('events-filter-count').textContent,'2 / 2');
click('logs-view-clear');click('logs-pause');
assert.match(nodes.get('logs-output').textContent,/Mock Fourth/);
assert.equal(nodes.get('logs-filter-count').textContent,'1 / 1');
click('events-pause');change('events-sort','asc');click('events-export-jsonl');
assert.deepEqual(data.exports.at(-1).rows.map(row=>row.sequence),[1,2,3]);
assert.deepEqual(data.exports.at(-1).rows[0].data,{mock:[1,true]});
click('events-view-clear');await click('events-refresh');
assert.equal(nodes.get('events-filter-count').textContent,'0 / 0');
assert.match(nodes.get('logs-output').textContent,/Mock Fourth/);
assert.equal(data.events.length,3,'view clears must not mutate the Core snapshot');
click('logs-pause');
let release;data.hold=new Promise(resolve=>{release=resolve;});
const stale=click('logs-refresh');
data.namespace='mock-next';data.events=[makeEvent(1,'Mock New Event')];
data.logs=[{...makeLog(1,'Mock New Runtime'),event_namespace:'mock-next'}];
await click('events-refresh');release();await stale;data.hold=null;
await click('logs-refresh');
assert.match(nodes.get('logs-output').textContent,/Mock New Runtime/);
assert.doesNotMatch(nodes.get('logs-output').textContent,/Mock Fourth/);
assert.equal(nodes.get('logs-pause').textContent,'暂停观察');
data.failExport=true;click('logs-export-text');assert.doesNotMatch(nodes.get('notice').textContent,/mock-secret/);
assert.match(nodes.get('notice').textContent,/无法导出/);
const empty=await harness('');empty.click('logs-pause');
empty.data.namespace='mock-first';empty.data.logs=[{...makeLog(1,'Mock Arrival'),event_namespace:'mock-first'}];
await empty.click('logs-refresh');assert.doesNotMatch(empty.nodes.get('logs-output').textContent,/Mock Arrival/);
empty.click('logs-pause');assert.match(empty.nodes.get('logs-output').textContent,/Mock Arrival/);
const legacy=await harness('');legacy.data.logs=[{...makeLog(1,'Mock Legacy'),event_namespace:undefined}];
await legacy.click('logs-refresh');legacy.click('logs-pause');
legacy.data.namespace='mock-named';legacy.data.logs=[{...makeLog(1,'Mock Named'),event_namespace:'mock-named'}];
await legacy.click('logs-refresh');assert.match(legacy.nodes.get('logs-output').textContent,/Mock Named/);
assert.doesNotMatch(legacy.nodes.get('logs-output').textContent,/Mock Legacy/);

const records=[makeEvent(2,'Mock Second'),makeEvent(1,'Mock First')];
assert.deepEqual(serializeJournal(records,true).trim().split('\n').map(line=>JSON.parse(line)),[records[1],records[0]]);
assert.match(serializeJournal([makeLog(1,'Mock raw\ncontinued')],false),/1970-01-01T00:00:01.000Z INFO mock.runtime Mock raw\n    continued/);
const originalDocument=globalThis.document,create=URL.createObjectURL,revoke=URL.revokeObjectURL;
let removed=false,revoked=false,blob;
try{
  globalThis.document={body:{appendChild(){}},createElement:()=>({click(){},remove(){removed=true;}})};
  URL.createObjectURL=value=>{blob=value;return 'mock-blob';};URL.revokeObjectURL=()=>{revoked=true;};
  downloadJournal(records,true,'mock-events');await new Promise(resolve=>setTimeout(resolve,0));
  assert.ok(removed&&revoked);assert.deepEqual(JSON.parse((await blob.text()).split('\n')[0]),records[1]);
}finally{globalThis.document=originalDocument;URL.createObjectURL=create;URL.revokeObjectURL=revoke;}
console.log('Actual Tools journal controls retain frozen views, independent clear floors, original exports, namespace boundaries, bounded reads and safe failures');
