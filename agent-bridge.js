#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const DATA_DIR = path.join(os.homedir(), 'NotlarSync');
const CONFIG_PATH = path.join(DATA_DIR, 'app-config.json');
const BRIDGE_CONFIG_PATH = path.join(DATA_DIR, 'integrations', 'bridge-config.json');

function readJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

const appConfig = readJson(CONFIG_PATH);
const bridgeConfig = readJson(BRIDGE_CONFIG_PATH);
const base = process.env.NOTLAR_URL
  || (appConfig.mode === 'client' && appConfig.server
    ? String(appConfig.server).replace(/\/$/, '')
    : `http://127.0.0.1:${process.env.NOTLAR_PORT || appConfig.port || 7777}`);
const key = process.env.NOTLAR_KEY || appConfig.password || '';
let currentHookEvent = '';

function request(pathname, body, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, base + '/');
    const payload = body === undefined ? null : JSON.stringify(body);
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, {
      method: payload ? 'POST' : 'GET',
      timeout,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(key ? { 'X-Api-Key': key } : {}),
      },
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; if (text.length > 8e6) req.destroy(); });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 500)}`));
        try { resolve(text ? JSON.parse(text) : {}); }
        catch { reject(new Error('Notlar Sync cevabi JSON degil')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Notlar Sync zaman asimi')));
    req.on('error', reject);
    req.end(payload);
  });
}

function canAutoStart() {
  try {
    const url = new URL(base);
    return appConfig.mode !== 'client' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
      && Array.isArray(bridgeConfig.serverCommand) && bridgeConfig.serverCommand.length;
  } catch { return false; }
}

async function ensureServer() {
  try { return await request('/api/health', undefined, 1200); }
  catch (firstError) {
    if (!canAutoStart()) throw firstError;
    const [command, ...args] = bridgeConfig.serverCommand;
    const child = spawn(command, args, { detached: true, stdio: 'ignore', env: { ...process.env, NOTLAR_AGENT_BACKGROUND: '1' } });
    child.unref();
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      try { return await request('/api/health', undefined, 800); } catch {}
    }
    throw firstError;
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; if (data.length > 2e6) data = data.slice(-2e6); });
    process.stdin.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); }
      catch { resolve({}); }
    });
    if (process.stdin.isTTY) resolve({});
  });
}

function option(name, fallback = '') {
  const index = process.argv.findIndex((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
  if (index === -1) return fallback;
  const value = process.argv[index];
  return value.includes('=') ? value.slice(value.indexOf('=') + 1) : (process.argv[index + 1] || fallback);
}

function projectName(cwd) {
  const clean = String(cwd || '').replace(/[\\/]+$/, '');
  return path.basename(clean) || 'Genel';
}

function compactMessage(value) {
  let text = String(value || '').trim();
  text = text.replace(/```[\s\S]*?```/g, '[kod bloğu]')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ');
  if (text.length <= 3200) return text;
  return `${text.slice(0, 1900)}\n\n[...kısaltıldı...]\n\n${text.slice(-1100)}`;
}

function filesFrom(value) {
  const files = new Set();
  const text = String(value || '');
  for (const match of text.matchAll(/`([^`\n]{1,260}\.(?:js|ts|tsx|jsx|json|html|css|md|py|rs|go|java|kt|swift|toml|yaml|yml|sh))(?::\d+)?`/g)) files.add(match[1]);
  return [...files].slice(0, 40);
}

