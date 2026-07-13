'use strict';

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const url = process.env.WS_URL || 'ws://127.0.0.1:7799/';
const key = process.env.WS_KEY || 'test123';

function hash(content) {
  let value = 5381;
  for (let i = 0; i < content.length; i++) value = ((value * 33) ^ content.charCodeAt(i)) >>> 0;
  return value.toString(36);
}

function unauthenticatedSocketIsClosed() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('unauthenticated socket timeout')); }, 4000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'open', name: 'Birinci' })));
    ws.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 4001) reject(new Error(`unexpected unauthenticated close code: ${code}`));
      else resolve();
    });
    ws.on('error', reject);
  });
}

function offlineDraftRoundTrip() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const name = 'Offline Yeni';
    const content = 'offline taslak guvenle geri geldi';
    let sent = false, saved = false, listed = false;
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('offline draft timeout')); }, 6000);
    const done = () => {
      if (!saved || !listed) return;
      clearTimeout(timer); ws.close(); resolve();
    };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', key })));
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'session' && !sent) {
        sent = true;
        ws.send(JSON.stringify({ type: 'edit-safe', name, content, base: hash('') }));
      }
      if (message.type === 'saved' && message.name === name && message.hash === hash(content)) saved = true;
      if (message.type === 'list' && Array.isArray(message.notes) && message.notes.includes(name)) listed = true;
      done();
    });
    ws.on('error', reject);
  });
}

function renameKeepsPendingEdit() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const from = 'Offline Yeni';
    const to = 'Offline Yeniden';
    const content = 'pending edit survives rename';
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('rename pending edit timeout')); }, 6000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', key })));
    ws.on('message', async (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== 'session') return;
      ws.send(JSON.stringify({ type: 'edit', name: from, content }));
      await new Promise((done) => setTimeout(done, 25));
      try {
        const httpBase = url.replace(/^ws/, 'http').replace(/\/$/, '');
        const rename = await fetch(`${httpBase}/api/note/${encodeURIComponent(from)}`, {
          method: 'PATCH',
          headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: to }),
        });
        if (!rename.ok) throw new Error(await rename.text());
        const read = await fetch(`${httpBase}/api/note/${encodeURIComponent(to)}`, { headers: { 'X-Api-Key': key } });
        const savedContent = await read.text();
        if (!read.ok || savedContent !== content) throw new Error(`pending edit lost: ${savedContent}`);
        clearTimeout(timer); ws.close(); resolve();
      } catch (error) { clearTimeout(timer); ws.close(); reject(error); }
    });
    ws.on('error', reject);
  });
}

function externalEditPreservesDraft() {
  const notesDir = process.env.WS_NOTES_DIR;
  if (!notesDir) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const name = 'Birinci';
    const localContent = 'browser pending draft';
    const externalContent = 'external editor content';
    let conflictCopy = '', externalSeen = false;
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('external conflict timeout')); }, 7000);
    const done = () => {
      if (!conflictCopy || !externalSeen) return;
      const copyPath = path.join(notesDir, conflictCopy + '.md');
      if (!fs.existsSync(copyPath) || fs.readFileSync(copyPath, 'utf8') !== localContent) {
        clearTimeout(timer); ws.close(); reject(new Error('browser draft conflict copy missing')); return;
      }
      clearTimeout(timer); ws.close(); resolve();
    };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', key })));
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'session') {
        ws.send(JSON.stringify({ type: 'edit', name, content: localContent }));
        setTimeout(() => fs.writeFileSync(path.join(notesDir, name + '.md'), externalContent), 40);
      }
      if (message.type === 'conflict' && message.name === name) conflictCopy = message.copy;
      if (message.type === 'content' && message.name === name && message.content === externalContent) externalSeen = true;
      done();
    });
    ws.on('error', reject);
  });
}

(async () => {
  await unauthenticatedSocketIsClosed();
  await offlineDraftRoundTrip();
  await renameKeepsPendingEdit();
  await externalEditPreservesDraft();
  console.log('ws-offline-tamam');
})().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
