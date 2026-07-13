#!/usr/bin/env node
// Notlar Sync MCP sunucusu: AI ajanlarina (Claude Code vb.) uygulamayi
// RESMI arac seti olarak tanitir - curl ezberi biter. Protokol yasam dongusu
// resmi @modelcontextprotocol/sdk ile yurur; araclar yerel REST API'ye baglanir.
//
// Kayit: claude mcp add --scope user notlar -- node /path/to/mcp.js
// Calisma sekli: araclar yerel uygulamanin HTTP API'sine (7777) baglanir;
// parola app-config.json'dan okunur. Uygulama kapaliysa araclar bunu soyler.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { Server: McpProtocolServer } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const CONFIG = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), 'NotlarSync', 'app-config.json'), 'utf8')); }
  catch { return {}; }
})();
const KEY = CONFIG.password || '';
let APP_VERSION = '1.0.0';
try { APP_VERSION = require('./package.json').version; } catch {}
const BASE = process.env.NOTLAR_URL
  || (CONFIG.mode === 'client' && CONFIG.server
    ? String(CONFIG.server).replace(/\/$/, '')
    : 'http://127.0.0.1:' + (process.env.NOTLAR_PORT || CONFIG.port || 7777));

let serverStarting = null;
function startLocalServer() {
  if (serverStarting) return serverStarting;
  serverStarting = new Promise((resolve) => {
    let bridge = {};
    try { bridge = JSON.parse(fs.readFileSync(path.join(os.homedir(), 'NotlarSync', 'integrations', 'bridge-config.json'), 'utf8')); } catch {}
    let url;
    try { url = new URL(BASE); } catch { return resolve(false); }
    if (CONFIG.mode === 'client' || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
      || !Array.isArray(bridge.serverCommand) || !bridge.serverCommand.length) return resolve(false);
    try {
      const [command, ...args] = bridge.serverCommand;
      const child = spawn(command, args, { detached: true, stdio: 'ignore', env: { ...process.env, NOTLAR_AGENT_BACKGROUND: '1' } });
      child.unref();
      setTimeout(() => resolve(true), 1200);
    } catch { resolve(false); }
  }).finally(() => { serverStarting = null; });
  return serverStarting;
}

