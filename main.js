// Notlar Sync - masaustu uygulamasi (Electron)
// app-config.json (~/NotlarSync/):
//   mode: "host"   -> yerel kopyayi ve sunucuyu bu uygulamanin icinde baslatir
//   mode: "client" -> geriye uyumlu uzak istemci; yeni eslestirmeler host/peer kalir
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

// ayarlar ve notlar ~/NotlarSync altinda (server.js ile ayni yer)
const DATA_DIR = path.join(require('os').homedir(), 'NotlarSync');
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
try { fs.chmodSync(DATA_DIR, 0o700); } catch {}
const CONFIG_PATH = path.join(DATA_DIR, 'app-config.json');
const serverOnly = process.argv.includes('--server-only');
process.env.NOTLAR_APP_EXECUTABLE = process.execPath;
function writeConfig(next) {
  const tmp = path.join(DATA_DIR, `.app-config.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  try {
    fs.renameSync(tmp, CONFIG_PATH);
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes(error.code) || !fs.existsSync(CONFIG_PATH)) {
      try { fs.unlinkSync(tmp); } catch {}
      throw error;
    }
    fs.unlinkSync(CONFIG_PATH);
    fs.renameSync(tmp, CONFIG_PATH);
  }
  try { fs.chmodSync(CONFIG_PATH, 0o600); } catch {}
}
if (!fs.existsSync(CONFIG_PATH)) {
  const example = fs.readFileSync(path.join(__dirname, 'app-config.example.json'), 'utf8');
  writeConfig(JSON.parse(example.replace('degistir-beni', require('crypto').randomBytes(16).toString('base64url'))));
}
try { fs.chmodSync(CONFIG_PATH, 0o600); } catch {}
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

if (config.mode === 'host') {
  require('./server.js');
}

const hostPort = Number(config.port) || 7777;
function httpUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Gecersiz sunucu adresi');
  return url.href.replace(/\/$/, '');
}
const appUrl = config.mode === 'host' ? `http://localhost:${hostPort}` : httpUrl(config.server);
let win;

function lockNavigation(window, allowedOrigin) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url);
      if (['http:', 'https:'].includes(target.protocol)) shell.openExternal(target.href);
    } catch {}
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    try {
      const target = new URL(url);
      if (target.origin === allowedOrigin || (allowedOrigin === 'file:' && target.protocol === 'file:')) return;
      event.preventDefault();
      if (['http:', 'https:'].includes(target.protocol)) shell.openExternal(target.href);
    } catch { event.preventDefault(); }
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
}

function openMain() {
  if (win) return;
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Notlar Sync',
    backgroundColor: '#101014',
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  lockNavigation(win, new URL(appUrl).origin);
  // host modunda sunucunun ayaga kalkmasina yarim saniye ver
  const bootstrapUrl = appUrl + (config.password ? '#auth=' + encodeURIComponent(config.password) : '');
  setTimeout(() => win.loadURL(bootstrapUrl), config.mode === 'host' ? 500 : 0);
}

// --- tailscale durumu ---
// yok        : kurulu degil
// NeedsLogin : kurulu ama giris yapilmamis
// Stopped    : kurulu ama kapali
// Running    : hazir (ip dolu gelir)
function tailscaleStatus(cb) {
  execFile('tailscale', ['status', '--json'], (e, out) => {
    try {
      const s = JSON.parse(out);
      const ip = ((s.Self && s.Self.TailscaleIPs) || [])[0] || '';
      cb({ state: s.BackendState || 'bilinmiyor', ip });
    } catch {
      cb({ state: 'yok', ip: '' });
    }
  });
}

