import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { chronological } from '../lib/journal-export.js';
import { PanelObservation } from '../lib/panels.js';
import { ThroughputSession } from '../lib/throughput.js';
import { routeContext } from '../lib/route-context.js';

const nodes = new Map();
const node = () => ({value:'',dataset:{},children:[],classList:{add(){},remove(){}},listeners:{},
  addEventListener(name,fn){this.listeners[name]=fn;},append(...items){this.children.push(...items);},
  replaceChildren(...items){this.children=items;}});
const document = {hidden:true,getElementById(id){if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);},
  createElement:node,addEventListener(){},removeEventListener(){}};
const requests=[];
const context = vm.createContext({document,console,URL,routeContext,
  window:{setInterval(){},clearInterval(){},setTimeout(){},addEventListener(){}},
  chrome:{runtime:{onMessage:{addListener(){}},sendMessage:async()=>{throw new Error('mock stream unavailable');}}},
  StorageManager:{init:async()=>{},getActiveInstance:async()=>({baseUrl:'https://example.test',secret:'mock-secret'})},
  SpikeApiClient:new Proxy({},{get:(_,key)=>key==='explainRoute'?async(_,body)=>{requests.push(body);return {ok:true};}:async()=>({})}),
  initializeI18n:async()=>{},t:value=>value,filterRuntimeLogs:entries=>entries,sortRuntimeLogs:entries=>entries,formatRuntimeLogs:()=>''
});
const source=fs.readFileSync(new URL('../tools.js',import.meta.url),'utf8').replace(/^import[\s\S]*?;\n/gm,'');
context.chronological = chronological;
context.PanelObservation = PanelObservation;
context.ThroughputSession = ThroughputSession;
await vm.runInContext(`(async()=>{${source}})()`,context);
const values={'route-host':'example.test','route-port':'443','route-protocol':'TCP',
  'route-source':'192.0.2.1','route-source-port':'5300','route-in-port':'19001','route-destination':'2001:db8::2',
  'route-url':'https://example.test/mock','route-user-agent':'mock-agent','route-process-name':'mock-service',
  'route-process-path':'/mock-bin/mock-service','route-process-cgroup':'/mock-group'};
const html=fs.readFileSync(new URL('../tools.html',import.meta.url),'utf8');
for(const [id,value] of Object.entries(values)){
  assert.match(html,new RegExp(`id="${id}"`));
  document.getElementById(id).value=value;
}
const submit=()=>nodes.get('route-form').listeners.submit({preventDefault(){}});
await submit();
assert.deepEqual(JSON.parse(JSON.stringify(requests[0])),{host:'example.test',port:443,protocol:'TCP',source_ip:'192.0.2.1',
  source_port:5300,in_port:19001,destination_ip:'2001:db8::2',url:'https://example.test/mock',user_agent:'mock-agent',
  process_name:'mock-service',process_path:'/mock-bin/mock-service',process_cgroup:'/mock-group'});
for(const id of Object.keys(values).filter(id=>!['route-host','route-port','route-protocol'].includes(id)))nodes.get(id).value='';
await submit();assert.deepEqual(JSON.parse(JSON.stringify(requests[1])),{host:'example.test',port:443,protocol:'TCP'});
for(const [id,value] of [['route-source-port','0'],['route-in-port','65536'],['route-source','mock-secret'],['route-user-agent','mock-secret\nmock']]){
  nodes.get(id).value=value;await submit();assert.equal(requests.length,2);
  assert.doesNotMatch(nodes.get('notice').textContent,/mock-secret/);nodes.get(id).value='';
}
console.log('Actual route submit includes all typed metadata, omits empty fields and rejects invalid input without echoing it');
