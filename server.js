// notlar-sync: iki PC arasi anlik senkron not uygulamasi
// Calistir: node server.js  ->  http://<bu-pc-ip>:7777
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const { buildGraph, buildReport, explainNode, shortestPath, normName } = require('./graph');
const zihin = require('./zihin');
const kopru = require('./kopru');
const esl = require('./eslestirme');
const installer = require('./installer');
const obsidian = require('./obsidian');
const memory = require('./memory');
const integrations = require('./integrations');
const peerSync = require('./peer-sync');
const APP_VERSION = require('./package.json').version;

// veriler kullanicinin ev dizininde: paketli uygulamada __dirname salt-okunur (asar)
const DATA_DIR = path.join(require('os').homedir(), 'NotlarSync');
const NOTES_DIR = path.join(DATA_DIR, 'notes');
const TRASH_DIR = path.join(DATA_DIR, 'trash');
fs.mkdirSync(NOTES_DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(TRASH_DIR, { recursive: true, mode: 0o700 });
for (const dir of [DATA_DIR, NOTES_DIR, TRASH_DIR]) {
  try { fs.chmodSync(dir, 0o700); } catch {}
}
const memoryStore = memory.createStore(DATA_DIR);
const integrationManager = integrations.createManager(DATA_DIR, __dirname);
let replicaSync = null;

// Not/kasa/config yazmalari once ayni dizinde gecici dosyaya, sonra rename ile
// hedefe gider. Uygulama ya da makine yazma aninda kapanirsa yarim dosya kalmaz.
function atomikYaz(file, data, { encoding = 'utf8', mode = 0o600 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(file), 0o700); } catch {}
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const opt = { mode };
  if (encoding) opt.encoding = encoding;
  fs.writeFileSync(tmp, data, opt);
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    if (!['EEXIST', 'EPERM'].includes(e.code) || !fs.existsSync(file)) {
      try { fs.unlinkSync(tmp); } catch {}
      throw e;
    }
    fs.unlinkSync(file);
    fs.renameSync(tmp, file);
  }
  try { fs.chmodSync(file, mode); } catch {}
}

// config yoksa ornekten olustur (ilk acilis) — parolayi rastgele uret,
// GitHub'dan indiren herkes ayni bilinen varsayilan parolayla kalmasin
const CONFIG_PATH = path.join(DATA_DIR, 'app-config.json');
const VAULT_PATH = path.join(DATA_DIR, 'vault.enc');
const VAULT_BACKUP_PATH = path.join(DATA_DIR, 'vault.enc.bak');
const VAULT_RESET_BACKUP_PATH = path.join(DATA_DIR, 'vault.enc.reset.bak');
if (!fs.existsSync(CONFIG_PATH)) {
  const example = fs.readFileSync(path.join(__dirname, 'app-config.example.json'), 'utf8');
  atomikYaz(CONFIG_PATH, example.replace('degistir-beni', crypto.randomBytes(16).toString('base64url')));
}
try { fs.chmodSync(CONFIG_PATH, 0o600); } catch {}
for (const file of [VAULT_PATH, VAULT_BACKUP_PATH, VAULT_RESET_BACKUP_PATH]) {
  if (fs.existsSync(file)) try { fs.chmodSync(file, 0o600); } catch {}
}
let config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const PORT = Number(process.env.PORT) || Number(config.port) || 7777;
let PASSWORD = config.password ?? ''; // "" = parola kapali
// cevap modeli config'ten (qwen3:14b'ye gecis tek satir), varsayilan 8b
let CEVAP_MODELI = config.cevapModeli || 'qwen3:8b';

// Bir istek yetkili mi? Kabul edilen anahtar = ana parola VEYA eslestirmeyle
// uretilmis bir cihaz token'i. Parola "" ise herkese acik (yerel kullanim).
// Yeni istemciler X-Api-Key kullanir. Eski ?key= destegi yalniz geriye uyumluluk
// icindir; yeni kod anahtari URL/log/gecmise yazmamalidir.
const WEB_SESSIONS = new Map();
const WEB_SESSION_MS = 12 * 60 * 60 * 1000;
function sessionIdOf(req) {
  const cookies = String(req?.headers?.cookie || '').split(';');
  const raw = cookies.find((c) => c.trim().startsWith('notlar_session='));
  if (!raw) return '';
  try { return decodeURIComponent(raw.trim().slice('notlar_session='.length)); }
  catch { return ''; }
}
function sessionCredential(req) {
  const sid = sessionIdOf(req);
  if (!sid) return '';
  const session = WEB_SESSIONS.get(sid);
  if (!session || session.expiresAt <= Date.now()) {
    WEB_SESSIONS.delete(sid);
    return '';
  }
  session.expiresAt = Date.now() + WEB_SESSION_MS;
  return session.credential;
}
function keyOf(req, url) {
  return (req && req.headers && req.headers['x-api-key'])
    || url.searchParams.get('key')
    || sessionCredential(req)
    || '';
}
function guvenliEsit(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function authBilgisi(k) {
  if (!PASSWORD) return { ok: true, role: 'master', deviceId: null };
  if (guvenliEsit(k, PASSWORD)) return { ok: true, role: 'master', deviceId: null };
  const cihaz = esl.cihazBul(DATA_DIR, k);
  if (cihaz) {
    esl.tokenGoruldu(DATA_DIR, k, zihin.simdi());
    return { ok: true, role: 'device', deviceId: cihaz.id };
  }
  return { ok: false, role: null, deviceId: null };
}
const authOk = (k) => authBilgisi(k).ok;

function configKaydet(next) {
  atomikYaz(CONFIG_PATH, JSON.stringify(next, null, 2));
  config = next;
  PASSWORD = config.password ?? '';
  CEVAP_MODELI = config.cevapModeli || 'qwen3:8b';
}

function normalizeAvciUrl(value) {
  const target = new URL(String(value || 'http://127.0.0.1:7788/'));
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname.toLowerCase());
  if (!['http:', 'https:'].includes(target.protocol) || !loopback || target.username || target.password || target.hash)
    throw new Error('Saldiri Avcisi adresi yalniz yerel http/https adresi olabilir');
  return target.href;
}

function configuredAvciUrl() {
  return normalizeAvciUrl(process.env.NOTLAR_AVCI_URL || config.avciUrl || 'http://127.0.0.1:7788/');
}

async function avciStatus() {
  let target;
  try { target = new URL(configuredAvciUrl()); }
  catch (error) { return { online: false, url: '', reason: String(error.message || error), checkedAt: Date.now() }; }
  const targetPort = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
  if (targetPort === PORT && ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname.toLowerCase())) {
    return { online: false, url: target.href, reason: `Port ${PORT} Notlar Sync tarafindan kullaniliyor`, checkedAt: Date.now() };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(target, { method: 'GET', redirect: 'manual', signal: controller.signal });
    try { await response.body?.cancel(); } catch {}
    if (response.status >= 500) {
      return { online: false, url: target.href, status: response.status, reason: `Servis HTTP ${response.status} dondurdu`, checkedAt: Date.now() };
    }
    return { online: true, url: target.href, status: response.status, checkedAt: Date.now() };
  } catch (error) {
    const reason = error?.name === 'AbortError' ? 'Servis zamaninda yanit vermedi' : 'Yerel servis calismiyor veya erisilemiyor';
    return { online: false, url: target.href, reason, checkedAt: Date.now() };
  } finally { clearTimeout(timeout); }
}

// --- yardimcilar ---
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const safeName = (n) => {
  if (typeof n !== 'string') return '';
  const out = n.normalize('NFC').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 120);
  return !out || out === '.' || out === '..' || out.startsWith('.') || WINDOWS_RESERVED.test(out) ? '' : out;
};
function safeRelativePath(value, allowEmpty = false) {
  if (typeof value !== 'string') return '';
  const raw = value.normalize('NFC').replace(/\\/g, '/').trim().replace(/^\/+|\/+$/g, '');
  if (!raw) return allowEmpty ? '' : '';
  const parts = raw.split('/');
  if (parts.length > 16 || parts.some((part) => !part || part === '.' || part === '..')) return '';
  const clean = parts.map(safeName);
  return clean.every(Boolean) ? clean.join('/') : '';
}
const safeNoteId = (value) => safeRelativePath(value);
const safeFolderId = (value) => safeRelativePath(value);
function notePath(value) {
  const id = safeNoteId(value);
  if (!id) throw new Error('gecersiz not adi');
  const parts = id.split('/');
  return path.join(NOTES_DIR, ...parts.slice(0, -1), parts.at(-1) + '.md');
}
function folderPath(value) {
  const id = safeFolderId(value);
  if (!id) throw new Error('gecersiz klasor adi');
  return path.join(NOTES_DIR, ...id.split('/'));
}
function walkNotes(dir = NOTES_DIR, prefix = '') {
  const notes = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return notes; }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) notes.push(...walkNotes(path.join(dir, entry.name), relative));
    else if (entry.isFile() && entry.name.endsWith('.md')) notes.push(relative.slice(0, -3));
  }
  return notes;
}
function listNotes() {
  return walkNotes().sort((a, b) => a.localeCompare(b, 'tr'));
}
function walkFolders(dir = NOTES_DIR, prefix = '') {
  const folders = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return folders; }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    folders.push(relative, ...walkFolders(path.join(dir, entry.name), relative));
  }
  return folders;
}
function listFolders() {
  return walkFolders().sort((a, b) => a.localeCompare(b, 'tr'));
}
const noteParent = (name) => name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '';
const noteBase = (name) => name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name;
const noteWithSuffix = (name, suffix) => {
  const parent = noteParent(name);
  return `${parent ? parent + '/' : ''}${noteBase(name)}${suffix}`;
};
for (const folder of [NOTES_DIR, ...listFolders().map(folderPath)]) {
  try { fs.chmodSync(folder, 0o700); } catch {}
}
for (const note of listNotes()) {
  try { fs.chmodSync(notePath(note), 0o600); } catch {}
}

// en guncel icerik RAM'de: disk 400ms geride kalabilir, okumalar buradan beslenir
const latest = {};
const saveTimers = {};
const pendingCreates = new Set();
const internalFsEvents = new Map();
function noteSignature(name) {
  try {
    const stat = fs.statSync(notePath(name));
    return `${stat.mtimeMs}:${stat.size}`;
  } catch { return null; }
}
function markInternalFs(name, deleted = false) {
  internalFsEvents.set(name, {
    signature: deleted ? null : noteSignature(name),
    expiresAt: Date.now() + 1500,
  });
}
function isExpectedFsEvent(name, signature, now) {
  const marker = internalFsEvents.get(name);
  if (!marker) return false;
  if (marker.expiresAt <= now) { internalFsEvents.delete(name); return false; }
  return marker.signature === signature;
}
const icerikHash = (s) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
};
function replicaTrack(name, deleted = false) {
  if (!replicaSync) return;
  try {
    if (deleted) replicaSync.noteDeleted(name);
    else replicaSync.noteChanged(name);
  } catch (error) {
    console.log('peer sync kaydi yapilamadi:', String(error.message || error).slice(0, 180));
  }
}

// tarayici eklentisinin yakaladigi sifreler — SADECE RAM, diske/git'e asla yazilmaz
let pending = [];

function readNote(name) {
  // Diske yazilmayi bekleyen canli tuslar RAM'den gelir. Bekleyen yazma yoksa
  // dosya her okumada diskten alinir; AI/editor gibi dis araclarin dogrudan
  // yaptigi .md degisiklikleri eski RAM kopyasiyla ezilmez.
  if (saveTimers[name] && latest[name] !== undefined) return latest[name];
  const fp = notePath(name);
  if (!fs.existsSync(fp)) return undefined;
  const content = fs.readFileSync(fp, 'utf8');
  latest[name] = content;
  return content;
}

function saveNote(name, content) {
  clearTimeout(saveTimers[name]); // bekleyen eski yazma, yeniyi ezmesin
  delete saveTimers[name];
  pendingCreates.delete(name);
  latest[name] = content;
  atomikYaz(notePath(name), content);
  markInternalFs(name);
  replicaTrack(name);
  autoPush();
  fireWebhook('not-kaydedildi', name);
  otoZihin(name); // arka plan zekasi: sessizlik sonrasi oneri taramasi
}

function flushPendingSaves() {
  for (const name of Object.keys(saveTimers)) {
    if (latest[name] === undefined) continue;
    clearTimeout(saveTimers[name]);
    delete saveTimers[name];
    const wasNew = pendingCreates.delete(name);
    saveNote(name, latest[name]);
    broadcast({ type: 'saved', name, hash: icerikHash(latest[name]) });
    if (wasNew) broadcast({ type: 'list', notes: listNotes(), folders: listFolders() });
  }
}

