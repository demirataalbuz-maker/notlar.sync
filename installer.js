'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const DATA_DIR = path.join(os.homedir(), 'NotlarSync');
const RUNTIME_DIR = path.join(DATA_DIR, 'runtime');
const VENV_DIR = path.join(RUNTIME_DIR, 'python');
const MODEL_DIR = path.join(RUNTIME_DIR, 'models');
const VISION_MODEL = 'qwen2.5vl:3b';
const EMBED_MODEL = 'nomic-embed-text';

const state = {
  running: false,
  action: null,
  step: '',
  progress: 0,
  logs: [],
  error: '',
  startedAt: null,
  finishedAt: null,
  child: null,
};

function bin(name) {
  const dirs = String(process.env.PATH || '').split(path.delimiter)
    .concat([path.join(os.homedir(), '.local', 'bin'), '/usr/local/bin', '/usr/bin', '/bin']);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch {}
  }
  return null;
}

function addLog(value, notify) {
  const lines = String(value || '').replace(/\r/g, '').split('\n').map((line) => line.trim()).filter(Boolean);
  for (const line of lines) state.logs.push(line.slice(0, 300));
  state.logs = state.logs.slice(-120);
  if (notify) notify(snapshot());
}

function setStep(step, progress, notify) {
  state.step = step;
  state.progress = progress;
  addLog(step, notify);
}

function run(file, args, notify, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd || RUNTIME_DIR,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    state.child = child;
    child.stdout.on('data', (data) => addLog(data, notify));
    child.stderr.on('data', (data) => addLog(data, notify));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      state.child = null;
      if (code === 0) resolve();
      else reject(new Error(signal ? `işlem ${signal} ile durdu` : `${path.basename(file)} çıkış kodu ${code}`));
    });
  });
}

function ollamaInfo() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: 11434, path: '/api/tags', timeout: 1800 }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; if (body.length > 2e6) req.destroy(); });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve({ online: res.statusCode === 200, models: (parsed.models || []).map((model) => model.name || model.model).filter(Boolean) });
        } catch { resolve({ online: false, models: [] }); }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ online: false, models: [] }));
  });
}

function hasSpeechRuntime() {
  const python = process.platform === 'win32'
    ? path.join(VENV_DIR, 'Scripts', 'python.exe')
    : path.join(VENV_DIR, 'bin', 'python3');
  if (!fs.existsSync(python)) return false;
  try {
    execFileSync(python, ['-c', 'import faster_whisper'], { stdio: 'ignore', timeout: 8000 });
    return true;
  } catch { return false; }
}

function modelInstalled(models, wanted) {
  const base = wanted.split(':')[0];
  return models.some((model) => model === wanted || model.split(':')[0] === base);
}

async function status(config = {}) {
  const ollama = await ollamaInfo();
  const textModel = config.cevapModeli || 'qwen3:8b';
  const components = [
    { id: 'pdf', group: 'system', name: 'PDF metni', ready: !!bin('pdftotext'), detail: 'poppler / pdftotext' },
    { id: 'media', group: 'system', name: 'Ses ve video', ready: !!bin('ffmpeg'), detail: 'ffmpeg' },
    { id: 'ocr', group: 'system', name: 'Görsel OCR', ready: !!bin('tesseract'), detail: 'Tesseract Türkçe + İngilizce' },
    { id: 'speech', group: 'speech', name: 'Konuşmayı yazıya çevirme', ready: hasSpeechRuntime(), detail: 'faster-whisper base modeli' },
    { id: 'ollama', group: 'ollama', name: 'Yerel AI motoru', ready: !!bin('ollama'), detail: 'Ollama' },
    { id: 'ollama-service', group: 'ollama', name: 'Yerel AI servisi', ready: ollama.online, detail: '127.0.0.1:11434' },
    { id: 'text-model', group: 'models', name: 'Metin modeli', ready: modelInstalled(ollama.models, textModel), detail: textModel },
    { id: 'vision-model', group: 'models', name: 'Görsel modeli', ready: modelInstalled(ollama.models, VISION_MODEL), detail: VISION_MODEL },
    { id: 'embed-model', group: 'models', name: 'Hafıza embedding modeli', ready: modelInstalled(ollama.models, EMBED_MODEL), detail: EMBED_MODEL },
    { id: 'graph', group: null, name: 'Zihin haritası ve dışa aktarım', ready: true, detail: 'uygulamaya gömülü' },
  ];
  return {
    platform: process.platform,
    supported: process.platform === 'linux' && !!bin('apt-get') && !!bin('pkexec'),
    allReady: components.every((component) => component.ready),
    components,
    task: snapshot(),
  };
}

function snapshot() {
  return {
    running: state.running,
    action: state.action,
    step: state.step,
    progress: state.progress,
    logs: [...state.logs],
    error: state.error,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
  };
}

