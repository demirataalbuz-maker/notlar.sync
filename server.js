// notlar-sync: iki PC arasi anlik senkron not uygulamasi
// Calistir: node server.js  ->  http://<bu-pc-ip>:7777
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = 7777;

// veriler kullanicinin ev dizininde: paketli uygulamada __dirname salt-okunur (asar)
const DATA_DIR = path.join(require('os').homedir(), 'NotlarSync');
const NOTES_DIR = path.join(DATA_DIR, 'notes');
fs.mkdirSync(NOTES_DIR, { recursive: true });

// config yoksa ornekten olustur (ilk acilis)
const CONFIG_PATH = path.join(DATA_DIR, 'app-config.json');
if (!fs.existsSync(CONFIG_PATH))
  fs.copyFileSync(path.join(__dirname, 'app-config.example.json'), CONFIG_PATH);
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const PASSWORD = config.password || 'degistir-beni';

// --- yardimcilar ---
const safeName = (n) => n.replace(/[^a-zA-Z0-9ğüşöçıİĞÜŞÖÇ _\-.]/g, '').trim();
const notePath = (n) => path.join(NOTES_DIR, safeName(n) + '.md');

function listNotes() {
  return fs.readdirSync(NOTES_DIR)
    .filter(f => f.endsWith('.md'))
    .map(f => f.slice(0, -3))
    .sort((a, b) => a.localeCompare(b, 'tr'));
}

// --- statik dosya sunucusu ---
const server = http.createServer((req, res) => {
  const file = req.url === '/' ? '/index.html' : req.url;
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
const wss = new WebSocketServer({ server });
const saveTimers = {};

function broadcast(msg, except) {
  const s = JSON.stringify(msg);
  for (const c of wss.clients) {
    if (c !== except && c.readyState === 1) c.send(s);
  }
}

wss.on('connection', (ws, req) => {
  // parola kontrolu: ws://host:7777/?key=PAROLA
  const key = new URL(req.url, 'http://x').searchParams.get('key');
  if (key !== PASSWORD) { ws.close(4001, 'parola yanlis'); return; }

  ws.send(JSON.stringify({ type: 'list', notes: listNotes() }));

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    if (m.type === 'open') {
      const fp = notePath(m.name);
      const content = fs.existsSync(fp) ? fs.readFileSync(fp, 'utf8') : '';
      ws.send(JSON.stringify({ type: 'content', name: m.name, content }));
    }

    if (m.type === 'edit') {
      // ayni notu acik olan herkese aninda gonder
      broadcast({ type: 'content', name: m.name, content: m.content, live: true }, ws);
      // diske yazmayi hafif geciktir (her tusta disk yazmasin)
      clearTimeout(saveTimers[m.name]);
      saveTimers[m.name] = setTimeout(() => {
        fs.writeFileSync(notePath(m.name), m.content, 'utf8');
      }, 400);
    }

    if (m.type === 'create') {
      const name = safeName(m.name);
      if (!name) return;
      const fp = notePath(name);
      if (!fs.existsSync(fp)) fs.writeFileSync(fp, '', 'utf8');
      broadcast({ type: 'list', notes: listNotes() });
      ws.send(JSON.stringify({ type: 'list', notes: listNotes() }));
    }

    if (m.type === 'delete') {
      const fp = notePath(m.name);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
      broadcast({ type: 'list', notes: listNotes() });
      ws.send(JSON.stringify({ type: 'list', notes: listNotes() }));
    }
  });
});

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
