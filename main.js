// Notlar Sync - masaustu uygulamasi (Electron)
// app-config.json (~/NotlarSync/):
//   mode: "host"   -> sunucuyu bu uygulamanin icinde baslatir (masaustu PC)
//   mode: "client" -> sadece baglanir, "server" adresini kullanir (laptop)
const { app, BrowserWindow, ipcMain } = require('electron');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

// ayarlar ve notlar ~/NotlarSync altinda (server.js ile ayni yer)
const DATA_DIR = path.join(require('os').homedir(), 'NotlarSync');
fs.mkdirSync(DATA_DIR, { recursive: true });
const CONFIG_PATH = path.join(DATA_DIR, 'app-config.json');
if (!fs.existsSync(CONFIG_PATH)) {
  const example = fs.readFileSync(path.join(__dirname, 'app-config.example.json'), 'utf8');
  fs.writeFileSync(CONFIG_PATH, example.replace('degistir-beni', require('crypto').randomBytes(6).toString('hex')));
}
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

if (config.mode === 'host') {
  require('./server.js');
}

const appUrl = config.mode === 'host' ? 'http://localhost:7777' : config.server;
let win;

function openMain() {
  if (win) return;
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Notlar Sync',
    backgroundColor: '#1e1e1e',
    autoHideMenuBar: true,
  });
  // host modunda sunucunun ayaga kalkmasina yarim saniye ver
  setTimeout(() => win.loadURL(appUrl), config.mode === 'host' ? 500 : 0);
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

// ilk acilis kurulum ekrani: tailscale kur/giris yap/atla
function openSetup(status) {
  let done = false;
  const sw = new BrowserWindow({
    width: 600, height: 560,
    title: 'Notlar Sync — Kurulum',
    backgroundColor: '#1e1e1e',
    autoHideMenuBar: true, resizable: false,
    // yerel, pakete gomulu sayfa; sistem komutu (tailscale kurulumu) calistirmasi gerekiyor.
    // uzak icerik bu pencerede ASLA acilmaz (ana pencere node'suz ayri acilir).
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  sw.loadFile(path.join(__dirname, 'public', 'setup.html'), {
    query: { state: status.state, ip: status.ip, mode: config.mode, config: CONFIG_PATH },
  });
  ipcMain.once('setup-done', () => { done = true; openMain(); if (!sw.isDestroyed()) sw.close(); });
  sw.on('closed', () => { if (!done) openMain(); }); // X'e basarsa bu seferlik atla
}

app.whenReady().then(() => {
  tailscaleStatus((st) => {
    if (st.state === 'Running' || config.tailscaleSkip) openMain();
    else openSetup(st);
  });
});
app.on('window-all-closed', () => app.quit());
