// Notlar Sync - masaustu uygulamasi (Electron)
// app-config.json:
//   mode: "host"   -> sunucuyu bu uygulamanin icinde baslatir (masaustu PC)
//   mode: "client" -> sadece baglanir, "server" adresini kullanir (laptop)
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

// ayarlar ve notlar ~/NotlarSync altinda (server.js ile ayni yer)
const DATA_DIR = path.join(require('os').homedir(), 'NotlarSync');
fs.mkdirSync(DATA_DIR, { recursive: true });
const CONFIG_PATH = path.join(DATA_DIR, 'app-config.json');
if (!fs.existsSync(CONFIG_PATH))
  fs.copyFileSync(path.join(__dirname, 'app-config.example.json'), CONFIG_PATH);
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

if (config.mode === 'host') {
  require('./server.js');
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Notlar Sync',
    backgroundColor: '#1e1e1e',
    autoHideMenuBar: true,
  });
  const url = config.mode === 'host' ? 'http://localhost:7777' : config.server;
  // host modunda sunucunun ayaga kalkmasina yarim saniye ver
  setTimeout(() => win.loadURL(url), config.mode === 'host' ? 500 : 0);
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
