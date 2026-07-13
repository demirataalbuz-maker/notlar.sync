'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const port = Number(process.env.CDP_PORT || 9223);
const appUrl = process.env.UI_URL || 'http://127.0.0.1:7788/';
const key = process.env.UI_KEY || 'test-test-test-1234';
const outDir = process.env.UI_OUT || '/tmp/notlar-sync-ui-shots';
const runId = `${Date.now().toString(36)}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const lockPath = path.join(process.env.TMPDIR || '/tmp', `notlar-sync-ui-smoke-${port}.lock`);
const watchdogMs = Math.max(30000, Number(process.env.UI_WATCHDOG_MS) || 120000);
const recallTimeoutMs = Math.max(12000, Number(process.env.UI_RECALL_TIMEOUT_MS) || 30000);
let serverChild = null;
let cdp = null;
let lockHeld = false;
let watchdogTimer = null;
let currentStage = 'baslatiliyor';
const runStartedAt = Date.now();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stage(name) {
  currentStage = name;
  const elapsed = ((Date.now() - runStartedAt) / 1000).toFixed(1);
  console.error(`[ui-smoke:${runId}] +${elapsed}s ${name}`);
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

function acquireRunLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, runId, appUrl, startedAt: new Date().toISOString() }));
      } finally { fs.closeSync(fd); }
      lockHeld = true;
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner = null;
      try { owner = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch {}
      if (owner && processAlive(Number(owner.pid))) {
        throw new Error(`CDP ${port} icin UI smoke zaten calisiyor (pid ${owner.pid}, run ${owner.runId || 'bilinmiyor'})`);
      }
      try { fs.unlinkSync(lockPath); } catch (unlinkError) {
        if (unlinkError.code !== 'ENOENT') throw unlinkError;
      }
    }
  }
  throw new Error(`UI smoke kilidi alinamadi: ${lockPath}`);
}

function releaseRunLock() {
  if (!lockHeld) return;
  try {
    const owner = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (owner.runId === runId) fs.unlinkSync(lockPath);
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`[ui-smoke:${runId}] kilit temizlenemedi: ${error.message}`);
  }
  lockHeld = false;
}

function startWatchdog() {
  watchdogTimer = setTimeout(() => {
    const pending = cdp?.pendingSummary() || [];
    console.error(`[ui-smoke:${runId}] GLOBAL TIMEOUT (${watchdogMs}ms), asama=${currentStage}, pending=${JSON.stringify(pending)}`);
    try { cdp?.close(new Error(`global watchdog: ${currentStage}`)); } catch {}
    if (serverChild && serverChild.exitCode === null) serverChild.kill('SIGTERM');
    releaseRunLock();
    process.exit(124);
  }, watchdogMs);
}

function stopWatchdog() {
  if (watchdogTimer) clearTimeout(watchdogTimer);
  watchdogTimer = null;
}

async function startServerIfRequested() {
  if (process.env.UI_SPAWN_SERVER !== '1') return;
  const parsed = new URL(appUrl);
  serverChild = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, HOME: process.env.UI_SERVER_HOME || '/tmp/notlar-sync-ui', PORT: parsed.port || '7777', NOTLAR_NO_RUNTIME_START: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let failure = '';
  serverChild.stdout.resume();
  serverChild.stderr.on('data', (data) => { failure += data; });
  for (let attempt = 0; attempt < 60; attempt++) {
    if (serverChild.exitCode !== null) throw new Error(`UI server exited: ${failure}`);
    try {
      const response = await fetch(new URL('/api/health', appUrl), { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error('UI server start timeout');
}

class Cdp {
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    this.commandTimeoutMs = Math.max(1000, Number(process.env.UI_CDP_TIMEOUT_MS) || 15000);
    this.closedError = null;
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        try { this.ws.close(); } catch {}
        reject(new Error(`CDP connection timeout: ${this.url}`));
      }, this.commandTimeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.ws.removeEventListener('open', onOpen);
        this.ws.removeEventListener('error', onError);
      };
      const onOpen = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error(`CDP connection error: ${this.url}`)); };
      this.ws.addEventListener('open', onOpen, { once: true });
      this.ws.addEventListener('error', onError, { once: true });
    });
    this.ws.onmessage = (event) => {
      let message;
      try { message = JSON.parse(event.data); }
      catch (error) { return this.fail(new Error(`Invalid CDP message: ${error.message}`)); }
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
        else pending.resolve(message.result);
        return;
      }
      this.events.push(message);
    };
    this.ws.onerror = () => this.fail(new Error(`CDP websocket error: ${this.url}`));
    this.ws.onclose = (event) => this.fail(new Error(`CDP websocket closed (${event.code}${event.reason ? `: ${event.reason}` : ''})`));
  }

  fail(error) {
    if (!this.closedError) this.closedError = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.closedError);
    }
    this.pending.clear();
  }

  pendingSummary() {
    return [...this.pending.entries()].map(([id, pending]) => ({ id, method: pending.method }));
  }

  close(reason = new Error('CDP client closed')) {
    this.fail(reason);
    const socket = this.ws;
    this.ws = null;
    if (!socket) return;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try { socket.close(); } catch {}
  }

  send(method, params = {}, timeoutMs = this.commandTimeoutMs) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(this.closedError || new Error(`CDP websocket acik degil: ${method}`));
    }
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timeout (${timeoutMs}ms): ${method}`));
      }, Math.max(250, timeoutMs));
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async evaluate(expression, timeoutMs = this.commandTimeoutMs) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    }, timeoutMs);
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result.value;
  }

  async waitFor(expression, timeoutMs = 8000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const remaining = timeoutMs - (Date.now() - started);
      if (await this.evaluate(`Boolean(${expression})`, Math.max(250, Math.min(this.commandTimeoutMs, remaining)))) return;
      await sleep(120);
    }
    throw new Error(`Timeout: ${expression}`);
  }

  async screenshot(name) {
    const screenshotTimeoutMs = Math.max(this.commandTimeoutMs, Number(process.env.UI_SCREENSHOT_TIMEOUT_MS) || 45000);
    const result = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, screenshotTimeoutMs);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, name), Buffer.from(result.data, 'base64'));
  }
}

