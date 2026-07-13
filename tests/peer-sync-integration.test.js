'use strict';

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const projectDir = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notlar-peer-net-'));
const children = new Set();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function prepareSide(name, port, password) {
  const home = path.join(root, name);
  const data = path.join(home, 'NotlarSync');
  fs.mkdirSync(path.join(data, 'notes'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(data, 'app-config.json'), JSON.stringify({
    mode: 'host', port, password, deviceName: name, otoZihin: false,
  }), { mode: 0o600 });
  return {
    name, home, data, port, password, base: `http://127.0.0.1:${port}`,
    child: null, log: path.join(home, 'server.log'),
  };
}

async function start(side) {
  const fd = fs.openSync(side.log, 'a', 0o600);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: projectDir,
    env: {
      ...process.env,
      HOME: side.home,
      PORT: String(side.port),
      NOTLAR_ADVERTISE_URL: side.base,
      NOTLAR_SYNC_INTERVAL_MS: '250',
      NOTLAR_NO_RUNTIME_START: '1',
    },
    stdio: ['ignore', fd, fd],
  });
  fs.closeSync(fd);
  side.child = child;
  children.add(child);
  child.once('exit', () => children.delete(child));
  await waitFor(async () => {
    const response = await fetch(`${side.base}/api/health`).catch(() => null);
    return response?.ok;
  }, 10000, `${side.name} sunucusu acilmadi`);
  return child;
}

async function stop(side) {
  const child = side.child;
  if (!child || child.exitCode !== null) { side.child = null; return; }
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(3000).then(() => { if (child.exitCode === null) child.kill('SIGKILL'); }),
  ]);
  side.child = null;
}

async function request(side, pathname, options = {}) {
  const headers = { ...(options.headers || {}), 'X-Api-Key': side.password };
  let body = options.body;
  if (body && typeof body !== 'string') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const response = await fetch(side.base + pathname, { ...options, headers, body });
  const text = await response.text();
  if (!response.ok && !options.allowError) throw new Error(`${side.name} ${pathname}: ${response.status} ${text}`);
  return { status: response.status, text, json: () => JSON.parse(text) };
}