function api(pathname, { method = 'GET', json = null, raw = null, query = {} } = {}, cb) {
  const send = (retried) => {
    const u = new URL(BASE + pathname);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    const data = json ? JSON.stringify(json) : raw;
    const headers = data ? { 'Content-Type': json ? 'application/json' : 'text/plain', 'Content-Length': Buffer.byteLength(data) } : {};
    if (KEY) headers['X-Api-Key'] = KEY;
    if (!['http:', 'https:'].includes(u.protocol)) return cb('gecersiz Notlar Sync adresi');
    const transport = u.protocol === 'https:' ? require('https') : http;
    const req = transport.request(u, {
      method, timeout: 180000,
      headers,
    }, (res) => {
      let d = '', size = 0;
      res.on('data', (c) => { size += c.length; if (size <= 10e6) d += c; else req.destroy(); });
      res.on('end', () => cb(res.statusCode >= 400 ? `HTTP ${res.statusCode}: ${d}` : null, d));
    });
    req.on('error', (e) => {
      if (e.code === 'ECONNREFUSED' && !retried)
        return startLocalServer().then((started) => started ? send(true) : cb('Notlar Sync uygulamasi acik degil'));
      cb(e.code === 'ECONNREFUSED' ? 'Notlar Sync uygulamasi acik degil' : e.message);
    });
    req.on('timeout', () => { req.destroy(); cb('zaman asimi'); });
    req.end(data);
  };
  send(false);
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
  { name: 'zihne_sor', description: 'GraphRAG: soruyu bilgi grafinda gezer, ilgili notlari toplar, AI ile cevaplar. Tum notlari okumaktan cok daha token-verimli hafiza sorgusu. model="claude" ile bulut modeli (yalniz sunucuda claudeApiKey varsa; gizli:true notlar buluta ASLA gitmez), varsayilan local.',
    inputSchema: { type: 'object', properties: { soru: { type: 'string' }, model: { type: 'string', description: "'local' (varsayilan) ya da 'claude'" } }, required: ['soru'] } },
  { name: 'graf_ozet', description: 'Zihin haritasi grafi: dugumler, kenarlar, obekler (JSON).',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'rapor', description: 'Zihin raporu: graf sagligi, obek butunlugu, sasirtici baglantilar, sorulmaya deger sorular.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'baglanti_oner', description: 'Iki not arasinda baglanti ONERIR. Dogrudan yazilmaz: oneri kuyruga girer, kullanici haritada kabul/ret eder. Reddedilmis cift tekrar onerilemez.',
    inputSchema: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' }, neden: { type: 'string' } }, required: ['a', 'b', 'neden'] } },
  { name: 'oturum_baslat', description: 'HER YENI KONUSMANIN ILK ADIMI. Notlar Sync AI Beyni oturumunu acar ve son checkpoint, kararlar, acik gorevler ve ilgili hafizalardan token-sinirli baslangic baglami dondurur.',
    inputSchema: { type: 'object', properties: {
      sessionId: { type: 'string', description: 'Istemcinin oturum/thread kimligi; yoksa bos birak.' },
      agent: { type: 'string', description: 'codex, claude, gemini vb.' }, client: { type: 'string' },
      workspace: { type: 'string', description: 'Calisilan proje klasorunun tam yolu.' },
      project: { type: 'string', description: 'Projenin okunabilir adi.' }, goal: { type: 'string', description: 'Bu oturumdaki kullanici hedefi.' },
      tokenBudget: { type: 'number', minimum: 500, maximum: 8000 },
    }, required: ['agent', 'workspace'] } },
  { name: 'hatirla', description: 'Bir soru icin kalici hafiza + checkpoint + not aramasi + bilgi grafi + varsa yerel embedding ile en ilgili kaynaklari getirir.',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string' }, workspace: { type: 'string' }, project: { type: 'string' },
      limit: { type: 'number', minimum: 1, maximum: 50 }, tokenBudget: { type: 'number', minimum: 500, maximum: 8000 },
    }, required: ['query'] } },
  { name: 'olay_kaydet', description: 'Oturumdaki anlamli bir karar, gorev, sonuc, hata, tercih veya olguyu kaydeder. Her mesaj icin degil, gelecekte gerekli olacak bilgiler icin kullan.',
    inputSchema: { type: 'object', properties: {
      sessionId: { type: 'string' }, type: { type: 'string', enum: ['action', 'decision', 'task', 'result', 'error', 'preference', 'fact', 'message_summary', 'note'] },
      content: { type: 'string' }, importance: { type: 'number', minimum: 1, maximum: 5 },
      tags: { type: 'array', items: { type: 'string' } }, files: { type: 'array', items: { type: 'string' } }, remember: { type: 'boolean' },
    }, required: ['sessionId', 'type', 'content'] } },
  { name: 'oturum_nabiz', description: 'Uzun calismalarda oturumun halen canli oldugunu ve son etkinligi bildirir; cokme kurtarmasinin yanlis tetiklenmesini engeller.',
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, activity: { type: 'string' } }, required: ['sessionId'] } },
  { name: 'checkpoint_yaz', description: 'Anlamli bir asamadan sonra kalici checkpoint yazar: ne yapildi, dosyalar, kararlar, acik gorevler, riskler ve siradaki kesin adim.',
    inputSchema: { type: 'object', properties: {
      sessionId: { type: 'string' }, title: { type: 'string' }, summary: { type: 'string' },
      completed: { type: 'array', items: { type: 'string' } }, files: { type: 'array', items: { type: 'string' } },
      decisions: { type: 'array', items: { type: 'string' } }, openTasks: { type: 'array', items: { type: 'string' } },
      risks: { type: 'array', items: { type: 'string' } }, nextStep: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } },
    }, required: ['sessionId', 'summary'] } },
  { name: 'oturum_kapat', description: 'Konusma veya gorev biterken SON ISLEM olarak oturumu kapatir ve istege bagli final checkpoint yazar.',
    inputSchema: { type: 'object', properties: {
      sessionId: { type: 'string' }, summary: { type: 'string' }, completed: { type: 'array', items: { type: 'string' } },
      files: { type: 'array', items: { type: 'string' } }, decisions: { type: 'array', items: { type: 'string' } },
      openTasks: { type: 'array', items: { type: 'string' } }, risks: { type: 'array', items: { type: 'string' } },
      nextStep: { type: 'string' }, reason: { type: 'string' },
    }, required: ['sessionId'] } },
  { name: 'hafizaya_al', description: 'Kullanicinin kalici tercihini, proje olgusunu, karari veya gorevi dogrudan yapilandirilmis hafizaya alir. Sifre/token yazma; sistem hassas degerleri yine de redakte eder.',
    inputSchema: { type: 'object', properties: {
      sessionId: { type: 'string' }, workspace: { type: 'string' }, project: { type: 'string' },
      kind: { type: 'string', enum: ['preference', 'fact', 'decision', 'task', 'project', 'person', 'reference'] },
      scope: { type: 'string', enum: ['global', 'project'] }, key: { type: 'string' }, content: { type: 'string' },
      importance: { type: 'number', minimum: 1, maximum: 5 }, status: { type: 'string' }, pinned: { type: 'boolean' }, tags: { type: 'array', items: { type: 'string' } },
    }, required: ['kind', 'content'] } },
  { name: 'hafiza_durumu', description: 'AI Beyninin oturum, checkpoint, karar, tercih ve acik gorev sayilarini; son oturumlari ve son hafizalari getirir.',
    inputSchema: { type: 'object', properties: { workspace: { type: 'string' }, project: { type: 'string' } } } },
  { name: 'hafizalari_listele', description: 'Yapilandirilmis kalici hafizalari proje, tur, durum veya metin sorgusuyla listeler.',
    inputSchema: { type: 'object', properties: {
      workspace: { type: 'string' }, project: { type: 'string' }, q: { type: 'string' }, kind: { type: 'string' }, status: { type: 'string' }, limit: { type: 'number' },
    } } },
  { name: 'hafiza_gercek_yaz', description: 'Zaman farkindalikli kalici GERCEK (fact) yazar: ozne + yuklem + deger. KURALLAR: (1) SADECE kesinlesmis bilgiyi fact olarak yaz; tahmin/cikarim icin assertionType=inferred ve evidenceLevel=unverified kullan. (2) Kaynak ZORUNLU: MCP factinde gercek bir sessionId ve varsa checkpointId/eventId ver; kaynaksiz AI iddiasi otomatik olarak unverified + disputed + en fazla 0.35 guven olur. (3) Kesin ayni slot sistemce supersede edilir; response conflictSuggestions dondururse acik supersedes vermeden otomatik hukum kurma. Oneriyi kullaniciya supersede | dispute | keep-separate olarak sun. (4) Parola, token, anahtar gibi hassas degerleri YAZMA; sistem yine de tum alanlari redakte eder. topic ile slot daraltilabilir.',
    inputSchema: { type: 'object', properties: {
      subject: { type: 'string', description: 'Ozne: kullanici, proje adi, ajan, gorev metni vb.' },
      predicate: { type: 'string', description: 'tercih-eder | kullanir | karar-verdi | durum | sahip | risk veya ozel yuklem' },
      object: { type: 'string', description: 'Deger veya entity.' },
      value: { type: 'string', description: 'Okunabilir aciklama (istege bagli).' },
      topic: { type: 'string', description: 'Cakisma kapsamini daraltan konu (orn. tema, editor).' },
      confidence: { type: 'number', minimum: 0, maximum: 1, description: 'Guven 0-1; varsayilan 0.7.' },
      observedAt: { type: 'string', description: 'Olayin gerceklestigi ISO zaman.' },
      validFrom: { type: 'string', description: 'Bilginin gecerli olmaya basladigi ISO zaman.' },
      dispute: { type: 'boolean', description: 'Celiskili/emin olunmayan bilgi icin true.' },
      assertionType: { type: 'string', enum: ['agent', 'inferred', 'imported', 'system'], description: 'MCP yaziminda varsayilan agent.' },
      evidenceLevel: { type: 'string', enum: ['direct', 'derived', 'unverified'], description: 'Kaniti dogrudan mi, turetilmis mi, dogrulanmamis mi?' },
      supersedes: { type: 'array', items: { type: 'string' }, description: 'Acikca gecersiz kilinacak fact idleri.' },
      agent: { type: 'string', description: 'codex, claude vb.' },
      sessionId: { type: 'string' }, checkpointId: { type: 'string' }, eventId: { type: 'string' },
      noteId: { type: 'string' }, file: { type: 'string' },
      workspace: { type: 'string' }, project: { type: 'string' }, scope: { type: 'string', enum: ['global', 'project'] },
      tags: { type: 'array', items: { type: 'string' } },
    }, required: ['subject', 'predicate', 'object', 'sessionId'] } },
  { name: 'hafiza_gecmisini_sor', description: 'Bir bilginin zaman icindeki degisimini ve kaynagini sorar: "X su an ne kullaniyor?", "X mart ayinda ne kullaniyordu?", "bu karar hangi checkpointten geldi?", "bu bilgi ne zaman gecersiz oldu?". factId verilirse provenance zinciri (kaynak oturum/checkpoint/olay + onceki/sonraki versiyonlar); subject verilirse zaman cizelgesi (timeline); yoksa asOf/includeHistorical ile gecmise donuk recall yapar ve her sonucta whyMatched aciklamasi doner.',
    inputSchema: { type: 'object', properties: {
      factId: { type: 'string', description: 'Provenance zinciri istenen fact idsi.' },
      subject: { type: 'string', description: 'Timeline istenen ozne.' },
      predicate: { type: 'string' },
      query: { type: 'string', description: 'Serbest metin gecmis sorgusu.' },
      asOf: { type: 'string', description: 'Bu ISO tarihte gecerli olan bilgiyi getir.' },
      includeHistorical: { type: 'boolean', description: 'Gecersizlesmis bilgiler de gelsin (varsayilan true).' },
      workspace: { type: 'string' }, project: { type: 'string' },
    } } },
];

