// notlar-sync: iki PC arasi anlik senkron not uygulamasi
// Calistir: node server.js  ->  http://<bu-pc-ip>:7777
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec, execFile } = require('child_process');
const { WebSocketServer } = require('ws');
const { buildGraph, buildReport, explainNode, shortestPath } = require('./graph');
const zihin = require('./zihin');
const kopru = require('./kopru');
const esl = require('./eslestirme');

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
// cevap modeli config'ten (qwen3:14b'ye gecis tek satir), varsayilan 8b
const CEVAP_MODELI = config.cevapModeli || 'qwen3:8b';

// Bir istek yetkili mi? Kabul edilen anahtar = ana parola VEYA eslestirmeyle
// uretilmis bir cihaz token'i. Parola "" ise herkese acik (yerel kullanim).
// Header (X-Api-Key) ya da ?key= - header tercih edilir (URL loga sizmasin).
function keyOf(req, url) {
  return (req && req.headers && req.headers['x-api-key']) || url.searchParams.get('key') || '';
}
function authOk(k) {
  if (!PASSWORD) return true;
  if (k === PASSWORD) return true;
  if (esl.tokenGecerli(DATA_DIR, k)) { esl.tokenGoruldu(DATA_DIR, k, zihin.simdi()); return true; }
  return false;
}

// --- yardimcilar ---
const safeName = (n) => typeof n === 'string' ? n.replace(/[^a-zA-Z0-9ğüşöçıİĞÜŞÖÇ _\-.]/g, '').trim() : '';
const notePath = (n) => path.join(NOTES_DIR, n + '.md');

// en guncel icerik RAM'de: disk 400ms geride kalabilir, okumalar buradan beslenir
const latest = {};
const saveTimers = {};

// tarayici eklentisinin yakaladigi sifreler — SADECE RAM, diske/git'e asla yazilmaz
let pending = [];

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
  fireWebhook('not-kaydedildi', name);
  otoZihin(name); // arka plan zekasi: sessizlik sonrasi oneri taramasi
}

function deleteNote(name) {
  clearTimeout(saveTimers[name]); // yoksa silinen not 400ms icinde dirilir
  delete latest[name];
  const fp = notePath(name);
  if (fs.existsSync(fp)) { fs.unlinkSync(fp); autoPush(); fireWebhook('not-silindi', name); }
}

// --- webhook: not degisince config'deki URL'lere POST (dis otomasyon kapisi).
// app-config.json: "webhooks": ["http://localhost:9999/tetik"]. Ayni not icin
// 5 sn'de bir en fazla bir atis (canli senkron her tusta yagdirmasin).
const webhookSon = {};
function fireWebhook(event, name) {
  const urls = [].concat(config.webhooks || []).filter(Boolean);
  if (!urls.length) return;
  const k = event + '|' + name;
  if (webhookSon[k] && Date.now() - webhookSon[k] < 5000) return;
  webhookSon[k] = Date.now();
  const govde = JSON.stringify({ event, name, tarih: new Date().toISOString() });
  for (const u of urls) {
    try {
      const uu = new URL(u);
      const mod = uu.protocol === 'https:' ? require('https') : http;
      const r = mod.request(uu, { method: 'POST', timeout: 5000,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(govde) } });
      r.on('error', () => {});
      r.on('timeout', () => r.destroy());
      r.end(govde);
    } catch { /* bozuk URL webhook'u uygulamayi dusurmesin */ }
  }
}

// --- oto git push: notlar degisince arkada commit + push (config: gitAutoPush) ---
let pushTimer;
function autoPush() {
  if (!config.gitAutoPush) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    // parola/kasa ASLA repoya girmesin
    const gi = path.join(DATA_DIR, '.gitignore');
    let cur = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
    for (const must of ['app-config.json', 'vault.enc'])
      if (!cur.split('\n').includes(must)) cur += (cur && !cur.endsWith('\n') ? '\n' : '') + must + '\n';
    fs.writeFileSync(gi, cur);
    exec('git add -A && (git diff --cached --quiet || git commit -m "oto-kayit") && git push -u origin HEAD',
      { cwd: DATA_DIR }, (e, out, err) => {
        if (e) console.log('git push olmadi:', (err || '').trim().split('\n')[0]);
      });
  }, config.gitPushDelayMs || 30000); // son degisiklikten 30sn sonra tek seferde
}

// --- graf onbellegi (artimli guncelleme): notlar degismedikce graf yeniden
// hesaplanmaz. Parmak izi = dosya adi+mtime+boyut (stat, tam okumadan cok ucuz);
// dis degisiklikleri de yakalar (git pull, elle duzenleme). Ayrica kuculme
// korumasi: disk gecici okunamazsa bos graf yerine SON SAGLAM graf sunulur.
const gCache = new Map(); // hideHidden(bool) -> { fp, graph }
function notesFingerprint() {
  try {
    return fs.readdirSync(NOTES_DIR).filter((f) => f.endsWith('.md')).sort()
      .map((f) => { const s = fs.statSync(path.join(NOTES_DIR, f)); return f + ':' + s.mtimeMs + ':' + s.size; })
      .join('|');
  } catch { return null; }
}
function getGraph(hideHidden, kategoriHub = false, sadeceKategori = false) {
  const fp = notesFingerprint();
  const key = hideHidden + ':' + kategoriHub + ':' + sadeceKategori; // her gorunum ayri onbellek
  const c = gCache.get(key);
  if (c && fp !== null && c.fp === fp) return c.graph;
  if (fp === null && c) return c.graph; // okuma hatasi: son saglam graf korunur
  const g = buildGraph(NOTES_DIR, { hideHidden, kategoriHub, sadeceKategori });
  if (fp !== null) gCache.set(key, { fp, graph: g });
  return g;
}

