// notlar-sync: iki PC arasi anlik senkron not uygulamasi
// Calistir: node server.js  ->  http://<bu-pc-ip>:7777
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec, execFile } = require('child_process');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 7777;

// veriler kullanicinin ev dizininde: paketli uygulamada __dirname salt-okunur (asar)
const DATA_DIR = path.join(require('os').homedir(), 'NotlarSync');
const NOTES_DIR = path.join(DATA_DIR, 'notes');
fs.mkdirSync(NOTES_DIR, { recursive: true });

// config yoksa ornekten olustur (ilk acilis) — parolayi rastgele uret,
// GitHub'dan indiren herkes ayni bilinen varsayilan parolayla kalmasin
const CONFIG_PATH = path.join(DATA_DIR, 'app-config.json');
if (!fs.existsSync(CONFIG_PATH)) {
  const example = fs.readFileSync(path.join(__dirname, 'app-config.example.json'), 'utf8');
  fs.writeFileSync(CONFIG_PATH, example.replace('degistir-beni', crypto.randomBytes(6).toString('hex')));
}
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const PASSWORD = config.password ?? ''; // "" = parola kapali

// --- yardimcilar ---
const safeName = (n) => typeof n === 'string' ? n.replace(/[^a-zA-Z0-9ğüşöçıİĞÜŞÖÇ _\-.]/g, '').trim() : '';
const notePath = (n) => path.join(NOTES_DIR, n + '.md');

// en guncel icerik RAM'de: disk 400ms geride kalabilir, okumalar buradan beslenir
const latest = {};
const saveTimers = {};

function listNotes() {
  return fs.readdirSync(NOTES_DIR)
    .filter(f => f.endsWith('.md'))
    .map(f => f.slice(0, -3))
    .sort((a, b) => a.localeCompare(b, 'tr'));
}

function readNote(name) {
  if (latest[name] !== undefined) return latest[name];
  const fp = notePath(name);
  return fs.existsSync(fp) ? fs.readFileSync(fp, 'utf8') : undefined;
}

function saveNote(name, content) {
  clearTimeout(saveTimers[name]); // bekleyen eski yazma, yeniyi ezmesin
  latest[name] = content;
  fs.writeFileSync(notePath(name), content, 'utf8');
  autoPush();
}

function deleteNote(name) {
  clearTimeout(saveTimers[name]); // yoksa silinen not 400ms icinde dirilir
  delete latest[name];
  const fp = notePath(name);
  if (fs.existsSync(fp)) { fs.unlinkSync(fp); autoPush(); }
}

// --- oto git push: notlar degisince arkada commit + push (config: gitAutoPush) ---
let pushTimer;
function autoPush() {
  if (!config.gitAutoPush) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    // parolali config asla repoya girmesin
    const gi = path.join(DATA_DIR, '.gitignore');
    const cur = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
    if (!cur.split('\n').includes('app-config.json'))
      fs.writeFileSync(gi, cur + (cur && !cur.endsWith('\n') ? '\n' : '') + 'app-config.json\n');
    exec('git add -A && (git diff --cached --quiet || git commit -m "oto-kayit") && git push -u origin HEAD',
      { cwd: DATA_DIR }, (e, out, err) => {
        if (e) console.log('git push olmadi:', (err || '').trim().split('\n')[0]);
      });
  }, config.gitPushDelayMs || 30000); // son degisiklikten 30sn sonra tek seferde
}

// host'un baglanti adresi: once tailscale (100.x) IP, yoksa LAN IP
function getHostAddress(cb) {
  execFile('tailscale', ['ip', '-4'], (e, out) => {
    const ip = (out || '').trim().split('\n')[0];
    if (ip) return cb(ip);
    const nets = require('os').networkInterfaces();
    for (const name of Object.keys(nets))
      for (const net of nets[name])
        if (net.family === 'IPv4' && !net.internal) return cb(net.address);
    cb('localhost');
  });
}

// bu host'a baglanmak icin tek kod: adres + parola tek stringte paketli
// baska cihaz bunu setup ekranina yapistirinca kendini client olarak ayarlar
function makePairCode(cb) {
  getHostAddress((addr) => {
    const payload = JSON.stringify({ s: 'http://' + addr + ':' + PORT, p: PASSWORD });
    cb('NTLR1-' + Buffer.from(payload, 'utf8').toString('base64url'));
  });
}