async function installSystem(notify) {
  const pkexec = bin('pkexec');
  const apt = bin('apt-get');
  if (!pkexec || !apt || process.platform !== 'linux') throw new Error('Otomatik sistem paketi kurulumu bu platformda desteklenmiyor');
  setStep('Paket listesi güncelleniyor', 8, notify);
  await run(pkexec, [apt, 'update'], notify);
  setStep('PDF, medya, OCR ve Python bileşenleri kuruluyor', 24, notify);
  await run(pkexec, [apt, 'install', '-y', 'poppler-utils', 'ffmpeg', 'tesseract-ocr', 'tesseract-ocr-eng', 'tesseract-ocr-tur', 'python3-venv'], notify);
}

async function installSpeech(notify) {
  const python = bin('python3');
  if (!python) throw new Error('python3 bulunamadı; önce sistem bileşenlerini kur');
  fs.mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(MODEL_DIR, { recursive: true, mode: 0o700 });
  const vpy = path.join(VENV_DIR, 'bin', 'python3');
  if (!fs.existsSync(vpy)) {
    setStep('İzole Python ortamı hazırlanıyor', 38, notify);
    await run(python, ['-m', 'venv', VENV_DIR], notify);
  }
  const pip = path.join(VENV_DIR, 'bin', 'pip');
  setStep('Faster Whisper kuruluyor', 48, notify);
  await run(pip, ['install', '--disable-pip-version-check', '--no-input', '--upgrade', 'pip', 'faster-whisper'], notify);
  setStep('Whisper base modeli indiriliyor', 62, notify);
  await run(vpy, ['-c', 'from faster_whisper import WhisperModel; WhisperModel("base", device="cpu", compute_type="int8")'], notify, {
    env: { HF_HOME: MODEL_DIR },
  });
}

function startOllama(binary, notify) {
  return new Promise((resolve) => {
    const child = spawn(binary, ['serve'], { detached: true, stdio: 'ignore', env: process.env });
    child.unref();
    addLog('Ollama servisi başlatıldı', notify);
    setTimeout(resolve, 1800);
  });
}

async function installOllama(notify) {
  let ollama = bin('ollama');
  if (!ollama) {
    const curl = bin('curl');
    const pkexec = bin('pkexec');
    if (!curl || !pkexec) throw new Error('Ollama kurulumu için curl ve pkexec gerekli');
    fs.mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
    const script = path.join(RUNTIME_DIR, 'ollama-install.sh');
    setStep('Ollama resmi kurulum betiği indiriliyor', 68, notify);
    await run(curl, ['-fsSL', '-o', script, 'https://ollama.com/install.sh'], notify);
    fs.chmodSync(script, 0o700);
    setStep('Ollama kuruluyor', 72, notify);
    await run(pkexec, ['/bin/sh', script], notify);
    ollama = bin('ollama');
  }
  if (!ollama) throw new Error('Ollama kurulamadı');
  const info = await ollamaInfo();
  if (!info.online) await startOllama(ollama, notify);
}

async function ensureOllamaService() {
  const ollama = bin('ollama');
  if (!ollama) return false;
  if (!(await ollamaInfo()).online) await startOllama(ollama);
  return (await ollamaInfo()).online;
}

async function installModels(config, notify) {
  const ollama = bin('ollama');
  if (!ollama) throw new Error('Önce Ollama kurulmalı');
  if (!(await ollamaInfo()).online) await startOllama(ollama, notify);
  const textModel = config.cevapModeli || 'qwen3:8b';
  setStep(`${textModel} indiriliyor`, 80, notify);
  await run(ollama, ['pull', textModel], notify);
  setStep(`${VISION_MODEL} indiriliyor`, 90, notify);
  await run(ollama, ['pull', VISION_MODEL], notify);
  setStep(`${EMBED_MODEL} indiriliyor`, 96, notify);
  await run(ollama, ['pull', EMBED_MODEL], notify);
}

async function install(action, config = {}, notify) {
  if (state.running) throw new Error('Başka bir kurulum zaten çalışıyor');
  if (!['all', 'system', 'speech', 'ollama', 'models'].includes(action)) throw new Error('Geçersiz kurulum bileşeni');
  state.running = true;
  state.action = action;
  state.step = 'Hazırlanıyor';
  state.progress = 1;
  state.logs = [];
  state.error = '';
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  if (notify) notify(snapshot());
  try {
    if (action === 'all' || action === 'system') await installSystem(notify);
    if (action === 'all' || action === 'speech') await installSpeech(notify);
    if (action === 'all' || action === 'ollama') await installOllama(notify);
    if (action === 'all' || action === 'models') await installModels(config, notify);
    setStep('Kurulum tamamlandı', 100, notify);
  } catch (error) {
    state.error = String(error.message || error).slice(0, 300);
    addLog('Hata: ' + state.error, notify);
  } finally {
    state.running = false;
    state.child = null;
    state.finishedAt = new Date().toISOString();
    if (notify) notify(snapshot());
  }
}

function cancel(notify) {
  if (!state.running || !state.child) return false;
  state.child.kill('SIGTERM');
  state.error = 'Kullanıcı tarafından durduruldu';
  if (notify) notify(snapshot());
  return true;
}

module.exports = {
  RUNTIME_DIR,
  VENV_DIR,
  MODEL_DIR,
  VISION_MODEL,
  EMBED_MODEL,
  bin,
  status,
  snapshot,
  install,
  cancel,
  ensureOllamaService,
};