// zihin gunlugu: AI zihni kararlari senkronlanan bir nota islenir - hangi
// cihazdan bakarsan bak "AI dun ne degistirdi" gorulur, geri izlenebilir
function gunlukYaz(satir) {
  const eski = readNote(zihin.GUNLUK_NOTU);
  const isNew = eski === undefined;
  const govde = (eski ?? '# Zihin Günlüğü\nAI zihni kararlarının kaydı: öneri kabul/ret ve eklenen sayfalar.\n');
  const icerik = govde + `\n- ${zihin.simdi()} ${satir}`;
  saveNote(zihin.GUNLUK_NOTU, icerik);
  broadcast({ type: 'content', name: zihin.GUNLUK_NOTU, content: icerik, live: true });
  if (isNew) broadcast({ type: 'list', notes: listNotes() });
}

// oneri taramasi - iki katman ayni onay kuyruguna akar: (1) embedding =
// olculebilir anlam benzerligi (model yoksa zarif atlanir), (2) Ollama =
// icerik sezgisi. Dogrulama zihin.js'te: uydurma isim, mevcut kenar,
// kuyruktaki ve daha once REDDEDILEN cift otomatik elenir.
// Hem /api/graph/suggest (butonla) hem oto-zihin (arka plan) bunu cagirir.
function oneriTara(g, model, cb) {
  const real = g.nodes.filter((n) => !n.ghost);
  if (real.length < 2) return cb(null, []);
  const liste = real.map((n) => `- ${n.label}: ${(n.description || '').slice(0, 120)}`).join('\n');
  const prompt = 'Asagida bir kisinin notlari var. Icerik olarak birbiriyle ILGILI olabilecek en fazla 6 not cifti oner. SADECE su formatta JSON dizisi dondur, baska hicbir sey yazma: [{"a":"not adi","b":"not adi","neden":"3-6 kelimelik gerekce"}]\n\n' + liste;
  zihin.semanticSuggest(DATA_DIR, g, readNote, (embedItems) => {
    const e1 = zihin.addSuggestions(DATA_DIR, g, embedItems, 'embedding');
    askOllama(model, prompt, (err, out) => {
      let e2 = [];
      if (!err) {
        let arr;
        try { arr = JSON.parse((out.match(/\[[\s\S]*\]/) || ['[]'])[0]); } catch { arr = []; }
        e2 = zihin.addSuggestions(DATA_DIR, g, arr, 'ollama');
      }
      if (e1.length || e2.length) broadcast({ type: 'oneri' });
      cb(err, e1.concat(e2));
    });
  });
}

// --- oto-zihin: not degisince 2 dk sessizlik sonrasi arka planda oneri
// taramasi - beyin sorulmadan da dusunur, ama yine SADECE onerir (onay
// kuyruguna). AI-Hafiza/gunluk yazmalari tetiklemez (gurultu + dongu olmasin).
// Kapatmak icin app-config.json: "otoZihin": false
// Bekleyen tarama DISKE de yazilir: uygulama timer dolmadan kapanirsa,
// sonraki aciliste kaldigi yerden tarar (degisiklik sessizce unutulmaz).
const OTO_BEKLEYEN = path.join(DATA_DIR, 'oto-bekleyen.json');
let otoTimer = null, otoCalisiyor = false;
function otoCalistir() {
  if (otoCalisiyor) return;
  otoCalisiyor = true;
  oneriTara(getGraph(false), CEVAP_MODELI, (_, eklenen) => {
    otoCalisiyor = false;
    try { fs.unlinkSync(OTO_BEKLEYEN); } catch {} // tarama bitti, borc kapandi
    if (eklenen.length) console.log(`oto-zihin: ${eklenen.length} yeni oneri kuyrukta`);
  });
}
function otoZihin(name) {
  if (config.otoZihin === false || name.startsWith('AI-Hafiza')) return;
  clearTimeout(otoTimer);
  try { fs.writeFileSync(OTO_BEKLEYEN, JSON.stringify({ zaman: zihin.simdi(), not: name })); } catch {}
  otoTimer = setTimeout(otoCalistir, (Number(config.otoZihinSn) || 120) * 1000);
}
// acilista yarim kalmis tarama var mi? (15 sn bekle: sunucu otursun, Ollama uyansin)
if (config.otoZihin !== false && fs.existsSync(OTO_BEKLEYEN)) {
  console.log('oto-zihin: onceki oturumdan bekleyen tarama bulundu, birazdan calisacak');
  otoTimer = setTimeout(otoCalistir, 15000);
}