function callTool(name, a, cb) {
  switch (name) {
    case 'notlari_listele': return api('/api/notes', {}, (e, d) => cb(e, guzel(d)));
    case 'not_oku': return api('/api/note/' + encodeURIComponent(a.ad), {}, cb);
    case 'not_yaz': return api('/api/note/' + encodeURIComponent(a.ad),
      { method: 'POST', raw: a.icerik, query: a.ekle ? { append: '1' } : {} }, cb);
    case 'not_ara': return api('/api/search', { query: { q: a.q } }, (e, d) => cb(e, guzel(d)));
    case 'zihne_sor': return api('/api/graph/query',
      { query: { q: a.soru, gizli: '1', ...(a.model === 'claude' ? { model: 'claude' } : {}) } }, (e, d) => cb(e, guzel(d)));
    case 'graf_ozet': return api('/api/graph', { query: { gizli: '1' } }, (e, d) => cb(e, guzel(d)));
    case 'rapor': return api('/api/graph/rapor', { query: { gizli: '1' } }, (e, d) => cb(e, guzel(d)));
    case 'baglanti_oner': return api('/api/graph/oner',
      { method: 'POST', json: { a: a.a, b: a.b, neden: a.neden } }, (e, d) => cb(e, guzel(d)));
    case 'oturum_baslat': return api('/api/memory/session/start', { method: 'POST', json: a }, (e, d) => cb(e, guzel(d)));
    case 'hatirla': return api('/api/memory/recall', { method: 'POST', json: a }, (e, d) => cb(e, guzel(d)));
    case 'olay_kaydet': return api('/api/memory/event', { method: 'POST', json: a }, (e, d) => cb(e, guzel(d)));
    case 'oturum_nabiz': return api('/api/memory/session/heartbeat', { method: 'POST', json: a }, (e, d) => cb(e, guzel(d)));
    case 'checkpoint_yaz': return api('/api/memory/checkpoint', { method: 'POST', json: a }, (e, d) => cb(e, guzel(d)));
    case 'oturum_kapat': return api('/api/memory/session/end', { method: 'POST', json: a }, (e, d) => cb(e, guzel(d)));
    case 'hafizaya_al': return api('/api/memory/remember', { method: 'POST', json: a }, (e, d) => cb(e, guzel(d)));
    case 'hafiza_durumu': return api('/api/memory/overview', { query: { workspace: a.workspace || '', project: a.project || '' } }, (e, d) => cb(e, guzel(d)));
    case 'hafizalari_listele': return api('/api/memory/memories', { query: {
      workspace: a.workspace || '', project: a.project || '', q: a.q || '', kind: a.kind || '', status: a.status || '', limit: a.limit || 100,
    } }, (e, d) => cb(e, guzel(d)));
    case 'hafiza_gercek_yaz': return api('/api/memory/facts', { method: 'POST', json: {
      ...a,
      assertionType: a.assertionType || 'agent',
      evidenceLevel: a.evidenceLevel || (a.checkpointId || a.eventId ? 'derived' : 'direct'),
      agent: a.agent || 'mcp-agent',
    } }, (e, d) => cb(e, guzel(d)));
    case 'hafiza_gecmisini_sor':
      if (a.factId) return api('/api/memory/facts/' + encodeURIComponent(a.factId) + '/provenance', {}, (e, d) => cb(e, guzel(d)));
      if (a.subject) return api('/api/memory/timeline', { query: {
        subject: a.subject, predicate: a.predicate || '', project: a.project || '', workspace: a.workspace || '',
      } }, (e, d) => cb(e, guzel(d)));
      return api('/api/memory/recall', { method: 'POST', json: {
        query: a.query || '', asOf: a.asOf || undefined, includeHistorical: a.includeHistorical !== false,
        explain: true, workspace: a.workspace, project: a.project,
      } }, (e, d) => cb(e, guzel(d)));
    default: return cb('bilinmeyen arac: ' + name);
  }
}

const mcpServer = new McpProtocolServer(
  { name: 'notlar-sync', version: APP_VERSION },
  { capabilities: { tools: {} }, instructions: 'Notlar Sync yerel not ve kalici AI hafizasi araclari.' },
);
mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => new Promise((resolve) => {
  const { name, arguments: args } = request.params || {};
  callTool(name, args || {}, (error, output) => resolve({
    content: [{ type: 'text', text: String(error || output || '') }],
    isError: !!error,
  }));
}));

async function main() {
  await mcpServer.connect(new StdioServerTransport());
  process.stdin.resume();
  // Bazi Node 22 Linux kurulumlari pipe stdin'i aktif handle saymiyor ve MCP
  // istemcisi ilk initialize mesajini yazmadan sureci temizce kapatiyor.
  // EOF geldiginde temizlenen bu timer stdio oturumunun omrunu korur.
  const keepAlive = setInterval(() => {}, 60 * 60 * 1000);
  const stop = () => clearInterval(keepAlive);
  process.stdin.once('end', stop);
  process.stdin.once('close', stop);
}
main().catch((error) => {
  process.stderr.write(`Notlar Sync MCP: ${String(error.message || error)}\n`);
  process.exitCode = 1;
});