// --- REST API (AI'lar icin): ?key=PAROLA ile ---
// GET  /api/notes            -> not listesi (JSON)
// GET  /api/note/ISIM        -> not icerigi (duz metin)
// POST /api/note/ISIM        -> notu yaz (govde = icerik); ?append=1 -> sona ekle
function handleApi(req, res, url) {
  if (PASSWORD && url.searchParams.get('key') !== PASSWORD) {
    res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('parola yanlis (?key=... ekle)');
    return;
  }
  const txt = (code, body, type) => {
    res.writeHead(code, { 'Content-Type': (type || 'text/plain') + '; charset=utf-8' });
    res.end(body);
  };

  if (url.pathname === '/api/notes' && req.method === 'GET')
    return txt(200, JSON.stringify(listNotes()), 'application/json');

  if (url.pathname === '/api/pair-code' && req.method === 'GET')
    return makePairCode((code) => txt(200, code));

  const m = url.pathname.match(/^\/api\/note\/(.+)$/);
  if (!m) return txt(404, 'yok');
  const name = safeName(decodeURIComponent(m[1]));
  if (!name) return txt(400, 'gecersiz isim');

  if (req.method === 'GET') {
    const content = readNote(name);
    if (content === undefined) return txt(404, 'not yok: ' + name);
    return txt(200, content, 'text/markdown');
  }

  if (req.method === 'POST') {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { chunks.push(c); size += c.length; if (size > 5e6) req.destroy(); });
    req.on('end', () => {
      // Buffer.concat: cok baytli UTF-8 karakterler chunk sinirinda bolunmesin
      const body = Buffer.concat(chunks).toString('utf8');
      const old = readNote(name);
      const isNew = old === undefined;
      const content = url.searchParams.get('append') ? (old || '') + body : body;
      saveNote(name, content);
      // acik editorlerde aninda gorunsun
      broadcast({ type: 'content', name, content, live: true });
      if (isNew) broadcast({ type: 'list', notes: listNotes() });
      txt(200, 'kaydedildi: ' + name);
    });
    return;
  }
  txt(405, 'desteklenmeyen metod');
}

// --- statik dosya sunucusu ---
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
  const file = url.pathname === '/' ? '/index.html' : url.pathname;
  const fp = path.join(__dirname, 'public', path.normalize(file).replace(/^(\.\.[\/\\])+/, ''));
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('yok'); return; }
    const ext = path.extname(fp);
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
    res.writeHead(200, { 'Content-Type': (types[ext] || 'text/plain') + '; charset=utf-8' });
    res.end(data);
  });
});

// --- websocket: anlik senkron ---
const wss = new WebSocketServer({ server, maxPayload: 10 * 1024 * 1024 });

function broadcast(msg, except) {
  const s = JSON.stringify(msg);
  for (const c of wss.clients) {
    if (c !== except && c.readyState === 1) c.send(s);
  }
}

wss.on('connection', (ws, req) => {
  // parola kontrolu: ws://host:7777/?key=PAROLA
  // config'de password bos ("") birakilirsa parola sorulmaz
  const key = new URL(req.url, 'http://x').searchParams.get('key') || '';
  if (PASSWORD && key !== PASSWORD) { ws.close(4001, 'parola yanlis'); return; }

  ws.send(JSON.stringify({ type: 'list', notes: listNotes() }));

  ws.on('message', (raw) => {
    // bozuk/beklenmedik mesaj sunucuyu (host modda uygulamayi) dusurmesin
    try {
      const m = JSON.parse(raw);
      const name = safeName(m.name); // her zaman normalize isim kullan ve yankila
      if (!name) return;

      if (m.type === 'open') {
        ws.send(JSON.stringify({ type: 'content', name, content: readNote(name) ?? '' }));
      }

      if (m.type === 'edit' && typeof m.content === 'string') {
        latest[name] = m.content;
        // ayni notu acik olan herkese aninda gonder
        broadcast({ type: 'content', name, content: m.content, live: true }, ws);
        // diske yazmayi hafif geciktir (her tusta disk yazmasin)
        clearTimeout(saveTimers[name]);
        saveTimers[name] = setTimeout(() => saveNote(name, latest[name]), 400);
      }

      if (m.type === 'create') {
        if (readNote(name) === undefined) saveNote(name, '');
        broadcast({ type: 'list', notes: listNotes() }, ws);
        ws.send(JSON.stringify({ type: 'list', notes: listNotes() }));
        ws.send(JSON.stringify({ type: 'created', name }));
      }

      if (m.type === 'delete') {
        deleteNote(name);
        broadcast({ type: 'list', notes: listNotes() }, ws);
        ws.send(JSON.stringify({ type: 'list', notes: listNotes() }));
      }
    } catch (e) {
      console.log('bozuk ws mesaji yoksayildi:', e.message);
    }
  });
});

wss.on('error', () => {}); // hata mesaji http server handler'inda
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.log('Port ' + PORT + ' zaten kullaniliyor, mevcut sunucuya baglanilacak.');
  else throw e;
});
server.listen(PORT, '0.0.0.0', () => {
  const nets = require('os').networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets))
    for (const net of nets[name])
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
  console.log('Notlar-Sync calisiyor!');
  console.log('  Bu PC:      http://localhost:' + PORT);
  ips.forEach(ip => console.log('  Diger PC:   http://' + ip + ':' + PORT));
});