// POST govdesini topla (JSON bekleyen ucul icin)
function readBody(req, cb) {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => { chunks.push(c); size += c.length; if (size > 1e6) req.destroy(); });
  req.on('end', () => {
    try { cb(null, JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
    catch { cb('gecersiz JSON'); }
  });
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

// local Ollama'ya istek (varsa). /no_think ile qwen3 dusunmeden hizli cevap verir.
function askOllama(model, prompt, cb) {
  const payload = JSON.stringify({ model, prompt, stream: false, think: false });
  const r = http.request({
    host: '127.0.0.1', port: 11434, path: '/api/generate', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    timeout: 120000,
  }, (resp) => {
    let d = '';
    resp.on('data', (c) => d += c);
    resp.on('end', () => {
      try { cb(null, (JSON.parse(d).response || '').trim()); }
      catch { cb('cevap cozulemedi'); }
    });
  });
  r.on('error', (e) => cb(e.code === 'ECONNREFUSED' ? 'Ollama calismiyor (ollama serve)' : e.message));
  r.on('timeout', () => { r.destroy(); cb('zaman asimi'); });
  r.end(payload);
}

// istege bagli bulut modeli: SADECE kullanici soru basina 'claude' SECERSE
// cagirilir; anahtar girilmediyse hicbir sey buluta gitmez. Beyin sende,
// zeka kiralik: veri local durur, o sorunun baglami gider, o kadar.
function askClaude(model, prompt, cb) {
  if (!config.claudeApiKey) return cb('claudeApiKey yok (app-config.json)');
  const https = require('https');
  const payload = JSON.stringify({
    model: config.claudeModel || 'claude-sonnet-5',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });
  const r = https.request({
    host: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload),
      'x-api-key': config.claudeApiKey, 'anthropic-version': '2023-06-01',
    },
    timeout: 60000,
  }, (resp) => {
    let d = '';
    resp.on('data', (c) => d += c);
    resp.on('end', () => {
      try {
        const j = JSON.parse(d);
        if (j.error) return cb('Claude: ' + (j.error.message || j.error.type));
        cb(null, (j.content || []).map((c) => c.text || '').join('').trim());
      } catch { cb('Claude cevabi cozulemedi'); }
    });
  });
  r.on('error', (e) => cb(e.message));
  r.on('timeout', () => { r.destroy(); cb('Claude zaman asimi'); });
  r.end(payload);
}

// --- REST API (AI'lar icin): ?key=PAROLA ile ---
// GET  /api/notes            -> not listesi (JSON)
// GET  /api/note/ISIM        -> not icerigi (duz metin)
// POST /api/note/ISIM        -> notu yaz (govde = icerik); ?append=1 -> sona ekle
// Yeni cihaz tarafi: henuz token'i yok, bu yuzden AUTHSIZ. Guvenlik = tek
// kullanimlik kodu bilmek + host'un onayi + kendi claimId'si. Kod dogru olsa
// bile host onaylamadan token verilmez; token yalnizca durum yoklamasinda
// BIR KEZ teslim edilir ve kod imha olur.
// claim kaba kuvvet kalkani: 6 haneli kodu tahmin penceresi zaten 3 dk ama
// hizli deneyen bir saldirgan yine de binlerce kod yoklayabilirdi. IP basina
// dakikada 5 deneme -> pencere pratikte kapanir. Sadece claim sinirlanir;
// durum yoklamasi (polling) mesru olarak sik calisir, ona dokunulmaz.
const pairDenemeler = new Map(); // ip -> [zaman, ...]
function pairHizAsildi(ip, simdi) {
  const son = (pairDenemeler.get(ip) || []).filter((t) => simdi - t < 60000);
  son.push(simdi);
  pairDenemeler.set(ip, son);
  if (pairDenemeler.size > 500) // eski IP'ler birikmesin
    for (const [k, v] of pairDenemeler)
      if (!v.some((t) => simdi - t < 60000)) pairDenemeler.delete(k);
  return son.length > 5;
}

function handlePair(req, res, url, txt) {
  const p = url.pathname;
  // yeni cihaz kodu girer -> oturuma sahiplenir, host'a bildirim yayilir
  if (p === '/api/pair/claim' && req.method === 'POST') {
    if (pairHizAsildi(req.socket.remoteAddress || '?', Date.now()))
      return txt(429, 'cok fazla deneme - 1 dakika bekleyin');
    return readBody(req, (e, b) => {
      const r = esl.talep(b.kod, b.cihazAdi, Date.now());
      if (r.hata) return txt(404, r.hata);
      broadcast({ type: 'pair' }); // authed cihazlar onay kutusunu tazeler
      txt(200, JSON.stringify(r), 'application/json');
    });
  }
  // yeni cihaz kendi tarafini onaylar (claimId ile kanitli)
  if (p === '/api/pair/cihaz-onay' && req.method === 'POST') {
    return readBody(req, (e, b) => {
      const r = esl.onayla(b.kod, 'cihaz', String(b.claimId || ''), DATA_DIR, zihin.simdi());
      if (r.hata) return txt(403, r.hata);
      broadcast({ type: 'pair' });
      txt(200, JSON.stringify(r), 'application/json');
    });
  }
  // yeni cihaz durumu yoklar; onaylandiysa token'i BIR KEZ alir (kod imha)
  if (p === '/api/pair/durum' && req.method === 'GET') {
    const r = esl.durum(url.searchParams.get('kod'), url.searchParams.get('claimId'), Date.now());
    return txt(r.hata ? 403 : 200, JSON.stringify(r), 'application/json');
  }
  return txt(404, 'yok');
}