function nextStepFrom(value) {
  const lines = String(value || '').split('\n').map((line) => line.replace(/^[-*#\s]+/, '').trim()).filter(Boolean);
  const match = lines.find((line) => /(?:sıradaki|sonraki|kalan|next|remaining|devam|henüz)/i.test(line));
  return match ? match.slice(0, 700) : '';
}

function startPayload(input, agent) {
  const cwd = input.cwd || process.cwd();
  return {
    sessionId: input.session_id || option('session-id'),
    agent,
    client: safeClient(input),
    workspace: cwd,
    project: projectName(cwd),
    title: input.session_title || `${projectName(cwd)} · ${agent}`,
    goal: input.goal || input.prompt || '',
  };
}

function safeClient(input) {
  if (option('client')) return option('client');
  return option('agent') || process.env.NOTLAR_AGENT || (input.model ? 'agent-hook' : 'hook');
}

async function ensureSession(input, agent) {
  try {
    return await request('/api/memory/session/heartbeat', {
      sessionId: input.session_id,
      activity: input.hook_event_name || 'hook',
    });
  } catch {
    return request('/api/memory/session/start', startPayload(input, agent));
  }
}

function startContext(result) {
  const context = result?.context?.markdown || '';
  return [
    context,
    '',
    '## AI Beyni çalışma protokolü',
    '- Bu bağlam kalıcı Notlar Sync hafızasından geldi; güncel kullanıcı talimatı her zaman üstündür.',
    '- Önemli karar, tercih, hata ve görevlerde Notlar Sync MCP hafıza araçlarını kullan.',
    '- Hassas bilgi, parola veya tokenı hafızaya yazma.',
  ].filter(Boolean).join('\n');
}

async function handleHook(input, agent) {
  const event = input.hook_event_name || '';
  await ensureServer();
  if (event === 'SessionStart') {
    const result = await request('/api/memory/session/start', startPayload(input, agent));
    process.stdout.write(startContext(result));
    return;
  }
  if (event === 'UserPromptSubmit') {
    await ensureSession(input, agent);
    await request('/api/memory/session/heartbeat', {
      sessionId: input.session_id,
      activity: compactMessage(input.prompt).slice(0, 240),
    });
    process.stdout.write('{}');
    return;
  }
  if (event === 'PostToolUse') {
    await ensureSession(input, agent);
    await request('/api/memory/session/heartbeat', {
      sessionId: input.session_id,
      activity: `Araç: ${String(input.tool_name || 'bilinmiyor').slice(0, 160)}`,
    });
    return;
  }
  if (event === 'Stop') {
    await ensureSession(input, agent);
    const message = compactMessage(input.last_assistant_message);
    if (message) {
      await request('/api/memory/checkpoint', {
        sessionId: input.session_id,
        title: `${projectName(input.cwd)} · tur checkpointi`,
        summary: message,
        files: filesFrom(input.last_assistant_message),
        nextStep: nextStepFrom(input.last_assistant_message),
        tags: ['otomatik', agent, 'turn'],
        rollingKey: 'turn-auto',
      });
    }
    process.stdout.write('{}');
    return;
  }
  if (event === 'SessionEnd') {
    await ensureSession(input, agent);
    await request('/api/memory/session/end', {
      sessionId: input.session_id,
      reason: input.reason || 'session-end',
    });
    return;
  }
  if (event === 'PreCompact') {
    await ensureSession(input, agent);
    await request('/api/memory/checkpoint', {
      sessionId: input.session_id,
      title: `${projectName(input.cwd)} · sıkıştırma öncesi`,
      summary: 'Konuşma bağlamı sıkıştırılmadan önce otomatik güvenlik checkpointi oluşturuldu.',
      nextStep: 'Sıkıştırma sonrası kalıcı hafıza bağlamını yeniden yükle.',
      tags: ['otomatik', agent, 'compact'],
      rollingKey: 'compact-auto',
    });
  }
}

async function main() {
  const command = process.argv[2] || 'hook';
  const input = await readStdin();
  currentHookEvent = input.hook_event_name || '';
  const agent = option('agent', process.env.NOTLAR_AGENT || (command === 'hook' ? 'unknown-agent' : 'cli'));
  if (command === 'hook') return handleHook(input, agent);
  await ensureServer();
  if (command === 'start') return process.stdout.write(JSON.stringify(await request('/api/memory/session/start', { ...input, ...startPayload(input, agent) }), null, 2));
  if (command === 'recall') return process.stdout.write(JSON.stringify(await request('/api/memory/recall', input), null, 2));
  if (command === 'event') return process.stdout.write(JSON.stringify(await request('/api/memory/event', input), null, 2));
  if (command === 'checkpoint') return process.stdout.write(JSON.stringify(await request('/api/memory/checkpoint', input), null, 2));
  if (command === 'end') return process.stdout.write(JSON.stringify(await request('/api/memory/session/end', input), null, 2));
  if (command === 'status') return process.stdout.write(JSON.stringify(await request('/api/memory/overview'), null, 2));
  throw new Error(`bilinmeyen komut: ${command}`);
}

main().catch((error) => {
  const hookMode = !process.argv[2] || process.argv[2] === 'hook';
  process.stderr.write(`Notlar Sync AI Beyni: ${String(error.message || error).slice(0, 500)}\n`);
  if (hookMode) {
    if (currentHookEvent === 'Stop') process.stdout.write('{}');
    process.exitCode = 0;
  } else process.exitCode = 1;
});