async function pairRequest(base, pathname, options = {}) {
  const root = httpUrl(base) + '/';
  const url = new URL(pathname.replace(/^\//, ''), root);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw new Error(text || `HTTP ${response.status}`);
    return text ? JSON.parse(text) : {};
  } finally { clearTimeout(timer); }
}

ipcMain.handle('setup:status', () => new Promise((resolve) => tailscaleStatus(resolve)));
ipcMain.handle('setup:patch-config', (_event, patch) => {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Gecersiz ayar');
  const current = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const allowed = {};
  for (const key of ['setupDone', 'tailscaleSkip']) if (key in patch) allowed[key] = !!patch[key];
  if ('mode' in patch) {
    if (!['host', 'client'].includes(patch.mode)) throw new Error('Gecersiz mod');
    allowed.mode = patch.mode;
  }
  if ('server' in patch) allowed.server = httpUrl(String(patch.server));
  if ('password' in patch) allowed.password = String(patch.password).slice(0, 512);
  writeConfig({ ...current, ...allowed });
  return true;
});
ipcMain.handle('setup:pair-claim', (_event, data) => pairRequest(data.address, '/api/pair/claim', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ kod: data.code, cihazAdi: data.deviceName }),
}));
ipcMain.handle('setup:pair-approve', (_event, data) => pairRequest(data.address, '/api/pair/cihaz-onay', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ kod: data.code, claimId: data.claimId }),
}));
ipcMain.handle('setup:pair-status', (_event, data) => pairRequest(data.address,
  `/api/pair/durum?kod=${encodeURIComponent(data.code)}&claimId=${encodeURIComponent(data.claimId)}`));
// Yeni kurulum akisi: diger sunucuya donusmek yerine bu bilgisayarin kendi
// yerel replikasini peer olarak baglar. Yerel ana parola cihazda kalir.
const localServerUrl = `http://127.0.0.1:${hostPort}`;
const localAuthHeaders = () => ({ 'Content-Type': 'application/json', 'X-Api-Key': String(config.password || '') });
ipcMain.handle('setup:peer-connect', (_event, data) => pairRequest(localServerUrl, '/api/sync/pair/connect', {
  method: 'POST', headers: localAuthHeaders(),
  body: JSON.stringify({ address: data.address, code: data.code, deviceName: data.deviceName }),
}));
ipcMain.handle('setup:peer-status', () => pairRequest(localServerUrl, '/api/sync/status', {
  headers: { 'X-Api-Key': String(config.password || '') },
}));
ipcMain.handle('setup:open-url', (_event, value) => {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !['tailscale.com', 'login.tailscale.com'].includes(url.hostname)) throw new Error('Adres engellendi');
  return shell.openExternal(url.href);
});
ipcMain.handle('setup:install-tailscale', () => new Promise((resolve) => {
  if (process.platform !== 'linux') return resolve({ ok: false, error: 'Tarayicidan indir' });
  execFile('pkexec', ['sh', '-c', 'curl -fsSL https://tailscale.com/install.sh | sh'], { timeout: 300000 }, (error, _out, stderr) =>
    resolve({ ok: !error, error: error ? String(stderr || error.message).split('\n')[0] : '' }));
}));
ipcMain.handle('setup:tailscale-up', (event) => {
  const user = require('os').userInfo().username;
  const child = execFile('pkexec', ['tailscale', 'up', `--operator=${user}`], { timeout: 300000 }, () => {});
  let seen = '';
  const scan = (data) => {
    seen += String(data);
    const match = seen.match(/https:\/\/login\.tailscale\.com\/\S+/);
    if (match && !event.sender.isDestroyed()) event.sender.send('setup:login-url', match[0]);
  };
  child.stdout?.on('data', scan); child.stderr?.on('data', scan);
  return { started: true };
});

// ilk acilis kurulum ekrani: tailscale kur/giris yap/atla
function openSetup(status) {
  let done = false;
  const sw = new BrowserWindow({
    width: 620, height: 680,
    title: 'Notlar Sync — Kurulum',
    backgroundColor: '#1e1e1e',
    autoHideMenuBar: true, resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'setup-preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  sw.loadFile(path.join(__dirname, 'public', 'setup.html'), {
    query: { state: status.state, ip: status.ip, mode: config.mode, port: hostPort },
  });
  lockNavigation(sw, 'file:');
  // kurulum bittiginde config degismis olabilir (host -> client eslesme),
  // temiz yeniden baslat: yeni surec dogru modu/adresi okur
  ipcMain.once('setup-done', () => { done = true; app.relaunch(); app.exit(0); });
  sw.on('closed', () => { if (!done) openMain(); }); // X'e basarsa bu seferlik atla
}

app.whenReady().then(() => {
  if (serverOnly) return;
  // setup bir kez calisir; bittikten sonra (setupDone) veya kullanici atladiysa direkt ana pencere
  if (config.setupDone || config.tailscaleSkip) return openMain();
  tailscaleStatus((st) => openSetup(st));
});
app.on('window-all-closed', () => { if (!serverOnly) app.quit(); });