function handleApi(req, res, url) {
  const txt = (code, body, type) => {
    res.writeHead(code, { 'Content-Type': (type || 'text/plain') + '; charset=utf-8' });
    res.end(body);
  };

  // yeni-cihaz tarafi uclari kimlik ISTEMEZ (henuz token'i yok) - guvenlik
  // tek kullanimlik kod + claimId + cift onayla saglanir. Digerleri (kod
  // uretme, host onayi, cihaz listesi) authed'dir, asagida akar.
  if (['/api/pair/claim', '/api/pair/cihaz-onay', '/api/pair/durum'].includes(url.pathname))
    return handlePair(req, res, url, txt);

  if (!authOk(keyOf(req, url))) {
    res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('parola yanlis (?key=... ya da X-Api-Key)');
    return;
  }

  // GRAPHIFY entegrasyonu: uygulama içinden kod grafiğini yeniden kur (LLM'siz, hızlı).
  // update = kod yeniden çıkar, cluster-only --no-label = toplulukları+graph.html tazele.
  if (url.pathname === '/api/graphify/build' && req.method === 'POST') {
    const bin = path.join(require('os').homedir(), '.local/bin/graphify');
    execFile(bin, ['update', __dirname, '--no-cluster'], { timeout: 120000 }, () => {
      execFile(bin, ['cluster-only', __dirname, '--no-label'], { timeout: 120000 }, (e2, o2, er2) => {
        if (e2) return txt(500, JSON.stringify({ ok: false, hata: String(er2 || e2).slice(0, 300) }), 'application/json');
        txt(200, JSON.stringify({ ok: true }), 'application/json');
      });
    });
    return;
  }

  if (url.pathname === '/api/notes' && req.method === 'GET')
    return txt(200, JSON.stringify(listNotes()), 'application/json');

  // icerik aramasi: ad VE govde icinde gecen notlar, kucuk bir snippet ile
  if (url.pathname === '/api/search' && req.method === 'GET') {
    const q = (url.searchParams.get('q') || '').toLowerCase();
    if (!q) return txt(200, '[]', 'application/json');
    const out = [];
    for (const n of listNotes()) {
      const c = readNote(n) || '';
      const i = c.toLowerCase().indexOf(q);
      if (!n.toLowerCase().includes(q) && i === -1) continue;
      out.push({ name: n, snippet: i >= 0 ? c.slice(Math.max(0, i - 40), i + 60).replace(/\s+/g, ' ').trim() : '' });
      if (out.length >= 30) break;
    }
    return txt(200, JSON.stringify(out), 'application/json');
  }

  // gorsel yukleme (editore yapistirma): ~/NotlarSync/files/ altina kaydedilir,
  // nota ![](files/ad.png) olarak eklenir, /files/ ile (parolali) sunulur
  if (url.pathname === '/api/upload' && req.method === 'POST') {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { chunks.push(c); size += c.length; if (size > 15e6) req.destroy(); });
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      if (!buf.length) return txt(400, 'bos govde');
      const ext = (url.searchParams.get('ext') || 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return txt(415, 'desteklenmeyen tur');
      const dir = path.join(DATA_DIR, 'files');
      fs.mkdirSync(dir, { recursive: true });
      const ad = 'gorsel-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex') + '.' + ext;
      fs.writeFileSync(path.join(dir, ad), buf);
      txt(200, JSON.stringify({ yol: 'files/' + ad }), 'application/json');
    });
    return;
  }

  // --- zihin-haritasi motoru (kopru): var mi, neleri isleyebilir?
  // UI acilista sorar; motor yoksa belge/export butonlari hic gorunmez.
  if (url.pathname === '/api/motor' && req.method === 'GET') {
    return kopru.durum((_, d) => txt(200, JSON.stringify(d), 'application/json'));
  }

  // POST /api/belge?ad=rapor.pdf (govde = dosya): PDF/gorsel/ses/video -> NOT.
  // Motor metni/kavramlari cikarir; not olusur, kavramlar [[link]] olur,
  // Ollama iliski onerir. Whisper dakikalar surebilir -> hemen "isleniyor"
  // doner, sonuc WS 'belge' mesajiyla tum cihazlara duyurulur.
  if (url.pathname === '/api/belge' && req.method === 'POST') {
    if (!kopru.python()) return txt(503, 'motor yok: ~/zihin-haritasi kurulu degil');
    const orjinal = safeName(url.searchParams.get('ad') || '');
    const ext = (orjinal.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
    const tur = kopru.TURLER[ext];
    if (!tur) return txt(415, 'desteklenmeyen tur: .' + (ext || '?') + ' (pdf/gorsel/ses/video)');
    const dir = path.join(DATA_DIR, 'files');
    fs.mkdirSync(dir, { recursive: true });
    const dosyaAdi = 'belge-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex') + '.' + ext;
    const fp = path.join(dir, dosyaAdi);
    const out = fs.createWriteStream(fp); // buyuk video RAM'e alinmaz, diske akar
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 500e6) { req.destroy(); out.destroy(); } });
    req.pipe(out);
    out.on('finish', () => {
      if (!size) { fs.unlinkSync(fp); return txt(400, 'bos govde'); }
      txt(200, JSON.stringify({ durum: 'isleniyor', tur }), 'application/json');
      kopru.belge(fp, tur, (err, sonuc) => {
        if (err || (!sonuc.text && !(sonuc.concepts || []).length)) {
          broadcast({ type: 'belge', hata: String(err || sonuc.hata || 'icerik cikarilamadi').slice(0, 200) });
          return;
        }
        let name = orjinal.replace(/\.[a-z0-9]+$/i, '').trim().slice(0, 60) || 'belge';
        while (readNote(name) !== undefined) name += ' 2'; // mevcut notu ezme
        const metin = (sonuc.text || '').trim();
        // kavram kalite filtresi: vision/LLM bazen kavram yerine cumle dondurur
        // ("gibi bir ornek olabilir. Ancak") - cop haritaya dugum olmasin.
        // Gercek kavram: 1-3 kelime, <=30 karakter, noktalama yok, tekil.
        const gorulen = new Set();
        const kavram = (sonuc.concepts || []).filter(Boolean)
          .map((k) => String(k).trim())
          .filter((k) => k && k.length <= 30 && k.split(/\s+/).length <= 3 && !/[.,;:!?()]/.test(k))
          .filter((k) => { const n = k.toLowerCase(); return gorulen.has(n) ? false : gorulen.add(n); });
        const desc = (metin ? metin.replace(/\s+/g, ' ').slice(0, 160) : kavram.join(', ').slice(0, 160)).replace(/"/g, "'");
        const icerik = [
          '---',
          `name: ${name}`,
          `description: "${desc}"`,
          'metadata:',
          '  type: belge',
          `  tur: ${tur}`,
          `  kaynak: files/${dosyaAdi}`,
          `  eklenme: ${zihin.simdi()}`,
          '---',
          '',
          ...(tur === 'gorsel' ? [`![](files/${dosyaAdi})`, ''] : []),
          ...(metin ? [metin.slice(0, 4000) + (metin.length > 4000 ? '\n\n… (kısaltıldı)' : ''), ''] : []),
          ...(kavram.length ? ['Kavramlar: ' + kavram.map((k) => `[[${safeName(k)}]]`).join(' · ')] : []),
        ].join('\n');
        saveNote(name, icerik);
        broadcast({ type: 'content', name, content: icerik, live: true });
        broadcast({ type: 'list', notes: listNotes() });
        broadcast({ type: 'belge', ad: name, tur });
        gunlukYaz(`belge eklendi: "${name}" (${tur}, motor: zihin-haritasi)${kavram.length ? ' — kavramlar: ' + kavram.join(', ') : ''}`);
        iliskiOner(name, desc);
      });
    });
    out.on('error', () => txt(500, 'dosya yazilamadi'));
    return;
  }

  // --- zihin haritasi: notlar arasi [[link]] grafi (AI de insan da okuyabilir) ---
  if (url.pathname.startsWith('/api/graph') && req.method === 'GET') {
    // gruplu gorunum SADECE ana harita cekiminde: rapor/oneri/query hub'siz kalir
    const gruplu = url.pathname === '/api/graph' && url.searchParams.get('gruplu') === '1';
    const sade = gruplu && url.searchParams.get('sade') === '1'; // acilis evreni: sadece konu sistemleri
    const g = getGraph(url.searchParams.get('gizli') !== '1', gruplu, sade);

    if (url.pathname === '/api/graph')
      return txt(200, JSON.stringify(g), 'application/json');

    // haritayi disa aktar (motor uzerinden): ?format=svg|graphml|neo4j|obsidian|wiki
    // svg/graphml/neo4j tek dosya olarak indirilir; obsidian/wiki klasore yazilir.
    if (url.pathname === '/api/graph/export') {
      const format = url.searchParams.get('format') || 'svg';
      const DOSYA = { svg: ['graph.svg', 'image/svg+xml'], graphml: ['graph.graphml', 'application/xml'], neo4j: ['cypher.txt', 'text/plain'] };
      if (!DOSYA[format] && format !== 'obsidian' && format !== 'wiki')
        return txt(400, 'format: svg | graphml | neo4j | obsidian | wiki');
      const outDir = path.join(DATA_DIR, 'export');
      return kopru.exportGraf(g, [format], outDir, 'Notlar Sync — Zihin Haritası', (err) => {
        if (err) return txt(502, 'motor: ' + err);
        if (!DOSYA[format])
          return txt(200, JSON.stringify({ klasor: path.join(outDir, format === 'obsidian' ? 'vault' : 'wiki') }), 'application/json');
        const [ad, tip] = DOSYA[format];
        res.writeHead(200, { 'Content-Type': tip + '; charset=utf-8', 'Content-Disposition': 'attachment; filename="' + ad + '"' });
        res.end(fs.readFileSync(path.join(outDir, ad)));
      });
    }

    // GraphRAG: soruyu grafta gez, ilgili notlari topla, local AI cevaplasin
    // "zihnimde X hakkinda ne var?" -> /api/graph/query?q=...
    if (url.pathname === '/api/graph/query') {
      const q = url.searchParams.get('q') || '';
      if (!q.trim()) return txt(400, '?q= ile soru ver');
      // ?model=claude -> bulut modu: gizli:true notlar baglama girmez
      const bulut = url.searchParams.get('model') === 'claude';
      const secenek = bulut
        ? { ask: askClaude, model: config.claudeModel || 'claude-sonnet-5', bulut: true }
        : { ask: askOllama, model: CEVAP_MODELI };
      return zihin.graphQuery(DATA_DIR, g, q, readNote, secenek, (err, sonuc) => {
        if (err) return txt(400, String(err));
        txt(200, JSON.stringify({ soru: q, model: bulut ? 'claude' : CEVAP_MODELI, ...sonuc }), 'application/json');
      });
    }

    // rapor zekasi: saglik + obek butunlugu + sasirtici baglantilar + sorular
    if (url.pathname === '/api/graph/rapor') {
      const r = buildReport(g);
      r.bekleyenOneri = zihin.prune(DATA_DIR, getGraph(false)).oneriler.length;
      return txt(200, JSON.stringify(r), 'application/json');
    }

    // bekleyen AI onerileri (kalici kuyruk; kabul/ret POST uclarindan)
    if (url.pathname === '/api/graph/oneriler') {
      const st = zihin.prune(DATA_DIR, getGraph(false));
      return txt(200, JSON.stringify({ oneriler: st.oneriler, reddedilenSayisi: st.reddedilen.length }), 'application/json');
    }

    // dugumu komsulariyla anlat: /api/graph/explain?node=ISIM
    if (url.pathname === '/api/graph/explain') {
      const r = explainNode(g, url.searchParams.get('node') || '');
      return r ? txt(200, JSON.stringify(r), 'application/json') : txt(404, 'dugum yok');
    }

    // iki not arasi en kisa yol: /api/graph/path?from=A&to=B
    if (url.pathname === '/api/graph/path') {
      const r = shortestPath(g, url.searchParams.get('from') || '', url.searchParams.get('to') || '');
      return r ? txt(200, JSON.stringify({ path: r, adim: r.length - 1 }), 'application/json')
               : txt(404, 'yol yok (dugum eksik ya da bagli degil)');
    }

    // local AI baglanti ONERISI (Ollama; yoksa 502, uygulama etkilenmez).
    // Oneriler grafa YAZILMAZ - kesikli cizgiyle gosterilir, kullanici kabul
    // ederse [[link]] olarak notun icine yazilir; tek gercek kaynak notlardir.
    if (url.pathname === '/api/graph/suggest') {
      return oneriTara(g, url.searchParams.get('model') || CEVAP_MODELI, (err, e1) => {
        if (err && !e1.length) return txt(502, 'AI yok/kapali: ' + err);
        const st = zihin.prune(DATA_DIR, getGraph(false));
        txt(200, JSON.stringify(st.oneriler), 'application/json');
      });
    }
  }

  if (url.pathname === '/api/pair-code' && req.method === 'GET')
    return makePairCode((code) => txt(200, code));

  // --- yeni eslestirme: tek kullanimlik kod + cift onay + cihaz token'i ---
  // ana cihaz kod uretir (bu uc AUTHED - handleApi baslangicinda gecti)
  if (url.pathname === '/api/pair/new' && req.method === 'POST') {
    const kod = esl.kodUret(Date.now());
    getHostAddress((addr) => txt(200, JSON.stringify({ kod, adres: 'http://' + addr + ':' + PORT }), 'application/json'));
    return;
  }
  // host tarafi bir talebi onaylar/reddeder (AUTHED). Reddet = oturumu dusur.
  if (url.pathname === '/api/pair/host-onay' && req.method === 'POST') {
    return readBody(req, (e, b) => {
      if (b && b.reddet) { esl.reddet(b.kod); broadcast({ type: 'pair' }); return txt(200, 'reddedildi'); }
      const r = esl.onayla(b.kod, 'host', null, DATA_DIR, zihin.simdi());
      if (r.hata) return txt(409, r.hata);
      if (r.bitti) gunlukYaz(`yeni cihaz eslesti: "${(esl.bekleyenTalepler().find((t) => t.kod === b.kod) || {}).cihazAdi || 'cihaz'}" (cift onay)`);
      broadcast({ type: 'pair' });
      txt(200, JSON.stringify(r), 'application/json');
    });
  }
  // authed cihazlarin gorecegi bekleyen talepler (onay kutusu icin)
  if (url.pathname === '/api/pair/talepler' && req.method === 'GET')
    return txt(200, JSON.stringify(esl.bekleyenTalepler()), 'application/json');

  // --- bagli cihazlar: isimle listele + tek tek iptal (AUTHED) ---
  if (url.pathname === '/api/devices' && req.method === 'GET')
    return txt(200, JSON.stringify(esl.cihazlariOku(DATA_DIR)), 'application/json');
  if (url.pathname === '/api/devices/iptal' && req.method === 'POST') {
    return readBody(req, (e, b) => {
      const oldu = esl.cihazSil(DATA_DIR, String(b.token || ''));
      if (oldu) gunlukYaz('cihaz baglantisi iptal edildi (token silindi)');
      txt(oldu ? 200 : 404, oldu ? 'iptal edildi' : 'cihaz yok');
    });
  }

  // --- sifreli kasa deposu (sifir-bilgi: sunucu blob'u saklar, icini ACAMAZ) ---
  // sifreleme/cozme istemcide (Web Crypto). blob ana parolayla sifreli, gitignored.
  const VAULT_PATH = path.join(DATA_DIR, 'vault.enc');
  if (url.pathname === '/api/vault') {
    if (req.method === 'GET') {
      if (!fs.existsSync(VAULT_PATH)) return txt(404, '');
      return txt(200, fs.readFileSync(VAULT_PATH, 'utf8'), 'application/json');
    }
    if (req.method === 'POST') {
      const chunks = []; let size = 0;
      req.on('data', (c) => { chunks.push(c); size += c.length; if (size > 20e6) req.destroy(); });
      req.on('end', () => { fs.writeFileSync(VAULT_PATH, Buffer.concat(chunks)); txt(200, 'kaydedildi'); });
      return;
    }
  }

  // --- tarayici eklentisi: yakalanan sifreler icin GECICI kuyruk ---
  // SADECE RAM'de tutulur, diske/git'e ASLA yazilmaz. Uygulama kilidi acikken
  // kullaniciya "kasaya ekle?" diye sorar, onaylaninca sifrelenip kasaya girer, kuyruk temizlenir.
  if (url.pathname === '/api/vault-pending') {
    if (req.method === 'GET') return txt(200, JSON.stringify(pending), 'application/json');
    if (req.method === 'DELETE') { pending = []; return txt(200, 'temizlendi'); }
    if (req.method === 'POST') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let it; try { it = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return txt(400, 'gecersiz'); }
        if (!it || !it.password) return txt(400, 'sifre yok');
        // ayni site+kullanici zaten kuyruktaysa tekrar ekleme
        if (!pending.some((p) => p.url === it.url && p.username === it.username && p.password === it.password))
          pending.push({ url: String(it.url || '').slice(0, 300), username: String(it.username || '').slice(0, 200), password: String(it.password).slice(0, 500) });
        if (pending.length > 50) pending.shift(); // ust sinir
        txt(200, 'kuyruga alindi');
      });
      return;
    }
  }

  // --- local AI (Ollama) proxy: ceviri + yardim ---
  if (url.pathname === '/api/ai' && req.method === 'POST') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return txt(400, 'gecersiz'); }
      const model = body.model || 'qwen3:8b'; // ceviri kalitesi icin daha iyi model
      const prompt = body.mode === 'translate'
        ? 'Translate the following text to Turkish. Output ONLY the Turkish translation, no explanations, no notes:\n\n' + (body.text || '')
        : (body.text || '');
      askOllama(model, prompt, (err, out) => {
        if (err) return txt(502, 'AI yok/kapali: ' + err);
        txt(200, out, 'text/plain');
      });
    });
    return;
  }

  // --- AI zihni: oneri/onay dongusu (yazma uclari) ---
  // Dis AI ajanlar (or. Claude) buradan ONERIR, dogrudan graf/not DEGISTIREMEZ:
  // POST /api/graph/oner {a, b, neden} -> kuyruga girer, karari kullanici verir
  if (url.pathname === '/api/graph/oner' && req.method === 'POST') {
    return readBody(req, (err, b) => {
      if (err) return txt(400, err);
      const eklenen = zihin.addSuggestions(DATA_DIR, getGraph(false), [b], 'ajan');
      if (!eklenen.length)
        return txt(409, 'eklenmedi: dugum yok / zaten bagli / zaten kuyrukta / daha once reddedildi');
      gunlukYaz(`öneri (ajan): "${eklenen[0].sourceLabel}" ↔ "${eklenen[0].targetLabel}" — ${eklenen[0].neden || 'gerekçesiz'}`);
      broadcast({ type: 'oneri' });
      txt(200, JSON.stringify(eklenen[0]), 'application/json');
    });
  }

  // kabul: [[link]] KAYNAK notun icine yazilir - tek gercek kaynak notlardir
  if (url.pathname === '/api/graph/oneri/kabul' && req.method === 'POST') {
    return readBody(req, (err, b) => {
      if (err) return txt(400, err);
      const o = zihin.kabul(DATA_DIR, String(b.id || ''));
      if (!o) return txt(404, 'oneri yok');
      const kaynakNot = getGraph(false).nodes.find((n) => n.id === o.source);
      if (!kaynakNot || !kaynakNot.file) return txt(410, 'kaynak not artik yok');
      const stem = kaynakNot.file.replace(/\.md$/, '');
      const icerik = (readNote(stem) || '') + `\n- ilgili: [[${o.targetLabel}]]`;
      saveNote(stem, icerik);
      broadcast({ type: 'content', name: stem, content: icerik, live: true });
      gunlukYaz(`kabul: "${o.sourceLabel}" ↔ "${o.targetLabel}" (${o.kaynak}: ${o.neden || '-'}) → [[link]] nota yazıldı`);
      broadcast({ type: 'oneri' });
      txt(200, 'kabul edildi, [[link]] yazildi: ' + stem);
    });
  }

  if (url.pathname === '/api/graph/oneri/reddet' && req.method === 'POST') {
    return readBody(req, (err, b) => {
      if (err) return txt(400, err);
      const o = zihin.reddet(DATA_DIR, String(b.id || ''));
      if (!o) return txt(404, 'oneri yok');
      gunlukYaz(`ret: "${o.sourceLabel}" ↔ "${o.targetLabel}" (${o.kaynak}) — bir daha önerilmeyecek`);
      broadcast({ type: 'oneri' });
      txt(200, 'reddedildi, bir daha onerilmez');
    });
  }

  // yeni eklenen not icin local AI'dan mevcut notlarla iliski ONERISI iste
  // (kuyruga girer, karar kullanicinin). URL'den not ve belge ingest paylasir.
  function iliskiOner(name, desc) {
    const g = getGraph(false);
    const digerleri = g.nodes.filter((n) => !n.ghost && n.label !== name).map((n) => n.label);
    if (!digerleri.length) return;
    const prompt = 'Yeni not: "' + name + '" — ' + desc + '\n\nMevcut notlar:\n'
      + digerleri.slice(0, 80).map((l) => '- ' + l).join('\n')
      + '\n\nYeni notla icerik olarak ILGILI en fazla 4 mevcut not sec. SADECE su formatta JSON dizisi dondur, baska hicbir sey yazma: [{"b":"not adi","neden":"3-6 kelimelik gerekce"}]';
    askOllama(CEVAP_MODELI, prompt, (aerr, out) => {
      if (aerr) return; // Ollama yoksa not yine de eklendi, oneri katmani atlanir
      let arr;
      try { arr = JSON.parse((out.match(/\[[\s\S]*\]/) || ['[]'])[0]); } catch { return; }
      const items = (Array.isArray(arr) ? arr : []).map((s) => ({ a: name, b: s.b, neden: s.neden }));
      if (zihin.addSuggestions(DATA_DIR, getGraph(false), items, 'ollama').length)
        broadcast({ type: 'oneri' });
    });
  }

  // --- URL'den not: sayfayi indirip referans notuna cevirir (zihni besleme).
  // Kayittan sonra local AI arka planda mevcut notlarla iliski ONERIR (kuyruga).
  if (url.pathname === '/api/ekle-url' && req.method === 'POST') {
    return readBody(req, (err, b) => {
      if (err) return txt(400, err);
      zihin.fetchPage(String(b.url || ''), (ferr, html) => {
        if (ferr) return txt(502, 'indirilemedi: ' + ferr);
        const { title, text } = zihin.htmlToText(html);
        if (!text) return txt(422, 'sayfadan metin cikarilamadi');
        let name = safeName(title).slice(0, 60).trim() || safeName(new URL(b.url).hostname);
        while (readNote(name) !== undefined) name += ' 2'; // mevcut notu ezme
        const desc = text.replace(/\s+/g, ' ').slice(0, 160).replace(/"/g, "'");
        const yazar = safeName(String(b.yazar || ''));
        const icerik = [
          '---',
          `name: ${name}`,
          `description: "${desc}"`,
          'metadata:',
          '  type: reference',
          `  kaynak: ${b.url}`,
          ...(yazar ? [`  yazar: ${yazar}`] : []),
          `  eklenme: ${zihin.simdi()}`,
          '---',
          '',
          text.slice(0, 4000) + (text.length > 4000 ? '\n\n… (kısaltıldı)' : ''),
          '',
          `Kaynak: ${b.url}`,
        ].join('\n');
        saveNote(name, icerik);
        broadcast({ type: 'content', name, content: icerik, live: true });
        broadcast({ type: 'list', notes: listNotes() });
        gunlukYaz(`url eklendi: "${name}" ← ${b.url}${yazar ? ' (yazar: ' + yazar + ')' : ''}`);
        txt(200, 'eklendi: ' + name);
        iliskiOner(name, desc);
      });
    });
  }

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
  // nota yapistirilan gorseller (~/NotlarSync/files) - parola varsa istenir
  if (url.pathname.startsWith('/files/')) {
    if (!authOk(keyOf(req, url))) { res.writeHead(401); res.end('parola'); return; }
    const fp = path.join(DATA_DIR, 'files', path.basename(url.pathname));
    return fs.readFile(fp, (err, data) => {
      if (err) { res.writeHead(404); res.end('yok'); return; }
      const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
      res.writeHead(200, { 'Content-Type': types[path.extname(fp)] || 'application/octet-stream' });
      res.end(data);
    });
  }
  // GRAPHIFY görünümü: kendine yeten graph.html'i uygulama içine gömmek için sun (auth'lu)
  if (url.pathname === '/graphify' || url.pathname === '/graphify/') {
    if (!authOk(keyOf(req, url))) { res.writeHead(401); res.end('parola'); return; }
    const fp = path.join(__dirname, 'graphify-out', 'graph.html');
    return fs.readFile(fp, (err, data) => {
      if (err) { res.writeHead(404); res.end('graphify-out/graph.html yok'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  }
  // AI RED TEAM PANOSU: radarın ürettiği özel panoyu uygulama içinde sun (auth'lu, local).
  if (url.pathname === '/pano' || url.pathname === '/pano/') {
    if (!authOk(keyOf(req, url))) { res.writeHead(401); res.end('parola'); return; }
    const fp = path.join(require('os').homedir(), 'ai-redteam-radar', 'site', 'index.html');
    return fs.readFile(fp, (err, data) => {
      if (err) { res.writeHead(404); res.end('pano henüz üretilmedi (radar bir tur dönünce oluşur)'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  }
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
  if (!authOk(key)) { ws.close(4001, 'parola yanlis'); return; }

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

      // cakisma korumali kayit: istemci kopukken yazdi ve geri geldi. base =
      // en son mutabik kalinan icerigin ozeti. Sunucu bu arada degistiyse
      // istemcinin surumu "(cakisma SAAT)" kopyasina alinir - KIMSE sessizce
      // ezilmez (son-yazan-kazanir'in durust hali; CRDT kadar akilli degil
      // ama veri kaybetmez).
      if (m.type === 'edit-safe' && typeof m.content === 'string') {
        const cur = readNote(name) ?? '';
        const ozet = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36); };
        if (!m.base || ozet(cur) === m.base || cur === m.content) {
          saveNote(name, m.content);
          broadcast({ type: 'content', name, content: m.content, live: true }, ws);
          ws.send(JSON.stringify({ type: 'content', name, content: m.content }));
        } else {
          const saat = new Date();
          const kopya = safeName(`${name} - çakışma ${String(saat.getHours()).padStart(2, '0')}.${String(saat.getMinutes()).padStart(2, '0')}`);
          saveNote(kopya, m.content);
          ws.send(JSON.stringify({ type: 'conflict', name, copy: kopya }));
          ws.send(JSON.stringify({ type: 'content', name, content: cur }));
          broadcast({ type: 'list', notes: listNotes() });
          ws.send(JSON.stringify({ type: 'list', notes: listNotes() }));
        }
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