const TRASH_INDEX = path.join(TRASH_DIR, 'index.json');
function trashOku() {
  try {
    const d = JSON.parse(fs.readFileSync(TRASH_INDEX, 'utf8'));
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}
function trashYaz(list) { atomikYaz(TRASH_INDEX, JSON.stringify(list, null, 2)); }

function deleteNote(name) {
  clearTimeout(saveTimers[name]); // yoksa silinen not 400ms icinde dirilir
  delete saveTimers[name];
  pendingCreates.delete(name);
  delete latest[name];
  const fp = notePath(name);
  if (!fs.existsSync(fp)) return false;
  const id = Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
  const hedef = path.join(TRASH_DIR, id + '.md');
  fs.renameSync(fp, hedef);
  try { fs.chmodSync(hedef, 0o600); } catch {}
  const list = trashOku();
  list.unshift({ id, name, deletedAt: new Date().toISOString(), file: path.basename(hedef) });
  for (const dropped of list.slice(1000)) {
    try { fs.unlinkSync(path.join(TRASH_DIR, dropped.file)); } catch {}
  }
  trashYaz(list.slice(0, 1000));
  markInternalFs(name, true);
  replicaTrack(name, true);
  autoPush();
  fireWebhook('not-silindi', name);
  return true;
}

function trashListele() {
  return trashOku().filter((x) => fs.existsSync(path.join(TRASH_DIR, x.file)))
    .map(({ file, ...x }) => x);
}

function trashGeriYukle(id) {
  const list = trashOku();
  const i = list.findIndex((x) => x.id === id);
  if (i === -1) return null;
  const item = list[i];
  const src = path.join(TRASH_DIR, item.file);
  if (!fs.existsSync(src)) return null;
  let name = safeNoteId(item.name) || 'Kurtarilan Not';
  if (fs.existsSync(notePath(name))) {
    const base = name;
    let n = 2;
    while (fs.existsSync(notePath(noteWithSuffix(base, ` (${n})`)))) n++;
    name = noteWithSuffix(base, ` (${n})`);
  }
  fs.mkdirSync(path.dirname(notePath(name)), { recursive: true, mode: 0o700 });
  fs.renameSync(src, notePath(name));
  try { fs.chmodSync(notePath(name), 0o600); } catch {}
  list.splice(i, 1);
  trashYaz(list);
  markInternalFs(name);
  replicaTrack(name);
  autoPush();
  fireWebhook('not-geri-yuklendi', name);
  return name;
}

function trashKaliciSil(id) {
  const list = trashOku();
  const i = list.findIndex((x) => x.id === id);
  if (i === -1) return false;
  try { fs.unlinkSync(path.join(TRASH_DIR, list[i].file)); } catch {}
  list.splice(i, 1);
  trashYaz(list);
  autoPush();
  return true;
}

function renameNote(oldName, newName) {
  const oldPath = notePath(oldName);
  const clean = safeNoteId(newName);
  if (!clean) return { hata: 'gecersiz not adi' };
  if (!fs.existsSync(oldPath)) return { hata: 'not yok' };
  if (clean !== oldName && fs.existsSync(notePath(clean))) return { hata: 'bu adda not zaten var' };
  if (saveTimers[oldName] && latest[oldName] !== undefined) saveNote(oldName, latest[oldName]);
  clearTimeout(saveTimers[oldName]);
  delete saveTimers[oldName];
  fs.mkdirSync(path.dirname(notePath(clean)), { recursive: true, mode: 0o700 });
  fs.renameSync(oldPath, notePath(clean));
  latest[clean] = latest[oldName];
  delete latest[oldName];
  markInternalFs(oldName, true);
  markInternalFs(clean);
  replicaTrack(oldName, true);
  replicaTrack(clean);
  const changed = [];
  let linksUpdated = 0;
  const oldNorm = normName(oldName);
  const oldBaseNorm = normName(noteBase(oldName));
  const newBase = noteBase(clean);
  const linkRe = /\[\[([^\]|#\n]+)([^\]\n]*)\]\]/g;
  for (const note of listNotes()) {
    const content = readNote(note) || '';
    let updated = content.replace(linkRe, (whole, target, suffix) => {
      const targetNorm = normName(target);
      if (targetNorm !== oldNorm && targetNorm !== oldBaseNorm) return whole;
      linksUpdated++;
      return `[[${targetNorm === oldNorm ? clean : newBase}${suffix}]]`;
    });
    if (note === clean && updated.startsWith('---')) {
      const end = updated.indexOf('\n---', 3);
      if (end !== -1) {
        const head = updated.slice(0, end).replace(/^name:\s*.*$/m, `name: ${newBase}`);
        updated = head + updated.slice(end);
      }
    }
    if (updated === content) continue;
    saveNote(note, updated);
    changed.push({ name: note, content: updated });
  }
  if (Array.isArray(config.pinnedNotes) && config.pinnedNotes.includes(oldName)) {
    configKaydet({ ...config, pinnedNotes: config.pinnedNotes.map((name) => name === oldName ? clean : name) });
  }
  autoPush();
  fireWebhook('not-yeniden-adlandirildi', clean);
  return { name: clean, linksUpdated, changed, content: readNote(clean) || '' };
}

function createFolder(value) {
  const name = safeFolderId(value);
  if (!name) return { hata: 'gecersiz klasor adi' };
  const target = folderPath(name);
  if (fs.existsSync(target)) return { hata: 'bu klasor zaten var' };
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  for (let dir = target; dir.startsWith(NOTES_DIR + path.sep); dir = path.dirname(dir)) {
    try { fs.chmodSync(dir, 0o700); } catch {}
    if (dir === NOTES_DIR) break;
  }
  autoPush();
  return { name };
}

function renameFolder(oldValue, newValue) {
  const oldName = safeFolderId(oldValue);
  const clean = safeFolderId(newValue);
  if (!oldName || !clean) return { hata: 'gecersiz klasor adi' };
  if (clean === oldName) return { name: clean, moved: [] };
  if (clean.startsWith(oldName + '/')) return { hata: 'klasor kendi icine tasinamaz' };
  const source = folderPath(oldName);
  const target = folderPath(clean);
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) return { hata: 'klasor yok' };
  if (fs.existsSync(target)) return { hata: 'hedef klasor zaten var' };
  const affected = listNotes().filter((name) => name.startsWith(oldName + '/'));
  for (const name of affected) if (saveTimers[name] && latest[name] !== undefined) saveNote(name, latest[name]);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.renameSync(source, target);
  const moved = [];
  for (const oldNote of affected) {
    const next = clean + oldNote.slice(oldName.length);
    clearTimeout(saveTimers[oldNote]);
    delete saveTimers[oldNote];
    if (Object.prototype.hasOwnProperty.call(latest, oldNote)) {
      latest[next] = latest[oldNote];
      delete latest[oldNote];
    }
    markInternalFs(oldNote, true);
    markInternalFs(next);
    replicaTrack(oldNote, true);
    replicaTrack(next);
    moved.push({ from: oldNote, to: next });
  }
  if (Array.isArray(config.pinnedNotes)) {
    const pinnedNotes = config.pinnedNotes.map((name) => name.startsWith(oldName + '/') ? clean + name.slice(oldName.length) : name);
    configKaydet({ ...config, pinnedNotes });
  }
  autoPush();
  return { name: clean, moved };
}

function deleteFolder(value) {
  const name = safeFolderId(value);
  if (!name) return { hata: 'gecersiz klasor adi' };
  const target = folderPath(name);
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) return { hata: 'klasor yok', code: 404 };
  if (fs.readdirSync(target).length) return { hata: 'klasor bos degil', code: 409 };
  fs.rmdirSync(target);
  autoPush();
  return { ok: true };
}

function cleanImportPath(relative, stripMarkdown = false) {
  let value = String(relative || '').normalize('NFC').replace(/\\/g, '/');
  if (stripMarkdown) value = value.replace(/\.md$/i, '');
  const parts = value.split('/').filter(Boolean).map(safeName);
  return parts.every(Boolean) ? parts.join('/') : '';
}

function importObsidianVault(requestedPath) {
  const available = obsidian.discover().map((vaultPath) => fs.realpathSync(vaultPath));
  let source;
  try { source = fs.realpathSync(requestedPath); } catch { return { hata: 'Obsidian kasasi bulunamadi' }; }
  if (!available.includes(source)) return { hata: 'yalniz algilanan Obsidian kasalari ice aktarilabilir' };
  const data = obsidian.scan(source, { readContent: true });
  const assetRoot = safeName(data.name) || 'Obsidian';
  const assetMap = new Map();
  const basenameMap = new Map();
  let assets = 0;

  for (const asset of data.assets) {
    const clean = cleanImportPath(asset.relative);
    if (!clean) continue;
    const target = path.join(DATA_DIR, 'files', 'obsidian', assetRoot, ...clean.split('/'));
    try {
      atomikYaz(target, fs.readFileSync(asset.absolute), { encoding: null });
      const url = ['files', 'obsidian', assetRoot, ...clean.split('/')].map(encodeURIComponent).join('/');
      const key = asset.relative.normalize('NFC').replace(/\\/g, '/');
      assetMap.set(key, url);
      const base = path.posix.basename(key).toLocaleLowerCase('tr');
      if (!basenameMap.has(base)) basenameMap.set(base, url);
      else basenameMap.set(base, null);
      assets++;
    } catch {}
  }

  const resolveAsset = (target, noteRelative) => {
    let decoded = String(target || '').trim().replace(/^<|>$/g, '').split('#')[0];
    try { decoded = decodeURIComponent(decoded); } catch {}
    if (!decoded || /^[a-z]+:/i.test(decoded) || decoded.startsWith('/')) return null;
    const fromNote = path.posix.normalize(path.posix.join(path.posix.dirname(noteRelative), decoded));
    const fromRoot = path.posix.normalize(decoded.replace(/^\.\//, ''));
    if (!fromNote.startsWith('../') && assetMap.has(fromNote)) return assetMap.get(fromNote);
    if (!fromRoot.startsWith('../') && assetMap.has(fromRoot)) return assetMap.get(fromRoot);
    return basenameMap.get(path.posix.basename(decoded).toLocaleLowerCase('tr')) || null;
  };

  let imported = 0, skipped = 0, conflicts = 0;
  const createdFolders = new Set();
  for (const folder of data.folders) {
    const clean = cleanImportPath(folder);
    if (!clean || fs.existsSync(folderPath(clean))) continue;
    const result = createFolder(clean);
    if (!result.hata) createdFolders.add(clean);
  }
  for (const item of data.notes) {
    let name = cleanImportPath(item.relative, true);
    if (!name) { skipped++; continue; }
    let content = item.content;
    content = content.replace(/!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (whole, target, alias) => {
      const url = resolveAsset(target, item.relative);
      return url ? `![${alias || path.posix.basename(target)}](${url})` : whole;
    });
    content = content.replace(/(!?\[[^\]]*\])\(([^)]+)\)/g, (whole, label, target) => {
      const url = resolveAsset(target, item.relative);
      return url ? `${label}(${url})` : whole;
    });
    if (readNote(name) !== undefined) {
      if (readNote(name) === content) { skipped++; continue; }
      let candidate = noteWithSuffix(name, ' (Obsidian)');
      let index = 2;
      while (readNote(candidate) !== undefined) candidate = noteWithSuffix(name, ` (Obsidian ${index++})`);
      name = candidate;
      conflicts++;
    }
    saveNote(name, content);
    imported++;
  }
  return {
    ok: true,
    vault: data.name,
    source: data.root,
    imported,
    skipped,
    conflicts,
    assets,
    folders: new Set([...data.folders.map((folder) => cleanImportPath(folder)).filter(Boolean), ...createdFolders]).size,
  };
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
let pushTimer, pushRunning = false, pushAgain = false;
function runGit(args, cb) {
  execFile('git', args, { cwd: DATA_DIR, timeout: 120000, maxBuffer: 2e6 }, cb);
}
function gitBackup() {
  if (pushRunning) { pushAgain = true; return; }
  pushRunning = true;
  const finish = (error) => {
    if (error) console.log('git yedegi olmadi:', String(error.message || error).trim().split('\n')[0]);
    pushRunning = false;
    if (pushAgain) { pushAgain = false; autoPush(); }
  };
  const stage = () => runGit(['add', '-A'], (addError) => {
    if (addError) return finish(addError);
    runGit(['diff', '--cached', '--quiet'], (diffError) => {
      if (!diffError) return finish();
      if (diffError.code !== 1) return finish(diffError);
      runGit(['commit', '-m', 'oto-kayit'], (commitError) => {
        if (commitError) return finish(commitError);
        runGit(['remote', 'get-url', 'origin'], (remoteError) => {
          if (remoteError) {
            console.log('yerel git yedegi alindi; GitHub icin origin adresi ayarlanmamis');
            return finish();
          }
          runGit(['push', '-u', 'origin', 'HEAD'], (pushError) => finish(pushError));
        });
      });
    });
  });
  runGit(['rev-parse', '--is-inside-work-tree'], (repoError) => {
    if (!repoError) return stage();
    runGit(['init', '-b', 'main'], (initError) => initError ? finish(initError) : stage());
  });
}
function autoPush() {
  if (!config.gitAutoPush) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    // parola/kasa ASLA repoya girmesin
    const gi = path.join(DATA_DIR, '.gitignore');
    let cur = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
    // devices.json bearer token tasir; yedek reposu private olsa bile kimlik
    // bilgisi Git'e girmemeli. Embed/timer dosyalari da tekrar uretilebilir.
    for (const must of ['app-config.json', 'vault.enc', 'vault.enc.bak', 'vault.enc.reset.bak', 'devices.json', 'embed-cache.json', 'oto-bekleyen.json', 'runtime/', 'memory/'])
      if (!cur.split('\n').includes(must)) cur += (cur && !cur.endsWith('\n') ? '\n' : '') + must + '\n';
    atomikYaz(gi, cur);
    gitBackup();
  }, config.gitPushDelayMs || 30000); // son degisiklikten 30sn sonra tek seferde
}

// --- graf onbellegi (artimli guncelleme): notlar degismedikce graf yeniden
// hesaplanmaz. Parmak izi = dosya adi+mtime+boyut (stat, tam okumadan cok ucuz);
// dis degisiklikleri de yakalar (git pull, elle duzenleme). Ayrica kuculme
// korumasi: disk gecici okunamazsa bos graf yerine SON SAGLAM graf sunulur.
const gCache = new Map(); // hideHidden(bool) -> { fp, graph }
function notesFingerprint() {
  try {
    return listNotes()
      .map((name) => { const s = fs.statSync(notePath(name)); return name + ':' + s.mtimeMs + ':' + s.size; })
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

function memoryExternalItems(input = {}) {
  const query = memory.normalizeForSearch(input.query || input.goal || '');
  const queryTokens = new Set(query.split(/\s+/).filter((token) => token.length > 1));
  if (!queryTokens.size) return [];
  const graph = getGraph(false);
  const matched = new Set();
  const boosted = new Map();
  for (const node of graph.nodes) {
    const haystack = memory.normalizeForSearch(`${node.label || ''} ${node.description || ''}`);
    const words = new Set(haystack.split(/\s+/));
    if ([...queryTokens].some((token) => words.has(token) || haystack.includes(token))) {
      matched.add(node.id);
      boosted.set(node.id, 14);
    }
  }
  for (const edge of graph.edges) {
    if (matched.has(edge.source)) boosted.set(edge.target, Math.max(boosted.get(edge.target) || 0, 7));
    if (matched.has(edge.target)) boosted.set(edge.source, Math.max(boosted.get(edge.source) || 0, 7));
  }
  const nodeByFile = new Map(graph.nodes.filter((node) => node.file)
    .map((node) => [node.file.replace(/\.md$/, ''), node]));
  return listNotes().map((name) => {
    const node = nodeByFile.get(name);
    let updatedAt = new Date(0).toISOString();
    try { updatedAt = fs.statSync(notePath(name)).mtime.toISOString(); } catch {}
    return {
      id: `note:${name}`,
      sourceType: 'note',
      kind: 'note',
      title: node?.label || noteBase(name),
      text: (readNote(name) || '').slice(0, 8000),
      updatedAt,
      graphBoost: node ? (boosted.get(node.id) || 0) : 0,
      tags: ['not', noteParent(name)].filter(Boolean),
      source: { note: name },
    };
  });
}

function memoryRecall(input, cb) {
  const query = String(input.query || input.goal || '').trim();
  const wantedLimit = Math.max(1, Math.min(50, Number(input.limit) || 12));
  const externalItems = memoryExternalItems(input);
  if (!query) return cb(null, memoryStore.recall({ ...input, limit: wantedLimit }, externalItems));
  const initial = memoryStore.recall({ ...input, limit: Math.max(30, wantedLimit), noTouch: true }, externalItems);
  let completed = false;
  const finish = (result) => {
    if (completed) return;
    completed = true;
    clearTimeout(fallbackTimer);
    cb(null, result);
  };
  // Yerel embedding modeli soğuk veya meşgul olduğunda kullanıcı aramasını
  // dakikalarca bekletme; sözcüksel + graf sıralaması her zaman hazırdır.
  const fallbackTimer = setTimeout(() => {
    const fallback = memoryStore.recall({ ...input, limit: wantedLimit }, externalItems);
    fallback.semanticFallback = true;
    finish(fallback);
  }, 8000);
  zihin.findEmbedModel((model) => {
    if (!model || !initial.results.length)
      return finish(memoryStore.recall({ ...input, limit: wantedLimit }, externalItems));
    const texts = [query, ...initial.results.map((item) => `${item.title || ''}: ${item.text || ''}`.slice(0, 4000))];
    zihin.embedCached(DATA_DIR, model, texts, (vectors) => {
      const queryVector = vectors[0];
      if (!queryVector) return finish(memoryStore.recall({ ...input, limit: wantedLimit }, externalItems));
      const semanticScores = initial.results.map((item, index) => ({
        id: item.id,
        score: memory.cosine(queryVector, vectors[index + 1]),
      }));
      const result = memoryStore.recall({ ...input, limit: wantedLimit, semanticScores }, externalItems);
      result.embeddingModel = model;
      finish(result);
    });
  });
}

function overviewData(auth) {
  const g = getGraph(true);
  const degree = new Map(g.nodes.map((n) => [n.file ? n.file.replace(/\.md$/, '') : n.label, n.degree || 0]));
  const pinned = new Set(Array.isArray(config.pinnedNotes) ? config.pinnedNotes : []);
  const notes = listNotes().filter((n) => !/^AI-Hafiza/i.test(noteBase(n))).map((name) => {
    const fp = notePath(name);
    let stat = { mtimeMs: 0, size: 0 };
    try { stat = fs.statSync(fp); } catch {}
    const content = readNote(name) || '';
    const body = content.replace(/^---[\s\S]*?---\s*/, '').replace(/[#*_`>\[\]]/g, '').replace(/\s+/g, ' ').trim();
    const tags = [...content.matchAll(/(?:^|\s)#([\p{L}\d_-]+)/gu)].map((m) => m[1]).slice(0, 5);
    return {
      name,
      modifiedAt: stat.mtimeMs ? new Date(stat.mtimeMs).toISOString() : null,
      size: stat.size,
      snippet: body.slice(0, 140),
      links: degree.get(name) || 0,
      tags,
      pinned: pinned.has(name),
    };
  }).sort((a, b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt)));
  const oneriler = zihin.prune(DATA_DIR, getGraph(false)).oneriler;
  return {
    notes: notes.slice(0, 12),
    pinned: notes.filter((n) => n.pinned).slice(0, 8),
    stats: {
      notes: notes.length,
      links: g.edges.length,
      orphans: g.nodes.filter((n) => !n.ghost && n.degree === 0).length,
      brokenLinks: g.nodes.filter((n) => n.ghost).length,
      pendingSuggestions: oneriler.length,
      trash: trashListele().length,
      devices: auth.role === 'master' ? esl.cihazlariPublic(DATA_DIR).length : null,
    },
    sync: {
      role: auth.role,
      connected: typeof wss !== 'undefined' ? [...wss.clients].filter((c) => c.authed).length : 0,
      backupEnabled: !!config.gitAutoPush,
    },
  };
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
  try { atomikYaz(OTO_BEKLEYEN, JSON.stringify({ zaman: zihin.simdi(), not: name })); } catch {}
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

// ---- AI KONSEY: yerel CLI ajanlarini calistir (claude -p / codex exec) ----
// AI URETMEZ bir sey; kullanicinin GIRIS YAPMIS CLI'lari birbiriyle konusur.
// Her cagride tum transcript prompt'a gomulur (CLI'lar hafizasiz) -> oturum-ici hatirlama.
// PATH'i genislet: codex node'un bin dizininde (process.execPath yani), claude ~/.local/bin'de.
const KONSEY_ENV = {};
for (const key of [
  'HOME', 'USER', 'LOGNAME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TMP', 'TEMP', 'TMPDIR',
  'LANG', 'LC_ALL', 'TZ', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'SSL_CERT_FILE', 'SSL_CERT_DIR',
]) if (process.env[key]) KONSEY_ENV[key] = process.env[key];
KONSEY_ENV.PATH = [
  path.dirname(process.execPath),
  path.join(require('os').homedir(), '.local/bin'),
  path.join(require('os').homedir(), '.npm-global/bin'),
  process.env.PATH || '',
].join(path.delimiter);
KONSEY_ENV.NO_COLOR = '1';
const KONSEY_MAX_MESSAGE = 20000;
const KONSEY_MAX_TRANSCRIPT = 100000;
const KONSEY_MAX_OUTPUT = 1024 * 1024;
const KONSEY_TIMEOUT_MS = 120000;
const KONSEY_MODELS = {
  Claude: new Set(['opus', 'sonnet', 'haiku', 'fable']),
  Codex: new Set(['gpt-5.5', 'gpt-5-codex', 'o3']),
};
let konseyActive = 0;
// AVCI motoru: Avci kaynak dizininde motor.py'yi calistirir, sonra katalogu notes'a aktarir.
const AVCI_DIR = path.join(require('os').homedir(), 'ai-saldiri-avcisi');
const AVCI_EXPORT = path.join(__dirname, 'avci', 'notlara_aktar.py');
const AVCI_MOTOR_LOG = path.join(__dirname, 'avci', 'motor.log');
let avciMotor = { running: false, katalog: '', kapsam: '', startedAt: 0 };
let avciBakim = { running: false, katalog: '', startedAt: 0 };
const AVCI_BAKIM_LOG = path.join(__dirname, 'avci', 'bakim.log');
let avciDuzenle = { running: false, islem: '', tid: '', startedAt: 0 };
const AVCI_DUZENLE_LOG = path.join(__dirname, 'avci', 'duzenle.log');
function konseyPrompt(isim, soru, transcript) {
  return (
    `Sen '${isim}' adli bir yapay zekasin ve bir kanalda bir insan ile baska bir yapay zeka ` +
    `ile birliktesin; hepiniz ayni gecmisi goruyorsunuz. Turkce, net ve oz konus. Digerinin ` +
    `dediklerine ya KATIL ya KARSI CIK, sebebini soyle. Kendini tekrarlama.\n\n` +
    `SIMDIYE KADARKI KONUSMA:\n${transcript || '(ilk konusan sensin)'}\n\n` +
    `KULLANICININ YENI MESAJI:\n${soru}\n\nSira sende, cevabini yaz.`
  );
}
// spawn + stdin KAPALI (stdio 'ignore'): CLI'lar TTY/stdin beklemesin -> yoksa takilir.
// Her ajan bos, 0700 bir gecici klasorde ve sinirli cikti/zaman kotasiyla calisir.
function cliCalistir(cmd, argsOrFactory, cb) {
  let out = '', err = '', outBytes = 0, errBytes = 0, bitti = false, timer = null;
  const cwd = fs.mkdtempSync(path.join(require('os').tmpdir(), 'notlar-konsey-'));
  try { fs.chmodSync(cwd, 0o700); } catch {}
  const temizle = () => { try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {} };
  const done = (error) => {
    if (bitti) return;
    bitti = true;
    if (timer) clearTimeout(timer);
    try { cb(error, out, err, cwd); } finally { temizle(); }
  };
  let args;
  try { args = typeof argsOrFactory === 'function' ? argsOrFactory(cwd) : argsOrFactory; }
  catch (error) { temizle(); return cb(error, '', '', cwd); }
  let child;
  try {
    child = spawn(cmd, args, { cwd, env: KONSEY_ENV, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch (error) { temizle(); return cb(error, '', '', cwd); }
  const append = (kind, data) => {
    if (bitti) return;
    const buffer = Buffer.from(data);
    const used = kind === 'stdout' ? outBytes : errBytes;
    const remaining = Math.max(0, KONSEY_MAX_OUTPUT - used);
    const text = buffer.subarray(0, remaining).toString('utf8');
    if (kind === 'stdout') { out += text; outBytes += buffer.length; }
    else { err += text; errBytes += buffer.length; }
    if (outBytes > KONSEY_MAX_OUTPUT || errBytes > KONSEY_MAX_OUTPUT) {
      try { child.kill('SIGKILL'); } catch {}
      done(new Error('ajan cikti sinirini asti'));
    }
  };
  timer = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch {}
    done(new Error('zaman asimi (120s)'));
  }, KONSEY_TIMEOUT_MS);
  child.stdout.on('data', (data) => append('stdout', data));
  child.stderr.on('data', (data) => append('stderr', data));
  child.on('error', (error) => done(error));
  child.on('close', (code, signal) => {
    if (code === 0) return done(null);
    done(new Error(`ajan islemi basarisiz (${signal || `kod ${code}`})`));
  });
}
// model bos/"varsayilan" ise bayrak eklenmez -> CLI kendi config default'unu kullanir.
function temizModel(value, provider) {
  const model = String(value || '').trim();
  if (!model || model.toLowerCase() === 'varsayilan') return '';
  if (!KONSEY_MODELS[provider]?.has(model)) throw new Error(`${provider} modeli desteklenmiyor`);
  return model;
}
function claudeCalistir(prompt, model, cb) {
  const m = temizModel(model, 'Claude');
  const args = ['--safe-mode', '--no-session-persistence', '--no-chrome', '--tools', '', ...(m ? ['--model', m] : []), '-p', prompt];
  cliCalistir(process.env.NOTLAR_CLAUDE_BIN || 'claude', args, (err, out, serr) => {
    if (err) return cb(`(claude cevap veremedi: ${String(serr || err.message).slice(0, 200)})`);
    cb(String(out || '').trim() || '(claude bos yanit dondurdu)');
  });
}
function codexCalistir(prompt, model, cb) {
  const m = temizModel(model, 'Codex');
  let outputFile = '';
  cliCalistir(process.env.NOTLAR_CODEX_BIN || 'codex', (cwd) => {
    outputFile = path.join(cwd, 'son-yanit.txt');
    return ['exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--disable', 'shell_tool', '--sandbox', 'read-only', '--skip-git-repo-check', ...(m ? ['-m', m] : []), '--output-last-message', outputFile, prompt];
  }, (err, out, serr) => {
    let ans = '';
    try { ans = fs.readFileSync(outputFile, 'utf8').slice(0, KONSEY_MAX_OUTPUT).trim(); } catch { /* yok */ }
    if (err) return cb(`(codex cevap veremedi: ${String(serr || err.message).slice(0, 200)})`);
    cb(ans || String(out || '').trim() || '(codex bos yanit dondurdu)');
  });
}

// host'un baglanti adresi: once tailscale (100.x) IP, yoksa LAN IP
function getHostAddress(cb) {
  execFile('tailscale', ['ip', '-4'], (e, out) => {
    const ip = (out || '').trim().split('\n')[0];
    if (ip) return cb(ip);
    const nets = require('os').networkInterfaces();
    const candidates = [];
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if (!['IPv4', 4].includes(net.family) || net.internal || /^169\.254\./.test(net.address)) continue;
        const virtual = /docker|veth|br-|virbr|vmnet|virtualbox|wsl/i.test(name) ? 20 : 0;
        const range = /^192\.168\./.test(net.address) ? 0
          : /^10\./.test(net.address) ? 1
            : /^172\.(1[6-9]|2\d|3[01])\./.test(net.address) ? 2 : 5;
        candidates.push({ address: net.address, score: virtual + range });
      }
    }
    candidates.sort((a, b) => a.score - b.score || a.address.localeCompare(b.address));
    cb(candidates[0]?.address || 'localhost');
  });
}

function getAdvertisedUrl(cb) {
  if (process.env.NOTLAR_ADVERTISE_URL) {
    try { return cb(null, peerSync.normalizeUrl(process.env.NOTLAR_ADVERTISE_URL)); }
    catch (error) { return cb(error); }
  }
  getHostAddress((address) => {
    try { cb(null, peerSync.normalizeUrl(`http://${address}:${PORT}`)); }
    catch (error) { cb(error); }
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

function ollamaStatus(cb) {
  const r = http.get({ host: '127.0.0.1', port: 11434, path: '/api/tags', timeout: 1800 }, (resp) => {
    let d = '';
    resp.on('data', (c) => d += c);
    resp.on('end', () => {
      try {
        const j = JSON.parse(d);
        cb({ online: true, models: (j.models || []).map((m) => m.name).filter(Boolean) });
      } catch { cb({ online: false, models: [] }); }
    });
  });
  r.on('error', () => cb({ online: false, models: [] }));
  r.on('timeout', () => { r.destroy(); cb({ online: false, models: [] }); });
}

// --- REST API (AI'lar icin): X-Api-Key basligiyla ---
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

  // Peer eslestirme talebi ve replikasyon trafigi normal kullanici parolasini
  // kullanmaz. Eslestirme kisa omurlu kod + iki tarafli onayla; veri trafigi
  // yalniz 256-bit peer tokeniyla dogrulanir.
  if (url.pathname === '/api/sync/pair/claim' && req.method === 'POST') {
    if (pairHizAsildi(req.socket.remoteAddress || '?', Date.now()))
      return txt(429, 'cok fazla deneme - 1 dakika bekleyin');
    return readBody(req, (error, body) => {
      if (error) return txt(400, error);
      try {
        const result = replicaSync.claimPair(body || {});
        broadcast({ type: 'peer-pair' });
        txt(200, JSON.stringify(result), 'application/json');
      } catch (claimError) { txt(400, String(claimError.message || claimError)); }
    });
  }
  if (url.pathname === '/api/sync/pair/confirm' && req.method === 'POST') {
    return readBody(req, (error, body) => {
      if (error) return txt(400, error);
      try {
        const result = replicaSync.confirmPair(body || {});
        broadcast({ type: 'peer-sync' });
        txt(200, JSON.stringify(result), 'application/json');
      } catch (confirmError) { txt(403, String(confirmError.message || confirmError)); }
    });
  }
  if (url.pathname.startsWith('/api/sync/replica/')) {
    const peer = replicaSync.authenticate(req.headers['x-sync-key']);
    if (!peer) return txt(401, 'peer kimligi dogrulanamadi');
    if (url.pathname === '/api/sync/replica/changes' && req.method === 'GET') {
      flushPendingSaves();
      replicaSync.scan();
      return txt(200, JSON.stringify(replicaSync.changes(url.searchParams.get('since'))), 'application/json');
    }
    if (url.pathname === '/api/sync/replica/content' && req.method === 'GET') {
      const name = safeNoteId(url.searchParams.get('name') || '');
      const hash = String(url.searchParams.get('hash') || '').toLowerCase();
      if (!name) return txt(400, 'gecersiz not yolu');
      if (!/^[a-f0-9]{64}$/.test(hash)) return txt(400, `gecersiz not ozeti (${hash.length})`);
      try {
        const content = replicaSync.readVersion(name, hash);
        res.writeHead(200, {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Length': Buffer.byteLength(content),
          'X-Content-Hash': hash,
          'Cache-Control': 'no-store',
        });
        res.end(content);
      } catch { txt(404, 'not surumu yok'); }
      return;
    }
    return txt(404, 'sync ucu yok');
  }

  // yeni-cihaz tarafi uclari kimlik ISTEMEZ (henuz token'i yok) - guvenlik
  // tek kullanimlik kod + claimId + cift onayla saglanir. Digerleri (kod
  // uretme, host onayi, cihaz listesi) authed'dir, asagida akar.
  if (['/api/pair/claim', '/api/pair/cihaz-onay', '/api/pair/durum'].includes(url.pathname))
    return handlePair(req, res, url, txt);

  const auth = authBilgisi(keyOf(req, url));
  if (!auth.ok) {
    res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('kimlik dogrulanamadi (X-Api-Key)');
    return;
  }
  const masterOnly = () => {
    if (auth.role === 'master') return true;
    txt(403, 'bu islem yalniz ana cihazda yapilabilir');
    return false;
  };
  const localOnly = () => {
    const address = String(req.socket.remoteAddress || '');
    if (address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1') return true;
    txt(403, 'bu işlem yalnız bu bilgisayardaki masaüstü uygulamasından yapılabilir');
    return false;
  };
  const memoryBody = (handler) => readBody(req, (error, body) => {
    if (error) return txt(400, error);
    try { handler(body || {}); }
    catch (memoryError) { txt(400, String(memoryError.message || memoryError)); }
  });
  const memoryUpdated = (kind, id) => {
    broadcast({ type: 'memory', kind, id });
    fireWebhook('hafiza-guncellendi', `${kind}:${id || ''}`);
  };

  // AI KONSEY: komutla (/claude /codex /all) yerel CLI ajanlarini konustur.
  // Sadece bu bilgisayardan (localOnly) — CLI'lar host makinede.
  if (url.pathname === '/api/konsey' && req.method === 'POST') {
    if (!masterOnly() || !localOnly()) return;
    return readBody(req, (err, body) => {
      if (err) return txt(400, err);
      const agent = String((body && body.agent) || 'all').toLowerCase();
      const message = String((body && body.message) || '').trim();
      const transcript = String((body && body.transcript) || '');
      if (!['claude', 'codex', 'all'].includes(agent)) return txt(400, 'gecersiz ajan');
      if (!message) return txt(400, 'mesaj bos');
      if (message.length > KONSEY_MAX_MESSAGE) return txt(413, `mesaj en fazla ${KONSEY_MAX_MESSAGE} karakter olabilir`);
      if (transcript.length > KONSEY_MAX_TRANSCRIPT) return txt(413, `konusma gecmisi en fazla ${KONSEY_MAX_TRANSCRIPT} karakter olabilir`);
      let claudeModel, codexModel;
      try {
        claudeModel = temizModel((body && body.claudeModel) || '', 'Claude');
        codexModel = temizModel((body && body.codexModel) || '', 'Codex');
      } catch (modelError) { return txt(400, String(modelError.message || modelError)); }
      if (konseyActive >= 1) return txt(429, 'AI Konsey mesgul; mevcut yanit tamamlaninca yeniden dene');
      konseyActive++;
      const hedefler = agent === 'claude' ? ['Claude'] : agent === 'codex' ? ['Codex'] : ['Claude', 'Codex'];
      const replies = [];
      let kalan = hedefler.length;
      let tamamlandi = false;
      const cevaplandi = (isim, text) => {
        replies.push({ name: isim, text });
        if (--kalan !== 0 || tamamlandi) return;
        tamamlandi = true;
        konseyActive = Math.max(0, konseyActive - 1);
        replies.sort((a, b) => hedefler.indexOf(a.name) - hedefler.indexOf(b.name));
        txt(200, JSON.stringify({ replies }), 'application/json');
      };
      hedefler.forEach((isim) => {
        const runner = isim === 'Codex' ? codexCalistir : claudeCalistir;
        const model = isim === 'Codex' ? codexModel : claudeModel;
        try { runner(konseyPrompt(isim, message, transcript), model, (text) => cevaplandi(isim, text)); }
        catch (runnerError) { cevaplandi(isim, `(${isim.toLowerCase()} cevap veremedi: ${String(runnerError.message || runnerError).slice(0, 200)})`); }
      });
    });
  }

  if (url.pathname === '/api/avci/status' && req.method === 'GET') {
    if (!masterOnly()) return;
    avciStatus()
      .then((status) => txt(200, JSON.stringify(status), 'application/json'))
      .catch((error) => txt(200, JSON.stringify({ online: false, reason: String(error.message || error), checkedAt: Date.now() }), 'application/json'));
    return;
  }

  if (url.pathname === '/api/avci/motor' && req.method === 'GET') {
    if (!masterOnly()) return;
    let log = '';
    try { log = fs.readFileSync(AVCI_MOTOR_LOG, 'utf8').slice(-4000); } catch {}
    return txt(200, JSON.stringify({ running: avciMotor.running, katalog: avciMotor.katalog, kapsam: avciMotor.kapsam, startedAt: avciMotor.startedAt, log }), 'application/json');
  }

  if (url.pathname === '/api/avci/motor' && req.method === 'POST') {
    if (!masterOnly() || !localOnly()) return;
    return readBody(req, (err, body) => {
      if (err) return txt(400, err);
      if (avciMotor.running || avciBakim.running || avciDuzenle.running) return txt(429, 'baska bir avci islemi calisiyor');
      const katalog = String((body && body.katalog) || 'ai').toLowerCase();
      if (!['ai', 'web', 'silah'].includes(katalog)) return txt(400, 'gecersiz katalog');
      let kapsam = String((body && body.kapsam) || 'hepsi').trim();
      if (!/^[A-Za-z0-9-]{1,40}$/.test(kapsam)) kapsam = 'hepsi';
      // motor.py (Avci dizininde, MOTOR_KATALOG ile) -> ardindan katalogu notes'a aktar.
      const ai = body && body.ai !== false;
      const motorArg = ai ? '--ai' : '--python';
      // AI: Claude arastirir, Codex denetler, Python kaynak metnini dogrular.
      // AI'siz: DuckDuckGo aramasi + Python kaynak metni dogrulamasi.
      const cmd = `cd ${JSON.stringify(AVCI_DIR)} && python3 motor.py ${kapsam} ${motorArg} ; python3 ${JSON.stringify(AVCI_EXPORT)}`;
      let child, out;
      try {
        fs.writeFileSync(AVCI_MOTOR_LOG, `# motor basladi katalog=${katalog} mod=${ai ? 'ai' : 'python'} kapsam=${kapsam} @${new Date().toISOString()}\n`);
        out = fs.openSync(AVCI_MOTOR_LOG, 'a');
        child = spawn('bash', ['-c', cmd], { env: {
          ...KONSEY_ENV,
          MOTOR_KATALOG: katalog,
          GITHUB_TOKEN: config.githubToken || '',
          NVD_API_KEY: config.nvdApiKey || '',
          BRAVE_API_KEY: config.braveApiKey || '',
          HF_TOKEN: config.hfToken || '',
        }, stdio: ['ignore', out, out] });
      } catch (spawnErr) { return txt(500, String(spawnErr.message || spawnErr)); }
      try { fs.closeSync(out); } catch {}
      avciMotor = { running: true, katalog, kapsam, startedAt: Date.now() };
      child.on('exit', () => { avciMotor.running = false; try { broadcast({ type: 'avci-motor', done: true }); } catch {} });
      child.on('error', () => { avciMotor.running = false; });
      return txt(200, JSON.stringify({ started: true, katalog, kapsam }), 'application/json');
    });
  }

  if (url.pathname === '/api/avci/bakim' && req.method === 'GET') {
    if (!masterOnly()) return;
    let log = '';
    try { log = fs.readFileSync(AVCI_BAKIM_LOG, 'utf8').slice(-4000); } catch {}
    return txt(200, JSON.stringify({ running: avciBakim.running, katalog: avciBakim.katalog, startedAt: avciBakim.startedAt, log }), 'application/json');
  }

  if (url.pathname === '/api/avci/bakim' && req.method === 'POST') {
    if (!masterOnly() || !localOnly()) return;
    return readBody(req, (err, body) => {
      if (err) return txt(400, err);
      if (avciBakim.running || avciMotor.running || avciDuzenle.running) return txt(429, 'baska bir avci islemi calisiyor, once bitmesini bekleyin');
      const katalog = String((body && body.katalog) || 'ai').toLowerCase();
      if (!['ai', 'web', 'silah'].includes(katalog)) return txt(400, 'gecersiz katalog');
      // AI ayni-olay birlestirmesi opsiyonel (Codex CLI kullanir, yavas olabilir).
      const ai = !!(body && body.ai === true);
      const bakimArg = ai ? '--ai' : '';
      // bakim.py senaryolari tekilleştirir -> katalogu tekrar notlara aktar.
      const cmd = `cd ${JSON.stringify(AVCI_DIR)} && python3 bakim.py ${bakimArg} ; python3 ${JSON.stringify(AVCI_EXPORT)}`;
      let child, out;
      try {
        fs.writeFileSync(AVCI_BAKIM_LOG, `# bakim basladi katalog=${katalog} ai=${ai} @${new Date().toISOString()}\n`);
        out = fs.openSync(AVCI_BAKIM_LOG, 'a');
        child = spawn('bash', ['-c', cmd], { env: {
          ...KONSEY_ENV,
          MOTOR_KATALOG: katalog,
        }, stdio: ['ignore', out, out] });
      } catch (spawnErr) { return txt(500, String(spawnErr.message || spawnErr)); }
      try { fs.closeSync(out); } catch {}
      avciBakim = { running: true, katalog, startedAt: Date.now() };
      child.on('exit', () => { avciBakim.running = false; try { broadcast({ type: 'avci-bakim', done: true }); } catch {} });
      child.on('error', () => { avciBakim.running = false; });
      return txt(200, JSON.stringify({ started: true, katalog, ai }), 'application/json');
    });
  }

  if (url.pathname === '/api/avci/duzenle' && req.method === 'GET') {
    if (!masterOnly()) return;
    let log = '';
    try { log = fs.readFileSync(AVCI_DUZENLE_LOG, 'utf8').slice(-2000); } catch {}
    return txt(200, JSON.stringify({ running: avciDuzenle.running, islem: avciDuzenle.islem, tid: avciDuzenle.tid, startedAt: avciDuzenle.startedAt, log }), 'application/json');
  }

  if (url.pathname === '/api/avci/duzenle' && req.method === 'POST') {
    if (!masterOnly() || !localOnly()) return;
    return readBody(req, (err, body) => {
      if (err) return txt(400, err);
      if (avciDuzenle.running || avciMotor.running || avciBakim.running) return txt(429, 'baska bir avci islemi calisiyor');
      const b = body || {};
      const katalog = String(b.katalog || 'ai').toLowerCase();
      if (!['ai', 'web', 'silah'].includes(katalog)) return txt(400, 'gecersiz katalog');
      const islem = String(b.islem || '').toLowerCase();
      if (!['anlat', 'sil'].includes(islem)) return txt(400, 'islem anlat ya da sil olmali');
      const tid = String(b.tid || '').trim();
      if (!/^[A-Za-z0-9-]{1,40}$/.test(tid)) return txt(400, 'gecersiz teknik id');
      const hedefUrl = String(b.url || '').trim();
      if (!/^https?:\/\//.test(hedefUrl) || hedefUrl.length > 2000) return txt(400, 'gecersiz url');
      const motorAdi = ['ollama', 'codex', 'claude'].includes(String(b.motor)) ? String(b.motor) : 'ollama';
      // duzenle.py (env ile) -> ardindan katalogu tekrar notlara aktar.
      const cmd = `cd ${JSON.stringify(AVCI_DIR)} && python3 duzenle.py ; python3 ${JSON.stringify(AVCI_EXPORT)}`;
      let child, out;
      try {
        fs.writeFileSync(AVCI_DUZENLE_LOG, `# duzenle islem=${islem} tid=${tid} motor=${motorAdi} @${new Date().toISOString()}\n`);
        out = fs.openSync(AVCI_DUZENLE_LOG, 'a');
        child = spawn('bash', ['-c', cmd], { env: {
          ...KONSEY_ENV,
          MOTOR_KATALOG: katalog,
          ISLEM: islem,
          HEDEF_TID: tid,
          HEDEF_URL: hedefUrl,
          ANLAT_MOTOR: motorAdi,
        }, stdio: ['ignore', out, out] });
      } catch (spawnErr) { return txt(500, String(spawnErr.message || spawnErr)); }
      try { fs.closeSync(out); } catch {}
      avciDuzenle = { running: true, islem, tid, startedAt: Date.now() };
      child.on('exit', () => { avciDuzenle.running = false; try { broadcast({ type: 'avci-duzenle', done: true, islem }); } catch {} });
      child.on('error', () => { avciDuzenle.running = false; });
      return txt(200, JSON.stringify({ started: true, islem, tid, motor: motorAdi }), 'application/json');
    });
  }

  if (url.pathname === '/api/session' && req.method === 'GET') {
    const credential = keyOf(req, url);
    const oldSid = sessionIdOf(req);
    if (oldSid) WEB_SESSIONS.delete(oldSid);
    for (const [id, session] of WEB_SESSIONS) if (session.expiresAt <= Date.now()) WEB_SESSIONS.delete(id);
    if (WEB_SESSIONS.size >= 512) {
      const oldest = [...WEB_SESSIONS.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt).slice(0, 64);
      for (const [id] of oldest) WEB_SESSIONS.delete(id);
    }
    const sid = crypto.randomBytes(24).toString('base64url');
    WEB_SESSIONS.set(sid, { credential, expiresAt: Date.now() + WEB_SESSION_MS });
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': `notlar_session=${encodeURIComponent(sid)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(WEB_SESSION_MS / 1000)}`,
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({ role: auth.role, deviceId: auth.deviceId, mode: config.mode || 'host', port: PORT }));
    return;
  }

  if (url.pathname === '/api/memory/overview' && req.method === 'GET') {
    const project = url.searchParams.get('project') || '';
    const workspace = url.searchParams.get('workspace') || '';
    return txt(200, JSON.stringify(memoryStore.overview({
      project,
      workspace,
      sessionLimit: url.searchParams.get('sessionLimit') || undefined,
      checkpointLimit: url.searchParams.get('checkpointLimit') || undefined,
      memoryLimit: url.searchParams.get('memoryLimit') || undefined,
      factLimit: url.searchParams.get('factLimit') || undefined,
    })), 'application/json');
  }
  if (url.pathname === '/api/memory/graph' && req.method === 'GET') {
    const project = url.searchParams.get('project') || '';
    const workspace = url.searchParams.get('workspace') || '';
    return txt(200, JSON.stringify(memoryStore.graph({ project, workspace })), 'application/json');
  }
  if (url.pathname === '/api/memory/memories' && req.method === 'GET') {
    return txt(200, JSON.stringify(memoryStore.listMemories({
      project: url.searchParams.get('project') || '',
      workspace: url.searchParams.get('workspace') || '',
      query: url.searchParams.get('q') || '',
      kind: url.searchParams.get('kind') || '',
      status: url.searchParams.get('status') || '',
      limit: url.searchParams.get('limit') || 100,
    })), 'application/json');
  }
  if (url.pathname === '/api/memory/events' && req.method === 'GET') {
    const sessionId = url.searchParams.get('sessionId') || '';
    if (!sessionId) return txt(400, 'sessionId gerekli');
    return txt(200, JSON.stringify(memoryStore.readEvents(sessionId, url.searchParams.get('limit') || 100)), 'application/json');
  }
  if (url.pathname === '/api/memory/facts' && req.method === 'GET') {
    return txt(200, JSON.stringify(memoryStore.listFacts({
      project: url.searchParams.get('project') || '',
      workspace: url.searchParams.get('workspace') || '',
      allProjects: ['1', 'true'].includes(url.searchParams.get('allProjects') || ''),
      subject: url.searchParams.get('subject') || '',
      predicate: url.searchParams.get('predicate') || '',
      status: url.searchParams.get('status') || '',
      q: url.searchParams.get('q') || '',
      asOf: url.searchParams.get('asOf') || '',
      includeHistorical: ['1', 'true'].includes(url.searchParams.get('includeHistorical') || ''),
      includeForgotten: ['1', 'true'].includes(url.searchParams.get('includeForgotten') || ''),
      assertionType: url.searchParams.get('assertionType') || '',
      evidenceLevel: url.searchParams.get('evidenceLevel') || '',
      sourceAgent: url.searchParams.get('sourceAgent') || '',
      limit: url.searchParams.get('limit') || 100,
    })), 'application/json');
  }
  if (url.pathname === '/api/memory/facts' && req.method === 'POST') {
    return memoryBody((body) => {
      const result = memoryStore.recordFact(body);
      memoryUpdated('fact', result.fact.id);
      txt(200, JSON.stringify(result), 'application/json');
    });
  }
  if (url.pathname === '/api/memory/facts/conflicts' && req.method === 'POST') {
    return memoryBody((body) => txt(200, JSON.stringify(memoryStore.suggestFactConflicts(body)), 'application/json'));
  }
  if (url.pathname === '/api/memory/facts/migrate' && req.method === 'POST') {
    if (!masterOnly()) return;
    return memoryBody(() => {
      const result = memoryStore.migrateFacts();
      memoryUpdated('facts-migrate', String(result.migrated));
      txt(200, JSON.stringify(result), 'application/json');
    });
  }
  if (url.pathname === '/api/memory/index' && req.method === 'GET') {
    return txt(200, JSON.stringify(memoryStore.factIndexStatus()), 'application/json');
  }
  if (url.pathname === '/api/memory/index/rebuild' && req.method === 'POST') {
    if (!masterOnly()) return;
    return memoryBody(() => {
      const result = memoryStore.rebuildFactIndex();
      memoryUpdated('fact-index-rebuild', String(result.records));
      txt(200, JSON.stringify(result), 'application/json');
    });
  }
  const factAction = url.pathname.match(/^\/api\/memory\/facts\/([^/]+)\/(provenance|invalidate|dispute|conflict|forget-hard)$/);
  if (factAction && factAction[2] === 'provenance' && req.method === 'GET') {
    try { return txt(200, JSON.stringify(memoryStore.factProvenance(decodeURIComponent(factAction[1]))), 'application/json'); }
    catch (error) { return txt(404, String(error.message || error)); }
  }
  if (factAction && req.method === 'POST' && ['invalidate', 'dispute'].includes(factAction[2])) {
    if (!masterOnly()) return;
    return memoryBody((body) => {
      const id = decodeURIComponent(factAction[1]);
      const fact = factAction[2] === 'invalidate'
        ? memoryStore.invalidateFact({ ...body, id })
        : memoryStore.disputeFact({ ...body, id });
      memoryUpdated('fact', fact.id);
      txt(200, JSON.stringify(fact), 'application/json');
    });
  }
  if (factAction && factAction[2] === 'conflict' && req.method === 'POST') {
    if (!masterOnly()) return;
    return memoryBody((body) => {
      const id = decodeURIComponent(factAction[1]);
      const result = memoryStore.resolveFactConflict({ ...body, id });
      memoryUpdated('fact-conflict', id);
      txt(200, JSON.stringify(result), 'application/json');
    });
  }
  if (factAction && factAction[2] === 'forget-hard' && req.method === 'POST') {
    if (!masterOnly()) return;
    return memoryBody((body) => {
      const id = decodeURIComponent(factAction[1]);
      const result = memoryStore.forget({ ...body, id, mode: 'hard' });
      memoryUpdated('forget-hard', id);
      txt(200, JSON.stringify(result), 'application/json');
    });
  }
  if (url.pathname === '/api/memory/timeline' && req.method === 'GET') {
    return txt(200, JSON.stringify(memoryStore.factTimeline({
      subject: url.searchParams.get('subject') || '',
      predicate: url.searchParams.get('predicate') || '',
      project: url.searchParams.get('project') || '',
      workspace: url.searchParams.get('workspace') || '',
      allProjects: ['1', 'true'].includes(url.searchParams.get('allProjects') || ''),
      limit: url.searchParams.get('limit') || 200,
    })), 'application/json');
  }
  if (url.pathname === '/api/memory/settings' && req.method === 'GET') {
    return txt(200, JSON.stringify(memoryStore.load().settings), 'application/json');
  }
  if (url.pathname === '/api/memory/settings' && req.method === 'POST') {
    if (!masterOnly()) return;
    return memoryBody((body) => {
      const settings = memoryStore.updateSettings(body);
      memoryUpdated('settings', 'memory');
      txt(200, JSON.stringify(settings), 'application/json');
    });
  }
  if (url.pathname === '/api/integrations' && req.method === 'GET') {
    if (!masterOnly() || !localOnly()) return;
    try { return txt(200, JSON.stringify(integrationManager.status()), 'application/json'); }
    catch (error) { return txt(500, String(error.message || error)); }
  }
  if (url.pathname === '/api/integrations/install' && req.method === 'POST') {
    if (!masterOnly() || !localOnly()) return;
    return memoryBody((body) => {
      const result = integrationManager.install(String(body.provider || 'all'));
      broadcast({ type: 'memory', kind: 'integrations', id: body.provider || 'all' });
      txt(200, JSON.stringify(result), 'application/json');
    });
  }
  if (url.pathname === '/api/memory/session/start' && req.method === 'POST') {
    return memoryBody((body) => {
      const externalItems = memoryExternalItems(body);
      const started = memoryStore.startSession(body, externalItems);
      memoryRecall({
        ...body,
        projectId: started.project.id,
        project: started.project.name,
        workspace: started.project.workspace,
        query: body.goal || body.query || '',
      }, (error, recalled) => {
        if (error) return txt(500, String(error));
        memoryUpdated('session-start', started.session.id);
        txt(200, JSON.stringify({ ...started, context: recalled.context, embeddingModel: recalled.embeddingModel || null }), 'application/json');
      });
    });
  }
  if (url.pathname === '/api/memory/session/heartbeat' && req.method === 'POST') {
    return memoryBody((body) => {
      const session = memoryStore.heartbeat(body);
      broadcast({ type: 'memory', kind: 'heartbeat', id: session.id });
      txt(200, JSON.stringify(session), 'application/json');
    });
  }
  if (url.pathname === '/api/memory/event' && req.method === 'POST') {
    return memoryBody((body) => {
      const event = memoryStore.recordEvent(body);
      memoryUpdated('event', event.id);
      txt(200, JSON.stringify(event), 'application/json');
    });
  }
  if (url.pathname === '/api/memory/checkpoint' && req.method === 'POST') {
    return memoryBody((body) => {
      const checkpoint = memoryStore.checkpoint(body);
      memoryUpdated('checkpoint', checkpoint.id);
      txt(200, JSON.stringify(checkpoint), 'application/json');
    });
  }
  if (url.pathname === '/api/memory/session/end' && req.method === 'POST') {
    return memoryBody((body) => {
      const result = memoryStore.endSession(body);
      memoryUpdated('session-end', result.session.id);
      txt(200, JSON.stringify(result), 'application/json');
    });
  }
  if (url.pathname === '/api/memory/remember' && req.method === 'POST') {
    return memoryBody((body) => {
      const item = memoryStore.remember(body);
      memoryUpdated('remember', item.id);
      txt(200, JSON.stringify(item), 'application/json');
    });
  }
  if (url.pathname === '/api/memory/recall' && req.method === 'POST') {
    return memoryBody((body) => memoryRecall(body, (error, result) => {
      if (error) return txt(500, String(error));
      txt(200, JSON.stringify(result), 'application/json');
    }));
  }
  if (url.pathname === '/api/memory/forget' && req.method === 'POST') {
    if (!masterOnly()) return;
    return memoryBody((body) => {
      const result = memoryStore.forget(body);
      memoryUpdated('forget', result.id);
      txt(200, JSON.stringify(result), 'application/json');
    });
  }
  if (url.pathname === '/api/memory/session/delete' && req.method === 'POST') {
    if (!masterOnly()) return;
    return memoryBody((body) => {
      const result = memoryStore.deleteSession(body);
      memoryUpdated('session-delete', result.id);
      txt(200, JSON.stringify(result), 'application/json');
    });
  }

  if (url.pathname === '/api/overview' && req.method === 'GET')
    return txt(200, JSON.stringify(overviewData(auth)), 'application/json');

  if (url.pathname === '/api/pins' && req.method === 'POST') {
    return readBody(req, (e, b) => {
      if (e) return txt(400, e);
      const name = safeNoteId(String(b.name || ''));
      if (!name || readNote(name) === undefined) return txt(404, 'not yok');
      const pins = new Set(Array.isArray(config.pinnedNotes) ? config.pinnedNotes : []);
      const pinned = b.pinned === undefined ? !pins.has(name) : !!b.pinned;
      if (pinned) pins.add(name); else pins.delete(name);
      configKaydet({ ...config, pinnedNotes: [...pins] });
      broadcast({ type: 'overview' });
      txt(200, JSON.stringify({ name, pinned }), 'application/json');
    });
  }

  if (url.pathname === '/api/settings' && req.method === 'GET') {
    if (!masterOnly()) return;
    return txt(200, JSON.stringify({
      mode: config.mode || 'host',
      server: config.server || `http://localhost:${PORT}`,
      port: PORT,
      passwordSet: !!PASSWORD,
      gitAutoPush: !!config.gitAutoPush,
      gitPushDelayMs: Number(config.gitPushDelayMs) || 30000,
      otoZihin: config.otoZihin !== false,
      otoZihinSn: Number(config.otoZihinSn) || 120,
      cevapModeli: CEVAP_MODELI,
      avciUrl: (() => { try { return configuredAvciUrl(); } catch { return ''; } })(),
      claudeEnabled: !!config.claudeApiKey,
      githubTokenSet: !!config.githubToken,
      nvdApiKeySet: !!config.nvdApiKey,
      braveApiKeySet: !!config.braveApiKey,
      hfTokenSet: !!config.hfToken,
      dataDir: DATA_DIR,
    }), 'application/json');
  }

  if (url.pathname === '/api/settings' && req.method === 'POST') {
    if (!masterOnly()) return;
    return readBody(req, (e, b) => {
      if (e) return txt(400, e);
      const next = { ...config };
      const oldRuntime = `${config.mode}|${config.server}|${PORT}`;
      if (b.mode !== undefined) {
        if (!['host', 'client'].includes(b.mode)) return txt(400, 'mode host ya da client olmali');
        next.mode = b.mode;
      }
      if (b.server !== undefined) {
        try {
          const u = new URL(String(b.server));
          if (!/^https?:$/.test(u.protocol) || u.username || u.password) throw new Error();
          next.server = u.href.replace(/\/$/, '');
        } catch { return txt(400, 'gecersiz server adresi'); }
      }
      if (b.port !== undefined) {
        const p = Number(b.port);
        if (!Number.isInteger(p) || p < 1024 || p > 65535) return txt(400, 'port 1024-65535 olmali');
        next.port = p;
      }
      for (const k of ['gitAutoPush', 'otoZihin']) if (b[k] !== undefined) next[k] = !!b[k];
      for (const k of ['gitPushDelayMs', 'otoZihinSn']) if (b[k] !== undefined && Number(b[k]) > 0) next[k] = Number(b[k]);
      if (b.cevapModeli !== undefined) next.cevapModeli = String(b.cevapModeli).trim().slice(0, 80) || 'qwen3:8b';
      for (const [k, max] of [['githubToken', 300], ['nvdApiKey', 300], ['braveApiKey', 300], ['hfToken', 300]]) {
        if (b[k] !== undefined) next[k] = String(b[k] || '').trim().slice(0, max);
      }
      if (b.avciUrl !== undefined) {
        try { next.avciUrl = normalizeAvciUrl(b.avciUrl); }
        catch (error) { return txt(400, String(error.message || error)); }
      }
      if (Object.prototype.hasOwnProperty.call(b, 'password')) {
        const pw = String(b.password || '');
        if (pw && pw.length < 12) return txt(400, 'parola en az 12 karakter olmali');
        if (!pw && b.allowNoPassword !== true) return txt(400, 'parolayi kapatmak icin acik onay gerekli');
        next.password = pw;
      }
      const passwordChanged = next.password !== config.password;
      configKaydet(next);
      if (passwordChanged) {
        WEB_SESSIONS.clear();
        setTimeout(() => {
          if (typeof wss !== 'undefined') for (const client of wss.clients) client.close(4002, 'parola degisti');
        }, 100);
      }
      const restartRequired = oldRuntime !== `${next.mode}|${next.server}|${Number(next.port) || PORT}`;
      broadcast({ type: 'settings', restartRequired });
      txt(200, JSON.stringify({ ok: true, restartRequired }), 'application/json');
    });
  }

  if (url.pathname === '/api/ai/status' && req.method === 'GET')
    return ollamaStatus((d) => txt(200, JSON.stringify(d), 'application/json'));

  if (url.pathname === '/api/runtime' && req.method === 'GET') {
    if (!masterOnly() || !localOnly()) return;
    return installer.status(config)
      .then((state) => txt(200, JSON.stringify(state), 'application/json'))
      .catch((error) => txt(500, String(error.message || error)));
  }
  if (url.pathname === '/api/runtime/install' && req.method === 'POST') {
    if (!masterOnly() || !localOnly()) return;
    return readBody(req, (error, body) => {
      if (error) return txt(400, error);
      const action = String(body.action || '');
      if (!['all', 'system', 'speech', 'ollama', 'models'].includes(action)) return txt(400, 'geçersiz kurulum bileşeni');
      if (installer.snapshot().running) return txt(409, 'başka bir kurulum zaten çalışıyor');
      installer.install(action, config, (task) => broadcast({ type: 'runtime', task }))
        .catch((installError) => broadcast({ type: 'runtime', task: { ...installer.snapshot(), error: String(installError.message || installError) } }));
      txt(202, JSON.stringify({ ok: true, action }), 'application/json');
    });
  }
  if (url.pathname === '/api/runtime/cancel' && req.method === 'POST') {
    if (!masterOnly() || !localOnly()) return;
    const cancelled = installer.cancel((task) => broadcast({ type: 'runtime', task }));
    return txt(cancelled ? 200 : 409, cancelled ? 'durduruluyor' : 'çalışan kurulum yok');
  }

  if (url.pathname === '/api/import/obsidian' && req.method === 'GET') {
    if (!masterOnly() || !localOnly()) return;
    try { return txt(200, JSON.stringify(obsidian.list()), 'application/json'); }
    catch (error) { return txt(500, String(error.message || error)); }
  }
  if (url.pathname === '/api/import/obsidian' && req.method === 'POST') {
    if (!masterOnly() || !localOnly()) return;
    return readBody(req, (error, body) => {
      if (error) return txt(400, error);
      const result = importObsidianVault(String(body.path || ''));
      if (result.hata) return txt(400, result.hata);
      broadcast({ type: 'list', notes: listNotes(), folders: listFolders() });
      broadcast({ type: 'folders', folders: listFolders() });
      broadcast({ type: 'overview' });
      txt(200, JSON.stringify(result), 'application/json');
    });
  }

  // GRAPHIFY entegrasyonu: uygulama içinden kod grafiğini yeniden kur (LLM'siz, hızlı).
  // update = kod yeniden çıkar, cluster-only --no-label = toplulukları+graph.html tazele.
  if (url.pathname === '/api/graphify/build' && req.method === 'POST') {
    if (!masterOnly()) return;
    const bin = path.join(require('os').homedir(), '.local/bin/graphify');
    if (!fs.existsSync(bin)) return txt(200, JSON.stringify({ ok: true, builtin: true }), 'application/json');
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

  if (url.pathname === '/api/folders' && req.method === 'GET')
    return txt(200, JSON.stringify(listFolders()), 'application/json');

  if (url.pathname === '/api/folders' && req.method === 'POST') {
    return readBody(req, (error, body) => {
      if (error) return txt(400, error);
      const result = createFolder(String(body.path || ''));
      if (result.hata) return txt(400, result.hata);
      broadcast({ type: 'folders', folders: listFolders() });
      txt(201, JSON.stringify(result), 'application/json');
    });
  }

  if (url.pathname === '/api/folders' && req.method === 'PATCH') {
    return readBody(req, (error, body) => {
      if (error) return txt(400, error);
      const result = renameFolder(String(body.path || ''), String(body.newPath || ''));
      if (result.hata) return txt(result.hata.includes('yok') ? 404 : 409, result.hata);
      broadcast({ type: 'folder-renamed', ...result, from: safeFolderId(String(body.path || '')), to: result.name, folders: listFolders(), notes: listNotes() });
      broadcast({ type: 'list', notes: listNotes() });
      txt(200, JSON.stringify(result), 'application/json');
    });
  }

  if (url.pathname === '/api/folders' && req.method === 'DELETE') {
    return readBody(req, (error, body) => {
      if (error) return txt(400, error);
      const result = deleteFolder(String(body.path || ''));
      if (result.hata) return txt(result.code || 400, result.hata);
      broadcast({ type: 'folders', folders: listFolders() });
      txt(200, JSON.stringify(result), 'application/json');
    });
  }

  if (url.pathname === '/api/trash' && req.method === 'GET')
    return txt(200, JSON.stringify(trashListele()), 'application/json');

  if (url.pathname === '/api/trash/restore' && req.method === 'POST') {
    return readBody(req, (e, b) => {
      if (e) return txt(400, e);
      const name = trashGeriYukle(String(b.id || ''));
      if (!name) return txt(404, 'cop kutusu ogesi yok');
      broadcast({ type: 'list', notes: listNotes() });
      txt(200, JSON.stringify({ name }), 'application/json');
    });
  }

  if (url.pathname === '/api/trash/delete' && req.method === 'POST') {
    if (!masterOnly()) return;
    return readBody(req, (e, b) => {
      if (e) return txt(400, e);
      const ok = trashKaliciSil(String(b.id || ''));
      txt(ok ? 200 : 404, ok ? 'kalici silindi' : 'cop kutusu ogesi yok');
    });
  }

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
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      try { fs.chmodSync(dir, 0o700); } catch {}
      const ad = 'gorsel-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex') + '.' + ext;
      atomikYaz(path.join(dir, ad), buf, { encoding: null });
      txt(200, JSON.stringify({ yol: 'files/' + ad }), 'application/json');
    });
    return;
  }

  // --- gömülü belge motoru: ağır bileşenler Kurulum Merkezi'nden tamamlanır.
  if (url.pathname === '/api/motor' && req.method === 'GET') {
    return kopru.durum((_, d) => txt(200, JSON.stringify(d), 'application/json'));
  }

  // POST /api/belge?ad=rapor.pdf (govde = dosya): PDF/gorsel/ses/video -> NOT.
  // Motor metni/kavramlari cikarir; not olusur, kavramlar [[link]] olur,
  // Ollama iliski onerir. Whisper dakikalar surebilir -> hemen "isleniyor"
  // doner, sonuc WS 'belge' mesajiyla tum cihazlara duyurulur.
  if (url.pathname === '/api/belge' && req.method === 'POST') {
    const orjinal = safeName(url.searchParams.get('ad') || '');
    const ext = (orjinal.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
    const tur = kopru.TURLER[ext];
    if (!tur) return txt(415, 'desteklenmeyen tur: .' + (ext || '?') + ' (pdf/gorsel/ses/video)');
    const dir = path.join(DATA_DIR, 'files');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch {}
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

  if (url.pathname === '/api/pair-code' && req.method === 'GET') {
    if (!masterOnly()) return;
    return makePairCode((code) => txt(200, code));
  }

  // --- Kalici iki-yonlu peer replikasyonu ---
  if (url.pathname === '/api/sync/status' && req.method === 'GET') {
    if (!masterOnly()) return;
    return txt(200, JSON.stringify(replicaSync.status()), 'application/json');
  }
  if (url.pathname === '/api/sync/pair/new' && req.method === 'POST') {
    if (!masterOnly()) return;
    return getAdvertisedUrl((addressError, address) => {
      if (addressError) return txt(400, String(addressError.message || addressError));
      try { txt(200, JSON.stringify(replicaSync.pairCode(address)), 'application/json'); }
      catch (error) { txt(400, String(error.message || error)); }
    });
  }
  if (url.pathname === '/api/sync/pair/connect' && req.method === 'POST') {
    if (!masterOnly() || !localOnly()) return;
    return readBody(req, (bodyError, body) => {
      if (bodyError) return txt(400, bodyError);
      getAdvertisedUrl((addressError, localUrl) => {
        if (addressError) return txt(400, String(addressError.message || addressError));
        replicaSync.connect(body?.address, body?.code, localUrl, body?.deviceName)
          .then((result) => {
            broadcast({ type: 'peer-pair' });
            txt(202, JSON.stringify(result), 'application/json');
          })
          .catch((error) => txt(400, String(error.message || error)));
      });
    });
  }
  if (url.pathname === '/api/sync/pair/pending' && req.method === 'GET') {
    if (!masterOnly()) return;
    return txt(200, JSON.stringify(replicaSync.pendingPairs()), 'application/json');
  }
  if (url.pathname === '/api/sync/pair/approve' && req.method === 'POST') {
    if (!masterOnly()) return;
    return readBody(req, (bodyError, body) => {
      if (bodyError) return txt(400, bodyError);
      getAdvertisedUrl((addressError, localUrl) => {
        if (addressError) return txt(400, String(addressError.message || addressError));
        replicaSync.approvePair(body?.code, localUrl)
          .then((result) => {
            broadcast({ type: 'peer-sync' });
            txt(200, JSON.stringify(result), 'application/json');
          })
          .catch((error) => txt(409, String(error.message || error)));
      });
    });
  }
  if (url.pathname === '/api/sync/pair/reject' && req.method === 'POST') {
    if (!masterOnly()) return;
    return readBody(req, (bodyError, body) => {
      if (bodyError) return txt(400, bodyError);
      const removed = replicaSync.rejectPair(body?.code);
      broadcast({ type: 'peer-pair' });
      txt(removed ? 200 : 404, removed ? 'reddedildi' : 'bekleyen eslestirme yok');
    });
  }
  if (url.pathname === '/api/sync/now' && req.method === 'POST') {
    if (!masterOnly()) return;
    replicaSync.syncAll()
      .then((results) => txt(200, JSON.stringify({ ok: true, results, status: replicaSync.status() }), 'application/json'))
      .catch((error) => txt(500, String(error.message || error)));
    return;
  }
  if (url.pathname === '/api/sync/peer/pause' && req.method === 'POST') {
    if (!masterOnly()) return;
    return readBody(req, (bodyError, body) => {
      if (bodyError) return txt(400, bodyError);
      const peer = replicaSync.pausePeer(body?.id, body?.paused);
      if (peer) broadcast({ type: 'peer-sync' });
      txt(peer ? 200 : 404, peer ? JSON.stringify(peer) : 'peer yok', peer ? 'application/json' : undefined);
    });
  }
  if (url.pathname === '/api/sync/peer/remove' && req.method === 'POST') {
    if (!masterOnly()) return;
    return readBody(req, (bodyError, body) => {
      if (bodyError) return txt(400, bodyError);
      const removed = replicaSync.removePeer(body?.id);
      broadcast({ type: 'peer-sync' });
      txt(removed ? 200 : 404, removed ? 'baglanti kaldirildi' : 'peer yok');
    });
  }

  // --- yeni eslestirme: tek kullanimlik kod + cift onay + cihaz token'i ---
  // ana cihaz kod uretir (bu uc AUTHED - handleApi baslangicinda gecti)
  if (url.pathname === '/api/pair/new' && req.method === 'POST') {
    if (!masterOnly()) return;
    const kod = esl.kodUret(Date.now());
    getHostAddress((addr) => txt(200, JSON.stringify({ kod, adres: 'http://' + addr + ':' + PORT }), 'application/json'));
    return;
  }
  // host tarafi bir talebi onaylar/reddeder (AUTHED). Reddet = oturumu dusur.
  if (url.pathname === '/api/pair/host-onay' && req.method === 'POST') {
    if (!masterOnly()) return;
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
  if (url.pathname === '/api/pair/talepler' && req.method === 'GET') {
    if (!masterOnly()) return;
    return txt(200, JSON.stringify(esl.bekleyenTalepler()), 'application/json');
  }

  // --- bagli cihazlar: ham bearer token donmez; yalniz host gorebilir/iptal eder ---
  if (url.pathname === '/api/devices' && req.method === 'GET') {
    if (!masterOnly()) return;
    return txt(200, JSON.stringify(esl.cihazlariPublic(DATA_DIR)), 'application/json');
  }
  if (url.pathname === '/api/devices/iptal' && req.method === 'POST') {
    if (!masterOnly()) return;
    return readBody(req, (e, b) => {
      const oldu = esl.cihazSil(DATA_DIR, String(b.id || b.token || ''));
      if (oldu) gunlukYaz('cihaz baglantisi iptal edildi (token silindi)');
      txt(oldu ? 200 : 404, oldu ? 'iptal edildi' : 'cihaz yok');
    });
  }

  // --- sifreli kasa deposu (sifir-bilgi: sunucu blob'u saklar, icini ACAMAZ) ---
  // sifreleme/cozme istemcide (Web Crypto). blob ana parolayla sifreli, gitignored.
  const vaultEtag = (data) => `"${crypto.createHash('sha256').update(data).digest('base64url')}"`;
  if (url.pathname === '/api/vault/reset' && req.method === 'POST') {
    if (!masterOnly()) return;
    return readBody(req, (error, body) => {
      if (error) return txt(400, error);
      if (body.confirm !== 'SIFIRLA') return txt(400, 'onay icin SIFIRLA yaz');
      if (!fs.existsSync(VAULT_PATH)) return txt(404, 'sifirlanacak kasa yok');
      try {
        const current = fs.readFileSync(VAULT_PATH);
        atomikYaz(VAULT_RESET_BACKUP_PATH, current, { encoding: null });
        fs.unlinkSync(VAULT_PATH);
        broadcast({ type: 'vault-reset' });
        txt(200, JSON.stringify({ ok: true, backup: path.basename(VAULT_RESET_BACKUP_PATH) }), 'application/json');
      } catch (resetError) {
        txt(500, 'kasa sifirlanamadi: ' + String(resetError.message || resetError).slice(0, 120));
      }
    });
  }
  if (url.pathname === '/api/vault') {
    if (req.method === 'GET') {
      if (!fs.existsSync(VAULT_PATH)) return txt(404, '');
      const data = fs.readFileSync(VAULT_PATH);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ETag: vaultEtag(data) });
      res.end(data);
      return;
    }
    if (req.method === 'POST') {
      const chunks = []; let size = 0;
      req.on('data', (c) => { chunks.push(c); size += c.length; if (size > 20e6) req.destroy(); });
      req.on('end', () => {
        if (size > 20e6) return;
        const data = Buffer.concat(chunks);
        let envelope;
        try { envelope = JSON.parse(data.toString('utf8')); } catch { return txt(400, 'gecersiz kasa blobu'); }
        if (!envelope || envelope.v !== 1 || envelope.kdf !== 'PBKDF2-SHA256'
          || !envelope.salt || !envelope.iv || !envelope.ct) return txt(400, 'gecersiz kasa zarfi');
        const current = fs.existsSync(VAULT_PATH) ? fs.readFileSync(VAULT_PATH) : null;
        const ifMatch = String(req.headers['if-match'] || '');
        const ifNoneMatch = String(req.headers['if-none-match'] || '');
        if (current && ifMatch && ifMatch !== vaultEtag(current)) return txt(409, 'kasa baska cihazda degisti; yeniden ac');
        if (current && ifNoneMatch === '*') return txt(409, 'kasa baska cihazda olusturuldu; yeniden ac');
        if (!current && ifMatch) return txt(409, 'kasa durumu degisti; yeniden ac');
        if (current) atomikYaz(VAULT_BACKUP_PATH, current, { encoding: null });
        atomikYaz(VAULT_PATH, data, { encoding: null });
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ETag: vaultEtag(data) });
        res.end('kaydedildi');
      });
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
      return readBody(req, (error, it) => {
        if (error) return txt(400, error);
        if (!it || !it.password) return txt(400, 'sifre yok');
        // ayni site+kullanici zaten kuyruktaysa tekrar ekleme
        if (!pending.some((p) => p.url === it.url && p.username === it.username && p.password === it.password))
          pending.push({ url: String(it.url || '').slice(0, 300), username: String(it.username || '').slice(0, 200), password: String(it.password).slice(0, 500) });
        if (pending.length > 50) pending.shift(); // ust sinir
        txt(200, 'kuyruga alindi');
      });
    }
  }

  // --- local AI (Ollama) proxy: ceviri + yardim ---
  if (url.pathname === '/api/ai' && req.method === 'POST') {
    return readBody(req, (error, body) => {
      if (error) return txt(400, error);
      const model = String(body.model || 'qwen3:8b').trim().slice(0, 80); // ceviri kalitesi icin daha iyi model
      const input = String(body.text || '').slice(0, 100000);
      const prompt = body.mode === 'translate'
        ? 'Translate the following text to Turkish. Output ONLY the Turkish translation, no explanations, no notes:\n\n' + input
        : input;
      askOllama(model, prompt, (err, out) => {
        if (err) return txt(502, 'AI yok/kapali: ' + err);
        txt(200, out, 'text/plain');
      });
    });
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
      if (b.folder && !safeFolderId(String(b.folder))) return txt(400, 'gecersiz klasor');
      zihin.fetchPage(String(b.url || ''), (ferr, html) => {
        if (ferr) return txt(502, 'indirilemedi: ' + ferr);
        const { title, text } = zihin.htmlToText(html);
        if (!text) return txt(422, 'sayfadan metin cikarilamadi');
        const folder = safeFolderId(String(b.folder || ''));
        const leaf = safeName(title).slice(0, 60).trim() || safeName(new URL(b.url).hostname);
        let name = folder ? `${folder}/${leaf}` : leaf;
        while (readNote(name) !== undefined) name += ' 2'; // mevcut notu ezme
        const desc = text.replace(/\s+/g, ' ').slice(0, 160).replace(/"/g, "'");
        const yazar = safeName(String(b.yazar || ''));
        const icerik = [
          '---',
          `name: ${noteBase(name)}`,
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
  let decodedName;
  try { decodedName = decodeURIComponent(m[1]); } catch { return txt(400, 'gecersiz isim kodlamasi'); }
  const name = safeNoteId(decodedName);
  if (!name) return txt(400, 'gecersiz isim');

  if (req.method === 'GET') {
    const content = readNote(name);
    if (content === undefined) return txt(404, 'not yok: ' + name);
    return txt(200, content, 'text/markdown');
  }

  if (req.method === 'PATCH') {
    return readBody(req, (err, b) => {
      if (err) return txt(400, err);
      const sonuc = renameNote(name, String(b.name || ''));
      if (sonuc.hata) return txt(409, sonuc.hata);
      broadcast({ type: 'renamed', from: name, to: sonuc.name });
      broadcast({ type: 'content', name: sonuc.name, content: sonuc.content, live: true });
      for (const changed of sonuc.changed) {
        if (changed.name !== sonuc.name) broadcast({ type: 'content', name: changed.name, content: changed.content, live: true });
      }
      broadcast({ type: 'saved', name: sonuc.name, hash: icerikHash(sonuc.content) });
      broadcast({ type: 'list', notes: listNotes() });
      txt(200, JSON.stringify({ name: sonuc.name, linksUpdated: sonuc.linksUpdated }), 'application/json');
    });
  }

  if (req.method === 'DELETE') {
    if (!deleteNote(name)) return txt(404, 'not yok: ' + name);
    broadcast({ type: 'list', notes: listNotes() });
    return txt(200, 'cop kutusuna tasindi: ' + name);
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
      broadcast({ type: 'saved', name, hash: icerikHash(content) });
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
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (!['/graphify', '/graphify/', '/pano', '/pano/'].includes(url.pathname)) {
    let avciFrameSource = 'http://127.0.0.1:7788';
    try { avciFrameSource = new URL(configuredAvciUrl()).origin; } catch {}
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' ws: wss:; frame-src 'self' ${avciFrameSource}; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'`);
  }
  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ app: 'notlar-sync', ok: true, version: APP_VERSION }));
    return;
  }
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
  // nota yapistirilan gorseller (~/NotlarSync/files) - parola varsa istenir
  if (url.pathname.startsWith('/files/')) {
    if (!authOk(keyOf(req, url))) { res.writeHead(401); res.end('parola'); return; }
    let relative;
    try { relative = decodeURIComponent(url.pathname.slice('/files/'.length)).replace(/\\/g, '/'); }
    catch { res.writeHead(400); res.end('gecersiz dosya yolu'); return; }
    const root = path.resolve(DATA_DIR, 'files');
    const fp = path.resolve(root, relative);
    if (!relative || (!fp.startsWith(root + path.sep) && fp !== root)) { res.writeHead(400); res.end('gecersiz dosya yolu'); return; }
    return fs.readFile(fp, (err, data) => {
      if (err) { res.writeHead(404); res.end('yok'); return; }
      const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4' };
      res.writeHead(200, { 'Content-Type': types[path.extname(fp)] || 'application/octet-stream' });
      res.end(data);
    });
  }
  // GRAPHIFY görünümü: kendine yeten graph.html'i uygulama içine gömmek için sun (auth'lu)
  if (url.pathname === '/graphify' || url.pathname === '/graphify/') {
    if (!authOk(keyOf(req, url))) { res.writeHead(401); res.end('parola'); return; }
    const generated = path.join(__dirname, 'graphify-out', 'graph.html');
    const fp = fs.existsSync(generated) ? generated : path.join(__dirname, 'public', 'harita.html');
    return fs.readFile(fp, (err, data) => {
      if (err) { res.writeHead(404); res.end('harita bulunamadi'); return; }
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
    if (c !== except && c.readyState === 1 && c.authed) c.send(s);
  }
}

function replicaApplied(event) {
  if (!event || !event.name) return;
  if (event.type === 'deleted') {
    clearTimeout(saveTimers[event.name]);
    delete saveTimers[event.name];
    pendingCreates.delete(event.name);
    delete latest[event.name];
    markInternalFs(event.name, true);
    broadcast({ type: 'deleted', name: event.name, replicated: true });
    autoPush();
    fireWebhook('not-silindi', event.name);
    return;
  }
  if (event.type === 'conflict') {
    latest[event.name] = event.content;
    latest[event.copy] = event.conflictContent;
    markInternalFs(event.name);
    markInternalFs(event.copy);
    broadcast({ type: 'content', name: event.name, content: event.content, live: true, replicated: true });
    broadcast({ type: 'saved', name: event.name, hash: icerikHash(event.content) });
    broadcast({ type: 'conflict', name: event.name, copy: event.copy, replicated: true });
    autoPush();
    fireWebhook('not-kaydedildi', event.name);
    return;
  }
  if (event.type === 'content') {
    latest[event.name] = event.content;
    markInternalFs(event.name);
    broadcast({ type: 'content', name: event.name, content: event.content, live: true, replicated: true });
    broadcast({ type: 'saved', name: event.name, hash: icerikHash(event.content) });
    autoPush();
    fireWebhook('not-kaydedildi', event.name);
  }
}

replicaSync = peerSync.createReplica({
  dataDir: DATA_DIR,
  notesDir: NOTES_DIR,
  deviceName: config.deviceName || require('os').hostname(),
  autoStart: false,
  beforeSync: async () => flushPendingSaves(),
  onApplied: replicaApplied,
  onSync: (result) => {
    broadcast({ type: 'peer-sync' });
    if (result && !result.error && (result.applied || result.deleted || result.conflicts)) {
      broadcast({ type: 'list', notes: listNotes(), folders: listFolders() });
      broadcast({ type: 'overview' });
    }
  },
});

wss.on('connection', (ws, req) => {
  ws.authed = false;
  let authTimer = setTimeout(() => {
    if (!ws.authed) ws.close(4001, 'kimlik dogrulanmadi');
  }, 5000);

  const oturumuBaslat = (auth) => {
    if (ws.authed) return;
    ws.authed = true;
    ws.authRole = auth.role;
    clearTimeout(authTimer);
    ws.send(JSON.stringify({ type: 'session', role: auth.role, deviceId: auth.deviceId }));
    ws.send(JSON.stringify({ type: 'list', notes: listNotes(), folders: listFolders() }));
  };

  // HttpOnly web oturumu varsa WebSocket'i anahtari JavaScript'e geri vermeden
  // dogrula. Eski istemcilerin ?key= baglantisi geriye uyumluluk icin kalir.
  const queryKey = new URL(req.url, 'http://x').searchParams.get('key') || '';
  const requestAuth = authBilgisi(sessionCredential(req) || queryKey);
  if (requestAuth.ok) oturumuBaslat(requestAuth);

  ws.on('message', (raw) => {
    // bozuk/beklenmedik mesaj sunucuyu (host modda uygulamayi) dusurmesin
    try {
      const m = JSON.parse(raw);
      if (!ws.authed) {
        if (m.type !== 'auth') { ws.close(4001, 'once kimlik dogrula'); return; }
        const auth = authBilgisi(String(m.key || ''));
        if (!auth.ok) { ws.close(4001, 'parola yanlis'); return; }
        oturumuBaslat(auth);
        return;
      }
      const name = safeNoteId(m.name); // klasor dahil normalize kimlik kullan ve yankila
      if (!name) return;

      if (m.type === 'open') {
        ws.send(JSON.stringify({ type: 'content', name, content: readNote(name) ?? '' }));
      }

      if (m.type === 'edit' && typeof m.content === 'string') {
        if (readNote(name) === undefined) pendingCreates.add(name);
        latest[name] = m.content;
        // ayni notu acik olan herkese aninda gonder
        broadcast({ type: 'content', name, content: m.content, live: true }, ws);
        // diske yazmayi hafif geciktir (her tusta disk yazmasin)
        clearTimeout(saveTimers[name]);
        saveTimers[name] = setTimeout(() => {
          const content = latest[name];
          const wasNew = pendingCreates.delete(name);
          saveNote(name, content);
          broadcast({ type: 'saved', name, hash: icerikHash(content) });
          if (wasNew) broadcast({ type: 'list', notes: listNotes() });
        }, 400);
      }

      // cakisma korumali kayit: istemci kopukken yazdi ve geri geldi. base =
      // en son mutabik kalinan icerigin ozeti. Sunucu bu arada degistiyse
      // istemcinin surumu "(cakisma SAAT)" kopyasina alinir - KIMSE sessizce
      // ezilmez (son-yazan-kazanir'in durust hali; CRDT kadar akilli degil
      // ama veri kaybetmez).
      if (m.type === 'edit-safe' && typeof m.content === 'string') {
        const old = readNote(name);
        const cur = old ?? '';
        const ozet = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36); };
        if (!m.base || ozet(cur) === m.base || cur === m.content) {
          saveNote(name, m.content);
          broadcast({ type: 'content', name, content: m.content, live: true }, ws);
          ws.send(JSON.stringify({ type: 'content', name, content: m.content }));
          ws.send(JSON.stringify({ type: 'saved', name, hash: icerikHash(m.content) }));
          if (old === undefined) broadcast({ type: 'list', notes: listNotes() });
        } else {
          const saat = new Date();
          const kopya = noteWithSuffix(name, ` - çakışma ${String(saat.getHours()).padStart(2, '0')}.${String(saat.getMinutes()).padStart(2, '0')}`);
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

  ws.on('close', () => clearTimeout(authTimer));
});

// Not klasorunu AI ajanlari/editorler dogrudan degistirebilir. fs.watch yalniz
// sinyal verir; gercek farki stat parmak iziyle debounced tarayarak buluruz.
let notesWatchTimer = null;
let notesWatcher = null;
let knownNotes = new Map();
function diskNotesState() {
  const out = new Map();
  try {
    for (const name of listNotes()) {
      const s = fs.statSync(notePath(name));
      out.set(name, `${s.mtimeMs}:${s.size}`);
    }
  } catch {}
  return out;
}
function disDegisiklikleriTara() {
  const now = Date.now();
  const next = diskNotesState();
  const oncekiAdlar = [...knownNotes.keys()].sort().join('\0');
  const yeniAdlar = [...next.keys()].sort().join('\0');

  for (const [name, sig] of next) {
    if (knownNotes.get(name) === sig) continue;
    if (isExpectedFsEvent(name, sig, now)) continue;

    // Ayni anda tarayicida kaydedilmemis tuslar varsa iki tarafi da koru:
    // disaridan yazilan ana notta kalir, tarayici taslagi cakisma kopyasina gider.
    if (saveTimers[name] && latest[name] !== undefined) {
      clearTimeout(saveTimers[name]);
      delete saveTimers[name];
      const d = new Date();
      const copy = noteWithSuffix(name, ` - tarayici cakismasi ${String(d.getHours()).padStart(2, '0')}.${String(d.getMinutes()).padStart(2, '0')}`);
      saveNote(copy, latest[name]);
      broadcast({ type: 'conflict', name, copy });
    }

    try {
      const content = fs.readFileSync(notePath(name), 'utf8');
      latest[name] = content;
      replicaTrack(name);
      broadcast({ type: 'content', name, content, live: true, external: true });
      broadcast({ type: 'saved', name, hash: icerikHash(content) });
    } catch {}
  }

  for (const name of knownNotes.keys()) {
    if (next.has(name) || isExpectedFsEvent(name, null, now)) continue;
    delete latest[name];
    replicaTrack(name, true);
  }

  knownNotes = next;
  if (oncekiAdlar !== yeniAdlar) broadcast({ type: 'list', notes: listNotes() });
}
function startNotesWatcher() {
  knownNotes = diskNotesState();
  const changed = () => {
    clearTimeout(notesWatchTimer);
    notesWatchTimer = setTimeout(disDegisiklikleriTara, 180);
  };
  try {
    notesWatcher = fs.watch(NOTES_DIR, { recursive: true }, changed);
  } catch (e) {
    try { notesWatcher = fs.watch(NOTES_DIR, changed); }
    catch { console.log('not klasoru izlenemedi:', e.message); }
  }
}
startNotesWatcher();

wss.on('error', () => {}); // hata mesaji http server handler'inda
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log('Port ' + PORT + ' zaten kullaniliyor, mevcut sunucuya baglanilacak.');
    clearTimeout(notesWatchTimer);
    clearTimeout(otoTimer);
    clearTimeout(pushTimer);
    try { notesWatcher?.close(); } catch {}
    try { replicaSync?.close(); } catch {}
    // `node server.js` ikinci bir sunucu olarak calistirildiysa temiz cik. Electron
    // icinden require edildiyse ana uygulama mevcut sunucuya baglanmaya devam eder.
    if (require.main === module) process.exit(0);
    return;
  }
  throw e;
});
server.listen(PORT, '0.0.0.0', () => {
  replicaSync.start();
  const nets = require('os').networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets))
    for (const net of nets[name])
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
  console.log('Notlar-Sync calisiyor!');
  console.log('  Bu PC:      http://localhost:' + PORT);
  ips.forEach(ip => console.log('  Diger PC:   http://' + ip + ':' + PORT));
  if (process.env.NOTLAR_NO_RUNTIME_START !== '1') installer.ensureOllamaService().catch(() => {});
});
server.on('close', () => {
  try { replicaSync?.close(); } catch {}
});
