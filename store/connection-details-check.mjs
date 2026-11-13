import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const tools = (await readFile(resolve(root, 'tools.js'), 'utf8')).replace(/^import[\s\S]*?;\n/gm, '');
const html = `<!doctype html><body><script type="module">
import { chronological } from '/lib/journal-export.js';
import { PanelObservation } from '/lib/panels.js';
import { ThroughputSession } from '/lib/throughput.js';
import { connectionDetailFields, connectionMethod } from '/lib/connection-trace.js';
const getElement = document.getElementById.bind(document);
document.getElementById = id => {
 let node = getElement(id);
 if (!node) {node=document.createElement(id==='connections'?'tbody':'div');node.id=id;node.value='';document.body.append(node);}
 return node;
};
window.setInterval=()=>0;
window.chrome={runtime:{onMessage:{addListener(){}},sendMessage:async()=>{throw new Error('mock stream unavailable')}}};
const mockInstance={id:'mock-instance',baseUrl:'https://example.test',secret:'mock-secret'};
const item={id:11,host:'example.test',peer:'192.0.2.1',port:443,kind:'tcp',ok:true};
window.mockSnapshot={live:[item],recent:[]};
const SpikeApiClient=new Proxy({},{get:(_,key)=>key==='getConnections'?async()=>window.mockSnapshot:async()=>({})});
const StorageManager={init:async()=>{},getActiveInstance:async()=>mockInstance};
const initializeI18n=async()=>{},t=value=>value,confirmAction=async()=>true;
const formatConnectionTrace=()=>'',filterRuntimeLogs=entries=>entries,sortRuntimeLogs=entries=>entries,formatRuntimeLogs=()=>'';
${tools}
window.refreshMockConnections=loadConnections;
window.rerenderMockConnections=renderConnections;
window.restoreMockConnection=()=>{window.mockSnapshot={live:[item],recent:[]};return loadConnections();};
window.mockReady=true;
</script>`;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('http://deck.example.test/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
    const path = resolve(root, '.' + pathname);
    assert.ok(path.startsWith(root));
    return route.fulfill({ contentType: extname(path) === '.js' ? 'text/javascript' : 'text/plain', body: await readFile(path) });
  });
  await page.goto('http://deck.example.test/');
  await page.waitForFunction(() => window.mockReady);
  const details = page.locator('#connections details');
  await page.evaluate(() => {
    document.querySelector('#connections summary').click();
    window.rerenderMockConnections();
  });
  assert.equal(await details.evaluate(node => node.open), true, 'opening survives a redraw before toggle');
  await page.evaluate(async () => {
    const item = window.mockSnapshot.live[0];
    window.mockSnapshot = { live: [], recent: [item] };
    await window.refreshMockConnections();
  });
  assert.equal(await details.evaluate(node => node.open), true, 'completion retains expansion');
  await page.evaluate(() => {
    document.querySelector('#connections summary').click();
    window.rerenderMockConnections();
  });
  assert.equal(await details.evaluate(node => node.open), false, 'closing survives a redraw before toggle');
  await details.locator('summary').click();
  await page.evaluate(async () => { window.mockSnapshot = { live: [], recent: [] }; await window.refreshMockConnections(); });
  await page.evaluate(() => window.restoreMockConnection());
  assert.equal(await details.evaluate(node => node.open), false, 'expired IDs start collapsed');
  assert.deepEqual(errors, []);
  console.log('Native details retain expansion across redraw/completion, respect immediate collapse, and prune expired IDs');
} finally {
  await browser.close();
}
