#!/usr/bin/env node
// Notlar Sync MCP sunucusu: AI ajanlarina (Claude Code vb.) uygulamayi
// RESMI arac seti olarak tanitir - curl ezberi biter. stdio uzerinden
// newline-ayrimli JSON-RPC (MCP stdio tasima katmani), sifir bagimlilik.
//
// Kayit: claude mcp add --scope user notlar -- node /path/to/mcp.js
// Calisma sekli: araclar yerel uygulamanin HTTP API'sine (7777) baglanir;
// parola app-config.json'dan okunur. Uygulama kapaliysa araclar bunu soyler.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), 'NotlarSync', 'app-config.json'), 'utf8')); }
  catch { return {}; }
})();
const KEY = CONFIG.password || '';
const BASE = 'http://127.0.0.1:' + (process.env.NOTLAR_PORT || 7777);

function api(pathname, { method = 'GET', json = null, raw = null, query = {} } = {}, cb) {
  const u = new URL(BASE + pathname);
  if (KEY) u.searchParams.set('key', KEY);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  const data = json ? JSON.stringify(json) : raw;
  const req = http.request(u, {
    method, timeout: 180000,
    headers: data ? { 'Content-Type': json ? 'application/json' : 'text/plain', 'Content-Length': Buffer.byteLength(data) } : {},
  }, (res) => {
    let d = '';
    res.on('data', (c) => d += c);
    res.on('end', () => cb(res.statusCode >= 400 ? `HTTP ${res.statusCode}: ${d}` : null, d));
  });
  req.on('error', (e) => cb(e.code === 'ECONNREFUSED'
    ? 'Notlar Sync uygulamasi acik degil - once uygulamayi (ya da `node server.js`) baslat' : e.message));
  req.on('timeout', () => { req.destroy(); cb('zaman asimi'); });
  req.end(data);
}

const guzel = (d) => { try { return JSON.stringify(JSON.parse(d), null, 1); } catch { return d; } };

const TOOLS = [
  { name: 'notlari_listele', description: 'Tum notlarin adlarini listeler.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'not_oku', description: 'Bir notun tam icerigini dondurur.',
    inputSchema: { type: 'object', properties: { ad: { type: 'string', description: 'not adi' } }, required: ['ad'] } },
  { name: 'not_yaz', description: 'Nota yazar (yoksa olusturur). ekle=true ile sona ekler. AI-Hafiza loglari icin ekle=true kullan.',
    inputSchema: { type: 'object', properties: { ad: { type: 'string' }, icerik: { type: 'string' }, ekle: { type: 'boolean' } }, required: ['ad', 'icerik'] } },
  { name: 'not_ara', description: 'Not adlarinda VE icinde metin arar, snippet dondurur.',
    inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } },
  { name: 'zihne_sor', description: 'GraphRAG: soruyu bilgi grafinda gezer, ilgili notlari toplar, local AI ile cevaplar. Tum notlari okumaktan cok daha token-verimli hafiza sorgusu.',
    inputSchema: { type: 'object', properties: { soru: { type: 'string' } }, required: ['soru'] } },
  { name: 'graf_ozet', description: 'Zihin haritasi grafi: dugumler, kenarlar, obekler (JSON).',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'rapor', description: 'Zihin raporu: graf sagligi, obek butunlugu, sasirtici baglantilar, sorulmaya deger sorular.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'baglanti_oner', description: 'Iki not arasinda baglanti ONERIR. Dogrudan yazilmaz: oneri kuyruga girer, kullanici haritada kabul/ret eder. Reddedilmis cift tekrar onerilemez.',
    inputSchema: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' }, neden: { type: 'string' } }, required: ['a', 'b', 'neden'] } },
];

function callTool(name, a, cb) {
  switch (name) {
    case 'notlari_listele': return api('/api/notes', {}, (e, d) => cb(e, guzel(d)));
    case 'not_oku': return api('/api/note/' + encodeURIComponent(a.ad), {}, cb);
    case 'not_yaz': return api('/api/note/' + encodeURIComponent(a.ad),
      { method: 'POST', raw: a.icerik, query: a.ekle ? { append: '1' } : {} }, cb);
    case 'not_ara': return api('/api/search', { query: { q: a.q } }, (e, d) => cb(e, guzel(d)));
    case 'zihne_sor': return api('/api/graph/query', { query: { q: a.soru, gizli: '1' } }, (e, d) => cb(e, guzel(d)));
    case 'graf_ozet': return api('/api/graph', { query: { gizli: '1' } }, (e, d) => cb(e, guzel(d)));
    case 'rapor': return api('/api/graph/rapor', { query: { gizli: '1' } }, (e, d) => cb(e, guzel(d)));
    case 'baglanti_oner': return api('/api/graph/oner',
      { method: 'POST', json: { a: a.a, b: a.b, neden: a.neden } }, (e, d) => cb(e, guzel(d)));
    default: return cb('bilinmeyen arac: ' + name);
  }
}

// --- MCP stdio dongusu: satir satir JSON-RPC ---
const yaz = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const satir = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (satir) isle(satir);
  }
});

function isle(satir) {
  let m;
  try { m = JSON.parse(satir); } catch { return; }
  if (m.method === 'initialize')
    return yaz({ jsonrpc: '2.0', id: m.id, result: {
      protocolVersion: (m.params && m.params.protocolVersion) || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'notlar-sync', version: '1.0.0' },
    } });
  if (m.method === 'notifications/initialized' || m.method === 'notifications/cancelled') return;
  if (m.method === 'ping') return yaz({ jsonrpc: '2.0', id: m.id, result: {} });
  if (m.method === 'tools/list')
    return yaz({ jsonrpc: '2.0', id: m.id, result: { tools: TOOLS } });
  if (m.method === 'tools/call') {
    const { name, arguments: args } = m.params || {};
    return callTool(name, args || {}, (err, text) =>
      yaz({ jsonrpc: '2.0', id: m.id, result: {
        content: [{ type: 'text', text: err ? String(err) : String(text) }],
        isError: !!err,
      } }));
  }
  if (m.id !== undefined)
    yaz({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'desteklenmeyen metod: ' + m.method } });
}
