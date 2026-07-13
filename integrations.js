'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function findBin(name) {
  const candidates = String(process.env.PATH || '').split(path.delimiter)
    .concat([
      path.join(os.homedir(), '.local', 'bin'),
      path.join(os.homedir(), '.local', 'node-v22', 'bin'),
      '/usr/local/bin', '/usr/bin', '/bin',
    ])
    .map((dir) => path.join(dir, name));
  for (const candidate of candidates) {
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch {}
  }
  return null;
}

function resolveNodeRuntime() {
  const node = process.env.NOTLAR_FORCE_APP_RUNTIME === '1' ? null : findBin('node');
  if (node) return { command: node, env: {}, source: 'node' };
  const executable = process.env.NOTLAR_APP_EXECUTABLE;
  if (executable && fs.existsSync(executable)) {
    return { command: executable, env: { ELECTRON_RUN_AS_NODE: '1' }, source: 'electron' };
  }
  return null;
}

function atomicJson(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode });
  fs.renameSync(temp, file);
  try { fs.chmodSync(file, mode); } catch {}
}

function shellQuote(value) {
  if (process.platform === 'win32') return `"${String(value).replace(/%/g, '%%').replace(/"/g, '""')}"`;
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function runtimeSpec(value) {
  return typeof value === 'string' ? { command: value, env: {}, source: 'node' } : value;
}

function hookCommand(runtimeValue, bridge, agent) {
  const runtime = runtimeSpec(runtimeValue);
  const command = `${shellQuote(runtime.command)} ${shellQuote(bridge)} hook --agent ${agent}`;
  if (runtime.env?.ELECTRON_RUN_AS_NODE !== '1') return command;
  return process.platform === 'win32'
    ? `set "ELECTRON_RUN_AS_NODE=1" && ${command}`
    : `ELECTRON_RUN_AS_NODE=1 ${command}`;
}

function isOurHook(group) {
  return (group?.hooks || []).some((hook) => /agent-bridge\.js['"]?\s+hook/.test(String(hook.command || '')));
}

function mergeHookEvent(hooks, event, group) {
  hooks[event] = (Array.isArray(hooks[event]) ? hooks[event] : []).filter((item) => !isOurHook(item));
  hooks[event].push(group);
}

function commandGroup(command, options = {}) {
  return {
    ...(options.matcher ? { matcher: options.matcher } : {}),
    hooks: [{
      type: 'command',
      command,
      timeout: options.timeout || 15,
      ...(options.statusMessage ? { statusMessage: options.statusMessage } : {}),
    }],
  };
}

function configureHooks(file, provider, runtime, bridge) {
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) settings = {};
  settings.hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  const command = hookCommand(runtime, bridge, provider);
  mergeHookEvent(settings.hooks, 'SessionStart', commandGroup(command, {
    matcher: 'startup|resume|clear|compact', timeout: 25, statusMessage: 'Notlar Sync hafızası yükleniyor',
  }));
  mergeHookEvent(settings.hooks, 'UserPromptSubmit', commandGroup(command, { timeout: 8 }));
  mergeHookEvent(settings.hooks, 'PostToolUse', commandGroup(command, {
    matcher: provider === 'codex' ? 'Bash|apply_patch|Edit|Write|mcp__notlar.sync__.*' : 'Bash|Write|Edit|MultiEdit|NotebookEdit|mcp__notlar-sync__.*',
    timeout: 8,
  }));
  mergeHookEvent(settings.hooks, 'PreCompact', commandGroup(command, { timeout: 12 }));
  mergeHookEvent(settings.hooks, 'Stop', commandGroup(command, { timeout: 20, statusMessage: 'AI checkpoint kaydediliyor' }));
  if (provider === 'claude') mergeHookEvent(settings.hooks, 'SessionEnd', commandGroup(command, { timeout: 12 }));
  atomicJson(file, settings);
  return file;
}

function commandOutput(file, args) {
  try { return execFileSync(file, args, { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch (error) {
    const message = String(error.stderr || error.stdout || error.message || error).trim();
    throw new Error(message.split('\n')[0].slice(0, 300));
  }
}

function registerMcp(provider, binary, runtimeValue, mcpFile) {
  const runtime = runtimeSpec(runtimeValue);
  try {
    if (provider === 'codex') commandOutput(binary, ['mcp', 'remove', 'notlar-sync']);
    else commandOutput(binary, ['mcp', 'remove', '--scope', 'user', 'notlar-sync']);
  } catch {}
  const environment = Object.entries(runtime.env || {}).flatMap(([key, value]) => [
    provider === 'codex' ? '--env' : '-e', `${key}=${value}`,
  ]);
  if (provider === 'codex') commandOutput(binary, ['mcp', 'add', ...environment, 'notlar-sync', '--', runtime.command, mcpFile]);
  else commandOutput(binary, ['mcp', 'add', '--scope', 'user', 'notlar-sync', ...environment, '--', runtime.command, mcpFile]);
}

function fileContains(file, pattern) {
  try { return pattern.test(fs.readFileSync(file, 'utf8')); }
  catch { return false; }
}

function mcpConfigured(provider, binary, mcpFile, configFile) {
  if (!binary) return false;
  try {
    const raw = fs.readFileSync(configFile, 'utf8');
    if (provider === 'codex') {
      const marker = '[mcp_servers.notlar-sync]';
      const start = raw.indexOf(marker);
      if (start < 0) return false;
      const rest = raw.slice(start + marker.length);
      const nextSection = rest.search(/\n\s*\[/);
      const section = nextSection < 0 ? rest : rest.slice(0, nextSection);
      return section.includes(mcpFile) || section.includes(mcpFile.replace(/\\/g, '\\\\'));
    }
    const parsed = JSON.parse(raw);
    const entry = parsed?.mcpServers?.['notlar-sync'];
    return !!entry && [entry.command, ...(entry.args || [])].includes(mcpFile);
  } catch { return false; }
}

function createManager(dataDir, sourceDir = __dirname) {
  const integrationDir = path.join(dataDir, 'integrations');
  const bridgeFile = path.join(integrationDir, 'agent-bridge.js');
  const mcpFile = path.join(integrationDir, 'mcp.js');
  const bridgeConfigFile = path.join(integrationDir, 'bridge-config.json');
  const packageFile = path.join(integrationDir, 'package.json');
  const codexHooks = path.join(os.homedir(), '.codex', 'hooks.json');
  const codexConfig = path.join(os.homedir(), '.codex', 'config.toml');
  const claudeSettings = path.join(os.homedir(), '.claude', 'settings.json');
  const claudeConfig = path.join(os.homedir(), '.claude.json');

  function serverCommand() {
    const appExecutable = process.env.NOTLAR_APP_EXECUTABLE;
    if (appExecutable && fs.existsSync(appExecutable)) return [appExecutable, '--server-only'];
    const node = findBin('node');
    const server = path.join(sourceDir, 'server.js');
    return node && fs.existsSync(server) ? [node, server] : [];
  }

  function prepareFiles() {
    fs.mkdirSync(integrationDir, { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(sourceDir, 'agent-bridge.js'), bridgeFile);
    const bundledMcp = path.join(sourceDir, 'integration', 'mcp.cjs');
    fs.copyFileSync(fs.existsSync(bundledMcp) ? bundledMcp : path.join(sourceDir, 'mcp.js'), mcpFile);
    try { fs.chmodSync(bridgeFile, 0o700); fs.chmodSync(mcpFile, 0o700); } catch {}
    let version = '1.0.0';
    try { version = require(path.join(sourceDir, 'package.json')).version; } catch {}
    atomicJson(packageFile, { name: 'notlar-sync-integration', private: true, version });
    atomicJson(bridgeConfigFile, { serverCommand: serverCommand(), installedAt: new Date().toISOString() });
    return { bridgeFile, mcpFile };
  }

  function status() {
    const runtime = resolveNodeRuntime();
    const codex = findBin('codex');
    const claude = findBin('claude');
    const prepared = fs.existsSync(bridgeFile) && fs.existsSync(mcpFile) && fs.existsSync(bridgeConfigFile);
    const providers = [
      {
        id: 'codex', name: 'Codex', installed: !!codex,
        hooksConfigured: fileContains(codexHooks, /agent-bridge\.js['"]?\s+hook --agent codex/),
        mcpConfigured: prepared && mcpConfigured('codex', codex, mcpFile, codexConfig),
        reviewRequired: true,
        detail: codex || 'Codex CLI bulunamadı',
      },
      {
        id: 'claude', name: 'Claude Code', installed: !!claude,
        hooksConfigured: fileContains(claudeSettings, /agent-bridge\.js['"]?\s+hook --agent claude/),
        mcpConfigured: prepared && mcpConfigured('claude', claude, mcpFile, claudeConfig),
        reviewRequired: false,
        detail: claude || 'Claude Code bulunamadı',
      },
    ];
    return {
      prepared,
      node: runtime?.command || '',
      nodeRuntime: runtime?.source || '',
      bridgeFile,
      mcpFile,
      providers,
      allReady: !!runtime && providers.filter((provider) => provider.installed).every((provider) => provider.hooksConfigured && provider.mcpConfigured),
    };
  }

  function install(provider = 'all') {
    if (!['all', 'codex', 'claude'].includes(provider)) throw new Error('gecersiz ajan entegrasyonu');
    const runtime = resolveNodeRuntime();
    if (!runtime) throw new Error('Node.js çalışma zamanı bulunamadı');
    prepareFiles();
    const logs = [];
    const selected = provider === 'all' ? ['codex', 'claude'] : [provider];
    for (const id of selected) {
      const binary = findBin(id === 'codex' ? 'codex' : 'claude');
      if (!binary) { logs.push(`${id}: kurulu değil, atlandı`); continue; }
      const hookFile = id === 'codex' ? codexHooks : claudeSettings;
      configureHooks(hookFile, id, runtime, bridgeFile);
      logs.push(`${id}: yaşam döngüsü hookları yazıldı`);
      registerMcp(id, binary, runtime, mcpFile);
      logs.push(`${id}: MCP kaydı tamamlandı`);
    }
    return { ok: true, logs, status: status() };
  }

  return { status, install, prepareFiles, integrationDir, bridgeFile, mcpFile };
}

module.exports = { createManager, findBin, resolveNodeRuntime, configureHooks };