async function waitFor(check, timeout, message) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeout) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) { lastError = error; }
    await sleep(100);
  }
  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ''}`);
}

async function waitNote(side, name, expected) {
  return waitFor(async () => {
    const result = await request(side, `/api/note/${encodeURIComponent(name)}`, { allowError: true });
    return result.status === 200 && result.text === expected;
  }, 15000, `${side.name} notu alamadi: ${name}`);
}

async function pair(a, b) {
  const code = (await request(a, '/api/sync/pair/new', { method: 'POST' })).json();
  assert(/^\d{6}$/.test(code.code));
  await request(b, '/api/sync/pair/connect', {
    method: 'POST',
    body: { address: a.base, code: code.code, deviceName: b.name },
  });
  const pending = await waitFor(async () => {
    const list = (await request(a, '/api/sync/pair/pending')).json();
    return list.length ? list : null;
  }, 5000, 'peer onay talebi gelmedi');
  assert.strictEqual(pending[0].peer.name, b.name);
  assert.strictEqual(pending[0].peer.url, b.base);
  await request(a, '/api/sync/pair/approve', { method: 'POST', body: { code: code.code } });
  await waitFor(async () => {
    const sa = (await request(a, '/api/sync/status')).json();
    const sb = (await request(b, '/api/sync/status')).json();
    return sa.peers.length === 1 && sb.peers.length === 1;
  }, 5000, 'iki tarafli peer kaydi olusmadi');
}

async function main() {
  const [portA, portB] = await Promise.all([freePort(), freePort()]);
  assert.notStrictEqual(portA, portB);
  const a = prepareSide('Masaustu', portA, 'masaustu-secret-123');
  const b = prepareSide('Dizustu', portB, 'dizustu-secret-123');

  try {
    await start(a);
    await start(b);
    await pair(a, b);

    // Canli iki yon.
    await request(a, '/api/note/Canli-A', { method: 'POST', body: 'A yazdi' });
    await waitNote(b, 'Canli-A', 'A yazdi');
    await request(b, '/api/note/Canli-B', { method: 'POST', body: 'B yazdi' });
    await waitNote(a, 'Canli-B', 'B yazdi');

    // Duraklatma iki yonu de keser; yerel yazilar silinmez ve surdurulunce gelir.
    const aPeer = (await request(a, '/api/sync/status')).json().peers[0];
    await request(a, '/api/sync/peer/pause', { method: 'POST', body: { id: aPeer.id, paused: true } });
    await request(a, '/api/note/Duraklat-A', { method: 'POST', body: 'A bekleyen' });
    await request(b, '/api/note/Duraklat-B', { method: 'POST', body: 'B bekleyen' });
    await sleep(1400);
    assert.strictEqual((await request(a, '/api/note/Duraklat-B', { allowError: true })).status, 404);
    assert.strictEqual((await request(b, '/api/note/Duraklat-A', { allowError: true })).status, 404);
    await request(a, '/api/sync/peer/pause', { method: 'POST', body: { id: aPeer.id, paused: false } });
    await Promise.all([
      waitNote(a, 'Duraklat-B', 'B bekleyen'),
      waitNote(b, 'Duraklat-A', 'A bekleyen'),
    ]);

    // B kapaliyken A yazar; B geri gelince otomatik alir.
    await stop(b);
    await request(a, '/api/note/B-Kapaliyken', { method: 'POST', body: 'kuyruk A' });
    await start(b);
    await waitNote(b, 'B-Kapaliyken', 'kuyruk A');

    // A kapaliyken B yazar; A geri gelince otomatik alir.
    await stop(a);
    await request(b, '/api/note/A-Kapaliyken', { method: 'POST', body: 'kuyruk B' });
    await start(a);
    await waitNote(a, 'A-Kapaliyken', 'kuyruk B');

    // Iki taraf ayni ortak tabandan kopup ayni notu farkli degistirir.
    await request(a, '/api/note/Ortak', { method: 'POST', body: 'ortak taban' });
    await waitNote(b, 'Ortak', 'ortak taban');
    await stop(b);
    await request(a, '/api/note/Ortak', { method: 'POST', body: 'masaustu offline' });
    await stop(a);
    await start(b);
    await request(b, '/api/note/Ortak', { method: 'POST', body: 'dizustu offline' });
    await start(a);
    await waitFor(async () => {
      const la = (await request(a, '/api/notes')).json();
      const lb = (await request(b, '/api/notes')).json();
      const ca = la.find((name) => name.startsWith('Ortak - çakışma '));
      const cb = lb.find((name) => name.startsWith('Ortak - çakışma '));
      if (!ca || ca !== cb) return false;
      const [mainA, mainB, copyA, copyB] = await Promise.all([
        request(a, '/api/note/Ortak'), request(b, '/api/note/Ortak'),
        request(a, `/api/note/${encodeURIComponent(ca)}`), request(b, `/api/note/${encodeURIComponent(cb)}`),
      ]);
      return mainA.text === mainB.text && copyA.text === copyB.text && mainA.text !== copyA.text;
    }, 20000, 'eszamanli cakisma iki tarafta birlesmedi');

    // Nedensel silme tombstone olarak yayilir ve yeniden dirilmez.
    await request(a, '/api/note/Silinecek', { method: 'POST', body: 'gecici' });
    await waitNote(b, 'Silinecek', 'gecici');
    await stop(b);
    await request(a, '/api/note/Silinecek', { method: 'DELETE' });
    await start(b);
    await waitFor(async () => {
      const result = await request(b, '/api/note/Silinecek', { allowError: true });
      return result.status === 404;
    }, 15000, 'silme tombstone ile yayilmadi');

    const statusText = (await request(a, '/api/sync/status')).text;
    assert(!statusText.includes('outboundToken'));
    assert(!statusText.includes('inboundTokenHash'));
    assert.strictEqual(fs.statSync(path.join(a.data, 'sync')).mode & 0o777, 0o700);
    assert.strictEqual(fs.statSync(path.join(a.data, 'sync', 'peers.json')).mode & 0o777, 0o600);
    console.log('peer-sync-integration: ok');
  } catch (error) {
    for (const side of [a, b]) {
      try {
        if (side.child && side.child.exitCode === null) {
          const sync = await request(side, '/api/sync/status', { allowError: true });
          console.error(`--- ${side.name} sync ---\n${sync.text}`);
        }
      } catch {}
      try {
        const log = fs.readFileSync(side.log, 'utf8');
        console.error(`--- ${side.name} log ---\n${log.slice(-5000)}`);
      } catch {}
    }
    throw error;
  } finally {
    await Promise.all([stop(a), stop(b)]);
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
}).finally(() => {
  for (const child of children) try { child.kill('SIGKILL'); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
});