async function main() {
  acquireRunLock();
  startWatchdog();
  try {
  stage('test sunucusu denetleniyor');
  await startServerIfRequested();
  stage('CDP hedefi bulunuyor');
  const targets = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(8000) })
    .then((response) => response.json());
  const matchingTargets = targets.filter((item) => item.type === 'page' && item.url.startsWith(appUrl));
  if (!matchingTargets.length) throw new Error(`App target not found for ${appUrl}`);
  if (matchingTargets.length > 1) {
    throw new Error(`CDP ${port} uzerinde ${matchingTargets.length} eslesen uygulama hedefi var; benzersiz port/profil kullanin`);
  }
  const target = matchingTargets[0];

  cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.connect();
  stage('CDP baglandi');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Console.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  });

  await cdp.send('Page.navigate', { url: appUrl });
  await cdp.waitFor(`document.readyState === 'complete'`);
  await cdp.evaluate(`(async () => {
    localStorage.removeItem('key');
    for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister();
    for (const name of await caches.keys()) await caches.delete(name);
  })()`);
  const bootstrapUrl = new URL(appUrl);
  bootstrapUrl.searchParams.set('ui-smoke', runId);
  bootstrapUrl.hash = 'auth=' + encodeURIComponent(key);
  await cdp.send('Page.navigate', { url: bootstrapUrl.href });
  await cdp.waitFor(`document.readyState === 'complete'`);
  try { await cdp.waitFor(`document.getElementById('dot').classList.contains('on')`); }
  catch (error) {
    const debug = await cdp.evaluate(`({ href: location.href, hash: location.hash, parsed: new URLSearchParams(location.hash.slice(1)).get('auth'), bootValue: typeof bootAuth === 'undefined' ? '(undefined)' : bootAuth, keyValue: typeof key === 'undefined' ? '(undefined)' : key, stored: localStorage.getItem('key'), login: getComputedStyle(document.getElementById('login')).display, loginError: document.getElementById('loginErr').textContent, status: document.getElementById('statusText').textContent, hasBoot: document.documentElement.innerHTML.includes('bootAuth'), serviceWorker: navigator.serviceWorker.controller?.scriptURL || '' })`);
    const exceptions = cdp.events.filter((event) => event.method === 'Runtime.exceptionThrown').map((event) => event.params.exceptionDetails.exception?.description || event.params.exceptionDetails.text);
    throw new Error(`${error.message} ${JSON.stringify(debug)} exceptions=${JSON.stringify(exceptions)}`);
  }
  await cdp.waitFor(`location.hash === '' && !localStorage.getItem('key') && new URLSearchParams(location.search).get('ui-smoke') === ${JSON.stringify(runId)}`);
  await cdp.waitFor(`document.querySelectorAll('#recentNotes .overviewRow').length > 0`);
  stage('kimlik dogrulandi, test verisi hazirlaniyor');
  await cdp.evaluate(`(async () => {
    if (!folders.includes('UI Klasoru')) await apiFetch('/api/folders', jsonOptions('POST', { path: 'UI Klasoru' }));
    if (!notes.includes('UI Klasoru/Klasorlu Test')) await apiFetch('/api/note/' + encodeURIComponent('UI Klasoru/Klasorlu Test'), { method: 'POST', body: '# Klasorlu Test' });
    const started = await apiJson('/api/memory/session/start', jsonOptions('POST', {
      sessionId: 'ui-smoke-session', agent: 'codex', client: 'ui-smoke', project: 'Notlar Sync',
      workspace: '/tmp/notlar-sync-ui-project', goal: 'Canli AI Beyni ekranini dogrula'
    }));
    await apiJson('/api/memory/checkpoint', jsonOptions('POST', {
      sessionId: started.session.id, summary: 'AI Beyni arayuzu canli veriye baglandi',
      completed: ['Hafiza API baglantisi', 'Graf yerlesimi'], openTasks: ['Mobil gorunumu dogrula'],
      nextStep: 'Tum ekranlarin ekran goruntulerini denetle'
    }));
    await apiJson('/api/memory/facts', jsonOptions('POST', {
      subject: 'kullanici', predicate: 'kullanir', object: 'React', confidence: 0.8,
      validFrom: '2026-03-01T00:00:00.000Z', sessionId: started.session.id,
      project: 'Notlar Sync', workspace: '/tmp/notlar-sync-ui-project'
    }));
    await apiJson('/api/memory/facts', jsonOptions('POST', {
      subject: 'kullanici', predicate: 'kullanir', object: 'Vue', confidence: 0.9,
      validFrom: '2026-06-01T00:00:00.000Z', sessionId: started.session.id,
      project: 'Notlar Sync', workspace: '/tmp/notlar-sync-ui-project'
    }));
    const conflictSubject = 'ui gelistirme takimi ${runId}';
    await apiJson('/api/memory/facts', jsonOptions('POST', {
      subject: conflictSubject, predicate: 'tercih-eder', topic: 'kod editoru', object: 'VS Code koyu tema',
      assertionType: 'user', project: 'Notlar Sync', workspace: '/tmp/notlar-sync-ui-project'
    }));
    const conflict = await apiJson('/api/memory/facts', jsonOptions('POST', {
      subject: conflictSubject, predicate: 'tercih-eder', topic: 'editor tercihi', object: 'VS Code acik tema',
      assertionType: 'user', project: 'Notlar Sync', workspace: '/tmp/notlar-sync-ui-project'
    }));
    const forgotten = await apiJson('/api/memory/facts', jsonOptions('POST', {
      subject: 'ui-soft-secret-${runId}', predicate: 'sahip', topic: 'gizli konu', object: 'ui-soft-object-${runId}',
      value: 'ui-soft-value-${runId}', file: '/tmp/ui-soft-file-${runId}', noteId: 'ui-soft-note-${runId}',
      assertionType: 'imported', evidenceLevel: 'direct', project: 'Notlar Sync', workspace: '/tmp/notlar-sync-ui-project'
    }));
    await apiJson('/api/memory/forget', jsonOptions('POST', { id: forgotten.fact.id, mode: 'soft', reason: 'UI smoke' }));
    window.__uiConflictFactId = conflict.fact.id;
    window.__uiForgottenFactId = forgotten.fact.id;
    window.__uiForgottenSecret = 'ui-soft-secret-${runId}';
  })()`);
  await cdp.waitFor(`notes.includes('UI Klasoru/Klasorlu Test')`);

  stage('masaustu genel bakis dogrulaniyor');
  const overview = await cdp.evaluate(`({
    view: document.body.dataset.view,
    recent: document.querySelectorAll('#recentNotes .overviewRow').length,
    pinned: document.querySelectorAll('#pinnedNotes .overviewRow').length,
    horizontalOverflow: document.documentElement.scrollWidth > innerWidth
  })`);
  if (overview.view !== 'overview' || overview.recent < 1 || overview.horizontalOverflow) {
    throw new Error(`Overview failed: ${JSON.stringify(overview)}`);
  }
  await cdp.screenshot('desktop-overview.png');

  stage('masaustu not editoru dogrulaniyor');
  await cdp.evaluate(`showView('notes'); openNote('UI Klasoru/Klasorlu Test')`);
  await cdp.waitFor(`current && loaded && !document.getElementById('editor').disabled`);
  const noteState = await cdp.evaluate(`({
    title: document.getElementById('titleText').textContent,
    folders: document.querySelectorAll('#noteList .folderRow').length,
    selectedFolder: document.getElementById('selectedFolderLabel').textContent,
    previewButton: getComputedStyle(document.getElementById('previewBtn')).display,
    mainVisible: getComputedStyle(document.getElementById('main')).display,
    sidebarVisible: getComputedStyle(document.getElementById('sidebar')).display
  })`);
  if (noteState.title !== 'UI Klasoru/Klasorlu Test' || noteState.folders < 1 || noteState.selectedFolder !== 'UI Klasoru'
    || noteState.previewButton === 'none' || noteState.mainVisible === 'none' || noteState.sidebarVisible === 'none') {
    throw new Error(`Note view failed: ${JSON.stringify(noteState)}`);
  }
  await cdp.screenshot('desktop-note.png');

  stage('masaustu rotalari dogrulaniyor');
  const views = ['tools', 'ai', 'konsey', 'avci', 'document', 'runtime', 'sync', 'settings', 'vault'];
  const viewElements = { tools: 'tools', ai: 'ai', konsey: 'konsey', avci: 'avci', document: 'documentView', runtime: 'runtimeView', sync: 'settings', settings: 'appSettings', vault: 'vault' };
  for (const view of views) {
    await cdp.evaluate(`document.getElementById(${JSON.stringify({ tools: 'toolsBtn', ai: 'aiBtn', konsey: 'konseyBtn', avci: 'avciBtn', document: 'docBtn', runtime: 'runtimeBtn', sync: 'syncBtn', settings: 'setBtn', vault: 'vaultBtn' }[view])}).click()`);
    await sleep(180);
    const routeState = await cdp.evaluate(`(() => {
      const element = document.getElementById(${JSON.stringify(viewElements[view])});
      return {
        visible: document.body.dataset.view === ${JSON.stringify(view)} && getComputedStyle(element).display !== 'none',
        overflow: element.scrollWidth > element.clientWidth + 1
      };
    })()`);
    if (!routeState.visible || routeState.overflow) throw new Error(`Route failed: ${view} ${JSON.stringify(routeState)}`);
    if (view === 'konsey') await cdp.screenshot('desktop-konsey.png');
    if (view === 'avci') await cdp.screenshot('desktop-avci.png');
    if (view === 'sync') await cdp.screenshot('desktop-sync.png');
    if (view === 'settings') await cdp.screenshot('desktop-settings.png');
    if (view === 'runtime') await cdp.screenshot('desktop-runtime.png');
    if (view === 'vault') await cdp.screenshot('desktop-vault.png');
  }

  stage('peer sync, Konsey ve Saldiri Avcisi yuzeyleri dogrulaniyor');
  await cdp.evaluate(`showView('sync')`);
  await cdp.waitFor(`document.getElementById('peerRevision').textContent !== 'rev 0' || document.getElementById('peerDeviceName').textContent !== 'bu cihaz'`);
  const syncSurface = await cdp.evaluate(`({
    codeButton: document.getElementById('peerCodeBtn').textContent,
    connectButton: document.getElementById('peerConnectBtn').textContent,
    status: document.getElementById('peerDeviceName').textContent,
    overflow: document.getElementById('settings').scrollWidth > document.getElementById('settings').clientWidth + 1
  })`);
  if (!syncSurface.codeButton.includes('6 haneli') || !syncSurface.connectButton.includes('Bağlantı isteği')
    || !syncSurface.status || syncSurface.overflow) throw new Error(`Peer sync surface failed: ${JSON.stringify(syncSurface)}`);

  await cdp.evaluate(`showView('konsey')`);
  const councilSurface = await cdp.evaluate(`({
    notice: document.querySelector('#konsey .konseyNotice').textContent,
    maxLength: document.getElementById('konseyInput').maxLength,
    claudeModels: document.getElementById('konseyClaudeModel').options.length,
    codexModels: document.getElementById('konseyCodexModel').options.length
  })`);
  if (!councilSurface.notice.includes('bulut sağlayıcı') || councilSurface.maxLength !== 20000
    || councilSurface.claudeModels < 4 || councilSurface.codexModels < 3) throw new Error(`Konsey surface failed: ${JSON.stringify(councilSurface)}`);

  await cdp.evaluate(`showView('avci')`);
  await cdp.waitFor(`document.getElementById('avciBadge').textContent !== 'kontrol ediliyor'`, 8000);
  const hunterSurface = await cdp.evaluate(`({
    badge: document.getElementById('avciBadge').textContent,
    stateVisible: getComputedStyle(document.getElementById('avciState')).display !== 'none',
    frameReady: document.getElementById('avciFrame').classList.contains('ready'),
    retry: document.getElementById('avciRetry').textContent,
    overflow: document.getElementById('avci').scrollWidth > document.getElementById('avci').clientWidth + 1
  })`);
  if ((!hunterSurface.stateVisible && !hunterSurface.frameReady) || hunterSurface.badge === 'kontrol ediliyor'
    || hunterSurface.retry !== 'Yeniden dene' || hunterSurface.overflow) throw new Error(`Avci surface failed: ${JSON.stringify(hunterSurface)}`);
  await cdp.evaluate(`showView('vault')`);

  stage('sifre kasasi dogrulaniyor');
  await cdp.waitFor(`vLoadReady === true`);
  await cdp.evaluate(`
    document.getElementById('vMaster').value = 'vault-ui-test-1234';
    document.getElementById('vMasterConfirm').value = 'vault-ui-test-1234';
    document.getElementById('vUnlock').click();
  `);
  await cdp.waitFor(`Array.isArray(vEntries) && getComputedStyle(document.getElementById('vOpen')).display !== 'none'`, 12000);
  const hasVaultEntry = await cdp.evaluate(`document.querySelectorAll('#vList .vEntry').length > 0`);
  if (!hasVaultEntry) {
    await cdp.evaluate(`
      document.getElementById('eTitle').value = 'Test Hesabi';
      document.getElementById('eUrl').value = 'https://example.test';
      document.getElementById('eUser').value = 'demo';
      document.getElementById('ePass').value = 'local-only-password';
      document.getElementById('eAdd').click();
    `);
    await cdp.waitFor(`document.querySelectorAll('#vList .vEntry').length > 0`, 12000);
  }
  await cdp.screenshot('desktop-vault-open.png');

  stage('AI Beyni temel grafi dogrulaniyor');
  await cdp.evaluate(`showView('map')`);
  await cdp.waitFor(`document.getElementById('mapFrame').contentWindow?.__notlarBrainStats?.nodes > 0`, 12000);
  await sleep(500);
  const mapState = await cdp.evaluate(`(() => {
    const frame = document.getElementById('mapFrame');
    const doc = frame.contentDocument;
    const svg = doc.getElementById('graph');
    const rect = svg.getBoundingClientRect();
    const nodes = frame.contentWindow.__notlarBrainStats?.nodes ?? -1;
    return {
      width: rect.width, height: rect.height, nodes,
      renderedNodes: doc.querySelectorAll('#viewport .node').length,
      selected: doc.querySelectorAll('#viewport .node.selected').length,
      loadingHidden: doc.getElementById('brainLoading')?.hidden === true,
      innerRailHidden: getComputedStyle(doc.querySelector('.rail')).display === 'none',
      horizontalOverflow: doc.documentElement.scrollWidth > doc.documentElement.clientWidth + 1,
      source: frame.getAttribute('src')
    };
  })()`);
  if (!mapState.width || !mapState.height || mapState.nodes < 1 || mapState.renderedNodes !== mapState.nodes
    || mapState.selected !== 1 || !mapState.loadingHidden || !mapState.innerRailHidden || mapState.horizontalOverflow
    || !mapState.source.includes('brain.html')) throw new Error(`AI Brain failed: ${JSON.stringify(mapState)}`);
  await cdp.screenshot('desktop-brain.png');

  stage('AI Beyni not grafigi ve kume modu dogrulaniyor');
  await cdp.evaluate(`(() => {
    const doc = document.getElementById('mapFrame').contentDocument;
    doc.querySelector('[data-brain-view="notes"]').click();
  })()`);
  await cdp.waitFor(`document.getElementById('mapFrame').contentWindow.__notlarBrainStats?.filter === 'notes' && document.getElementById('mapFrame').contentWindow.__notlarBrainStats?.nodes > 0`);
  await cdp.evaluate(`(() => {
    const doc = document.getElementById('mapFrame').contentDocument;
    doc.querySelector('.segmented [data-mode="clusters"]').click();
  })()`);
  const noteGraphInteraction = await cdp.evaluate(`(() => {
    const frame = document.getElementById('mapFrame');
    const doc = frame.contentDocument;
    return {
      filter: frame.contentWindow.__notlarBrainStats?.filter,
      mode: doc.documentElement.dataset.mode,
      nodes: frame.contentWindow.__notlarBrainStats?.nodes || 0
    };
  })()`);
  if (noteGraphInteraction.filter !== 'notes' || noteGraphInteraction.mode !== 'clusters' || noteGraphInteraction.nodes < 1) {
    throw new Error(`AI Brain note graph failed: ${JSON.stringify(noteGraphInteraction)}`);
  }

  stage('AI Beyni proje recall sorgusu dogrulaniyor');
  const recallStarted = await cdp.evaluate(`(() => {
    const doc = document.getElementById('mapFrame').contentDocument;
    const projectScope = [...doc.querySelectorAll('#scopeList .view-button')]
      .find((button) => button.textContent.includes('Notlar Sync'));
    if (!projectScope) throw new Error('Notlar Sync proje kapsami bulunamadi');
    projectScope.click();
    doc.getElementById('askInput').value = 'mobil gorunumu dogrula';
    doc.getElementById('askForm').requestSubmit();
    return doc.querySelector('#askForm button').disabled;
  })()`);
  if (!recallStarted) throw new Error('AI Brain recall istegi baslamadi');
  await cdp.waitFor(`document.getElementById('mapFrame').contentDocument.querySelector('#askForm button').disabled === false`, recallTimeoutMs);
  await cdp.evaluate(`document.getElementById('mapFrame').contentDocument.getElementById('brainOptionsBtn').click()`);
  const brainInteractions = await cdp.evaluate(`(() => {
    const frame = document.getElementById('mapFrame');
    const doc = frame.contentDocument;
    const resultTitles = [...doc.querySelectorAll('#doneList li')].map((item) => item.textContent.trim());
    return {
      filter: frame.contentWindow.__notlarBrainStats?.filter,
      mode: doc.documentElement.dataset.mode,
      activeScope: doc.querySelector('#scopeList .view-button.active')?.textContent.trim() || '',
      recallType: doc.querySelector('#inspectType span').textContent.trim(),
      recallCount: Number(doc.getElementById('doneCount').textContent),
      recallExpected: resultTitles.some((title) => title.toLocaleLowerCase('tr-TR').includes('mobil gorunumu dogrula')),
      recallExplained: (frame.contentWindow.__notlarBrainRecall?.explained || 0) > 0,
      recallSummary: doc.getElementById('inspectSummary').textContent.slice(0, 240),
      dialogOpen: doc.getElementById('brainDialog').classList.contains('open'),
      tokenBudget: Number(doc.getElementById('brainTokenBudget').value),
      integrationRows: doc.querySelectorAll('#brainIntegrationList .integration-row').length
    };
  })()`);
  if (brainInteractions.filter !== 'active' || brainInteractions.mode !== 'clusters'
    || !brainInteractions.activeScope.includes('Notlar Sync')
    || !/^\d+ ilgili hafıza$/.test(brainInteractions.recallType) || brainInteractions.recallCount < 1 || !brainInteractions.recallExpected
    || !brainInteractions.recallExplained
    || !brainInteractions.dialogOpen || brainInteractions.tokenBudget < 500 || brainInteractions.integrationRows < 1) {
    throw new Error(`AI Brain interactions failed: ${JSON.stringify(brainInteractions)}`);
  }
  await cdp.screenshot('desktop-brain-settings.png');
  await cdp.evaluate(`(() => {
    const doc = document.getElementById('mapFrame').contentDocument;
    doc.getElementById('brainDialog').classList.remove('open');
    doc.querySelector('[data-brain-view="active"]').click();
  })()`);

  stage('AI Beyni fact zaman katmani dogrulaniyor');
  await cdp.evaluate(`document.getElementById('mapFrame').contentDocument.querySelector('[data-brain-view="facts"]').click()`);
  await cdp.waitFor(`document.getElementById('mapFrame').contentWindow.__notlarBrainStats?.filter === 'facts' && document.getElementById('mapFrame').contentWindow.__notlarBrainStats?.nodes > 0`);
  await cdp.evaluate(`(() => {
    const doc = document.getElementById('mapFrame').contentDocument;
    const target = [...doc.querySelectorAll('#viewport .node.tfact')]
      .find((node) => node.querySelector('.node-title').textContent.includes('Vue'));
    if (!target) throw new Error('Vue fact dugumu bulunamadi');
    target.dispatchEvent(new doc.defaultView.MouseEvent('click', { bubbles: true }));
  })()`);
  await cdp.waitFor(`!document.getElementById('mapFrame').contentDocument.getElementById('factWhy').textContent.includes('getiriliyor')`, 8000);
  await cdp.waitFor(`!document.getElementById('mapFrame').contentDocument.getElementById('factEvidenceChain').textContent.includes('getiriliyor')`, 8000);
  const factInspector = await cdp.evaluate(`(() => {
    const doc = document.getElementById('mapFrame').contentDocument;
    return {
      sectionVisible: !doc.getElementById('factSection').hidden,
      chip: doc.getElementById('factStatusChip').textContent,
      validity: doc.getElementById('factValidity').textContent,
      why: doc.getElementById('factWhy').textContent.slice(0, 160),
      assertion: doc.getElementById('factAssertionBadge').textContent,
      evidence: doc.getElementById('factEvidenceBadge').textContent,
      evidenceChain: doc.getElementById('factEvidenceChain').textContent.slice(0, 180),
      chainRows: doc.querySelectorAll('#factChain .relation-item').length,
      progressLabel: doc.getElementById('progressLabel').textContent
    };
  })()`);
  if (!factInspector.sectionVisible || factInspector.chip !== 'güncel' || !factInspector.validity.includes('→')
    || !factInspector.validity.includes('güven') || factInspector.chainRows < 1 || factInspector.progressLabel !== 'Güven'
    || factInspector.assertion !== 'Ajan beyanı' || factInspector.evidence !== 'Doğrudan kanıt'
    || !factInspector.evidenceChain.includes('session:') || !factInspector.why || factInspector.why.includes('alınamadı')) {
    throw new Error(`AI Brain fact inspector failed: ${JSON.stringify(factInspector)}`);
  }
  await cdp.evaluate(`document.getElementById('mapFrame').contentDocument.querySelector('#factChain .relation-item').click()`);
  const supersededInspector = await cdp.evaluate(`(() => {
    const doc = document.getElementById('mapFrame').contentDocument;
    return {
      chip: doc.getElementById('factStatusChip').textContent,
      selected: doc.querySelector('#viewport .node.selected .node-title')?.textContent || ''
    };
  })()`);
  if (supersededInspector.chip !== 'yerine geçti' || !supersededInspector.selected.includes('React')) {
    throw new Error(`AI Brain fact chain failed: ${JSON.stringify(supersededInspector)}`);
  }
  await cdp.evaluate(`document.getElementById('mapFrame').contentDocument.querySelector('.segmented [data-mode="time"]').click()`);
  const factTimeline = await cdp.evaluate(`(() => {
    const frame = document.getElementById('mapFrame');
    return {
      mode: frame.contentDocument.documentElement.dataset.mode,
      nodes: frame.contentWindow.__notlarBrainStats?.nodes || 0,
      filter: frame.contentWindow.__notlarBrainStats?.filter
    };
  })()`);
  if (factTimeline.mode !== 'time' || factTimeline.filter !== 'facts' || factTimeline.nodes < 2) {
    throw new Error(`AI Brain fact timeline failed: ${JSON.stringify(factTimeline)}`);
  }
  stage('AI Beyni evidence, forgotten ve conflict gorunurlugu dogrulaniyor');
  await cdp.evaluate(`(() => {
    const doc = document.getElementById('mapFrame').contentDocument;
    const target = doc.querySelector('[data-id="fact:' + window.__uiConflictFactId + '"]');
    if (!target) throw new Error('conflict fact dugumu bulunamadi');
    target.dispatchEvent(new doc.defaultView.MouseEvent('click', { bubbles: true }));
  })()`);
  const conflictInspector = await cdp.evaluate(`(() => {
    const doc = document.getElementById('mapFrame').contentDocument;
    return {
      visible: !doc.getElementById('factConflictSection').hidden,
      cards: doc.querySelectorAll('#factConflictList .conflict-card').length,
      actions: [...doc.querySelectorAll('#factConflictList .conflict-actions button')].map((button) => button.textContent),
      overflow: doc.documentElement.scrollWidth > doc.documentElement.clientWidth + 1
    };
  })()`);
  if (!conflictInspector.visible || conflictInspector.cards < 1
    || !['Yerine geçir', 'İhtilaflı işaretle', 'Ayrı bilgi olarak tut'].every((label) => conflictInspector.actions.includes(label))
    || conflictInspector.overflow) throw new Error(`AI Brain conflict inspector failed: ${JSON.stringify(conflictInspector)}`);
  await cdp.evaluate(`(() => {
    const doc = document.getElementById('mapFrame').contentDocument;
    const target = doc.querySelector('[data-id="fact:' + window.__uiForgottenFactId + '"]');
    if (!target) throw new Error('forgotten tombstone dugumu bulunamadi');
    target.dispatchEvent(new doc.defaultView.MouseEvent('click', { bubbles: true }));
  })()`);
  const forgottenInspector = await cdp.evaluate(`(() => {
    const doc = document.getElementById('mapFrame').contentDocument;
    return {
      chip: doc.getElementById('factStatusChip').textContent,
      title: doc.getElementById('inspectTitle').textContent,
      summary: doc.getElementById('inspectSummary').textContent,
      leaked: doc.body.textContent.includes(window.__uiForgottenSecret),
      actions: doc.querySelectorAll('#factActions button').length
    };
  })()`);
  if (forgottenInspector.chip !== 'unutuldu' || forgottenInspector.leaked || forgottenInspector.actions !== 0
    || (!forgottenInspector.title.includes('UNUTULDU') && !forgottenInspector.summary.includes('UNUTULDU'))) {
    throw new Error(`AI Brain forgotten inspector failed: ${JSON.stringify(forgottenInspector)}`);
  }
  await cdp.screenshot('desktop-brain-facts.png');
  await cdp.evaluate(`(() => {
    const doc = document.getElementById('mapFrame').contentDocument;
    doc.querySelector('.segmented [data-mode="connections"]').click();
    doc.querySelector('[data-brain-view="active"]').click();
  })()`);

  stage('mobil not duzeni dogrulaniyor');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 1, mobile: true, screenWidth: 390, screenHeight: 844,
  });
  await cdp.evaluate(`showView('notes'); if (!current) openNote(notes[0])`);
  await sleep(300);
  const mobile = await cdp.evaluate(`({
    bottomNav: getComputedStyle(document.getElementById('bottomNav')).display,
    rail: getComputedStyle(document.getElementById('rail')).display,
    horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
    fab: getComputedStyle(document.getElementById('navFab')).display
  })`);
  if (mobile.bottomNav === 'none' || mobile.rail !== 'none' || mobile.horizontalOverflow || mobile.fab === 'none') {
    throw new Error(`Mobile layout failed: ${JSON.stringify(mobile)}`);
  }
  await cdp.screenshot('mobile-note.png');

  stage('mobil AI Beyni dogrulaniyor');
  await cdp.evaluate(`showView('map')`);
  await cdp.waitFor(`document.getElementById('mapFrame').contentWindow?.__notlarBrainStats?.nodes > 0`, 12000);
  await sleep(350);
  const mobileBrain = await cdp.evaluate(`(() => {
    const doc = document.getElementById('mapFrame').contentDocument;
    const inspector = doc.getElementById('inspector');
    return {
      nodes: doc.querySelectorAll('#viewport .node').length,
      overflow: doc.documentElement.scrollWidth > doc.documentElement.clientWidth + 1,
      inspectorClosed: !inspector.classList.contains('open'),
      bottomNavVisible: getComputedStyle(document.getElementById('bottomNav')).display !== 'none'
    };
  })()`);
  if (mobileBrain.nodes < 1 || mobileBrain.overflow || !mobileBrain.inspectorClosed || !mobileBrain.bottomNavVisible) {
    throw new Error(`Mobile AI Brain failed: ${JSON.stringify(mobileBrain)}`);
  }
  await cdp.screenshot('mobile-brain.png');

  stage('mobil AI Beyni kontrolleri dogrulaniyor');
  await cdp.evaluate(`document.getElementById('mapFrame').contentDocument.getElementById('brainMobileMenu').click()`);
  await sleep(240);
  const mobileBrainControls = await cdp.evaluate(`(() => {
    const doc = document.getElementById('mapFrame').contentDocument;
    const sidebar = doc.getElementById('brainSidebar');
    const menu = doc.getElementById('brainMobileMenu');
    return {
      drawerOpen: sidebar.classList.contains('mobile-open'),
      drawerVisible: getComputedStyle(sidebar).visibility === 'visible',
      expanded: menu.getAttribute('aria-expanded'),
      views: doc.querySelectorAll('#viewList .view-button').length,
      scopes: doc.querySelectorAll('#scopeList .view-button').length
    };
  })()`);
  if (!mobileBrainControls.drawerOpen || !mobileBrainControls.drawerVisible || mobileBrainControls.expanded !== 'true'
    || mobileBrainControls.views < 2 || mobileBrainControls.scopes < 2) {
    throw new Error(`Mobile AI Brain controls failed: ${JSON.stringify(mobileBrainControls)}`);
  }
  await cdp.screenshot('mobile-brain-menu.png');
  await cdp.evaluate(`document.getElementById('mapFrame').contentDocument.getElementById('brainSidebarMenu').click()`);
  await cdp.waitFor(`document.getElementById('mapFrame').contentDocument.getElementById('brainDialog')?.classList.contains('open')`);
  await cdp.evaluate(`document.getElementById('mapFrame').contentDocument.querySelector('#brainDialog .brain-dialog-head button').click()`);

  stage('mobil rotalar dogrulaniyor');
  const mobileViews = ['overview', 'vault', 'tools', 'ai', 'konsey', 'avci', 'document', 'runtime', 'sync', 'settings'];
  for (const view of mobileViews) {
    await cdp.evaluate(`showView(${JSON.stringify(view)})`);
    await sleep(160);
    const state = await cdp.evaluate(`(() => {
      const ids = { overview:'overviewView', vault:'vault', tools:'tools', ai:'ai', konsey:'konsey', avci:'avci', document:'documentView', runtime:'runtimeView', sync:'settings', settings:'appSettings' };
      const element = document.getElementById(ids[${JSON.stringify(view)}]);
      return { view: document.body.dataset.view, overflow: element.scrollWidth > element.clientWidth + 1 };
    })()`);
    if (state.view !== view || state.overflow) throw new Error(`Mobile route failed: ${view} ${JSON.stringify(state)}`);
    if (view === 'overview') await cdp.screenshot('mobile-overview.png');
    if (view === 'vault') await cdp.screenshot('mobile-vault.png');
    if (view === 'runtime') await cdp.screenshot('mobile-runtime.png');
  }

  stage('Electron kurulum izolasyonu dogrulaniyor');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 620, height: 680, deviceScaleFactor: 1, mobile: false,
  });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    Object.defineProperty(window, 'setupApi', { value: {
      platform: 'linux',
      status: async () => ({ state: 'Running', ip: '100.64.0.10' }),
      patchConfig: async () => true,
      done: () => {},
      pairClaim: async () => ({ claimId: 'test' }),
      pairApprove: async () => ({}),
      pairStatus: async () => ({ durum: 'bekliyor' }),
      peerConnect: async () => ({ status: 'approval-required' }),
      peerStatus: async () => ({ peers: [] }),
      openUrl: async () => true,
      installTailscale: async () => ({ ok: true }),
      tailscaleUp: async () => ({ started: true }),
      onLoginUrl: () => {}
    }, configurable: true });
  ` });
  await cdp.send('Page.navigate', { url: new URL('/setup.html?mode=host&port=7788', appUrl).href });
  await cdp.waitFor(`document.readyState === 'complete' && document.getElementById('durum').textContent.includes('Bagli')`);
  const setup = await cdp.evaluate(`({
    nodeHidden: typeof require === 'undefined',
    apiPresent: typeof setupApi === 'object',
    continueVisible: getComputedStyle(document.getElementById('ana')).display !== 'none',
    horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
    verticalOverflow: document.documentElement.scrollHeight > innerHeight + 1
  })`);
  if (!setup.nodeHidden || !setup.apiPresent || !setup.continueVisible || setup.horizontalOverflow) {
    throw new Error(`Setup isolation failed: ${JSON.stringify(setup)}`);
  }
  await cdp.screenshot('desktop-setup.png');

  const runtimeErrors = cdp.events.filter((event) => event.method === 'Runtime.exceptionThrown');
  if (runtimeErrors.length) {
    const details = runtimeErrors.map((event) => event.params.exceptionDetails.exception?.description || event.params.exceptionDetails.text);
    throw new Error(`Runtime exceptions: ${details.join(' | ')}`);
  }

  stage('tum UI kontrolleri tamamlandi');
  console.log(JSON.stringify({ ok: true, runId, overview, noteState, mapState, noteGraphInteraction, brainInteractions, mobile, mobileBrain, mobileBrainControls, setup, outDir }, null, 2));
  } finally {
    cdp?.close(new Error(`UI smoke kapatildi: ${currentStage}`));
    cdp = null;
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
}).finally(() => {
  stopWatchdog();
  if (serverChild && serverChild.exitCode === null) serverChild.kill('SIGTERM');
  releaseRunLock();
});
