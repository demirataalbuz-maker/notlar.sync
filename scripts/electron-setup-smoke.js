'use strict';

const fs = require('fs');

const port = Number(process.env.CDP_PORT || 9224);
const output = process.env.SETUP_SHOT || '/tmp/notlar-sync-ui-shots/electron-setup.png';

async function main() {
  const targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json());
  const target = targets.find((item) => item.type === 'page' && item.url.includes('/public/setup.html'));
  if (!target) throw new Error('Setup target not found');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result);
  };
  const send = (method, params = {}) => {
    const requestId = ++id;
    const promise = new Promise((resolve, reject) => pending.set(requestId, { resolve, reject }));
    ws.send(JSON.stringify({ id: requestId, method, params }));
    return promise;
  };
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  await send('Runtime.enable');
  const state = await evaluate(`(async () => ({
    nodeHidden: typeof require === 'undefined' && typeof process === 'undefined',
    apiPresent: typeof setupApi === 'object',
    methods: Object.keys(setupApi || {}).sort(),
    status: await setupApi.status(),
    configPathLeaked: new URLSearchParams(location.search).has('config'),
    csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content || ''
  }))()`);
  const required = ['done', 'pairApprove', 'pairClaim', 'pairStatus', 'patchConfig', 'status'];
  if (!state.nodeHidden || !state.apiPresent || state.configPathLeaked
    || !required.every((method) => state.methods.includes(method)) || !state.csp.includes("script-src 'self'")) {
    throw new Error(`Setup preload validation failed: ${JSON.stringify(state)}`);
  }
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.mkdirSync(require('path').dirname(output), { recursive: true });
  fs.writeFileSync(output, Buffer.from(shot.data, 'base64'));
  console.log(JSON.stringify({ ok: true, state, output }, null, 2));
  ws.close();
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
