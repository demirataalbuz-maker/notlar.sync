'use strict';

(() => {
  const svgNs = 'http://www.w3.org/2000/svg';
  const brainState = {
    key: localStorage.getItem('key') || '',
    role: 'device',
    filter: 'active',
    scope: 'all',
    mode: 'connections',
    selectedId: '',
    scale: 1,
    memoryGraph: { nodes: [], edges: [], projects: [], stats: {} },
    overview: { sessions: [], checkpoints: [], memories: [], stats: {}, settings: {} },
    noteGraph: { nodes: [], edges: [], communities: [] },
    integrations: null,
    runtime: null,
    visibleNodes: [],
    visibleEdges: [],
    positions: new Map(),
    loadVersion: 0,
    presented: false,
    userOpenedInspector: false,
    sessionLoaded: false,
    integrationLoading: false,
    socketRetry: 0,
    socketRetryTimer: null,
    dataRetryTimer: null,
    live: false,
    ws: null,
    recallWhy: new Map(),
  };

  const typeMeta = {
    project: { label: 'Proje', color: 'var(--coral)', icon: 'M-12-8h9l4 4h11v16h-24z' },
    'project-memory': { label: 'Proje bilgisi', color: 'var(--coral)', icon: 'M-8-9h11l5 5v13H-8zM3-9v5h5M-4 2h8' },
    global: { label: 'Kalıcı kapsam', color: 'var(--violet)', icon: 'M-4-10a8 8 0 0 0-6 13 8 8 0 0 0 7 4v7M4-10a8 8 0 0 1 6 13 8 8 0 0 1-7 4v7M0-10v24' },
    session: { label: 'AI oturumu', color: 'var(--blue)', icon: 'M-9-7h18v14H-9zM-4 11h8M0 7v4M-4-1h.1M4-1h.1' },
    checkpoint: { label: 'Checkpoint', color: 'var(--green)', icon: 'M-8-6h16v12H-8zM-3 10h6M0 6v4' },
    decision: { label: 'Karar', color: 'var(--amber)', icon: 'M-8 0-3 5 8-7' },
    task: { label: 'Görev', color: 'var(--coral)', icon: 'M-8-6h16M-8 0h16M-8 6h10' },
    preference: { label: 'Tercih', color: 'var(--violet)', icon: 'M0-10-2 6-6 2 6 2 2 6 2-6 6-2-6-2z' },
    fact: { label: 'Bilgi', color: 'var(--cyan)', icon: 'M-8-9h11l5 5v13H-8zM3-9v5h5M-4 2h8' },
    tfact: { label: 'Fact', color: 'var(--green)', icon: 'M0-9a9 9 0 1 0 .01 0M0-5v5l4 3' },
    reference: { label: 'Kaynak', color: 'var(--blue)', icon: 'M-8-8h16v16H-8zM-4-3h8M-4 1h8M-4 5h5' },
    person: { label: 'Kişi', color: 'var(--amber)', icon: 'M0-9a4 4 0 1 0 0 8 4 4 0 0 0 0-8M-8 9c1-5 4-7 8-7s7 2 8 7' },
    note: { label: 'Not', color: 'var(--blue)', icon: 'M-8-10h10l6 6v14H-8zM2-10v6h6M-4 2h8' },
  };

  const kindLabels = {
    active: 'Aktif bağlam', all: 'Tüm hafıza', projects: 'Projeler', sessions: 'Oturumlar',
    decisions: 'Kararlar', tasks: 'Açık görevler', facts: 'Fact zaman akışı', notes: 'Not grafı',
  };

  const factStatusMeta = {
    active: { label: 'güncel', color: 'var(--green)' },
    superseded: { label: 'yerine geçti', color: 'var(--amber)' },
    invalidated: { label: 'geçersiz kılındı', color: 'var(--coral)' },
    disputed: { label: 'ihtilaflı', color: 'var(--coral)' },
    forgotten: { label: 'unutuldu', color: 'var(--dim)' },
  };
  const assertionLabels = { user: 'Kullanıcı beyanı', agent: 'Ajan beyanı', imported: 'İçe aktarıldı', inferred: 'Çıkarım', system: 'Sistem' };
  const evidenceLabels = { direct: 'Doğrudan kanıt', derived: 'Türetilmiş kanıt', unverified: 'Doğrulanmadı' };

  const q = (selector, root = document) => root.querySelector(selector);
  const qa = (selector, root = document) => [...root.querySelectorAll(selector)];
  const byId = (id) => document.getElementById(id);

  function svgElement(name, attrs = {}) {
    const element = document.createElementNS(svgNs, name);
    for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
    return element;
  }

  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  function idTail(id) { return String(id || '').split(':').slice(1).join(':'); }
  function cleanText(value, fallback = '') { return String(value == null ? fallback : value).trim(); }
  function shortText(value, max = 28) {
    const text = cleanText(value).replace(/\s+/g, ' ');
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }
  function hashNumber(value) {
    let hash = 2166136261;
    for (const char of String(value)) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
    return hash >>> 0;
  }
  function formatTime(value) {
    const time = Date.parse(value || '');
    if (!time) return 'Zaman bilgisi yok';
    const delta = Date.now() - time;
    const minutes = Math.max(0, Math.floor(delta / 60000));
    if (minutes < 1) return 'Şimdi';
    if (minutes < 60) return `${minutes} dk önce`;
    if (minutes < 1440) return `${Math.floor(minutes / 60)} sa önce`;
    if (minutes < 10080) return `${Math.floor(minutes / 1440)} gün önce`;
    return new Date(time).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  async function brainFetch(url, options = {}) {
    const headers = new Headers(options.headers || {});
    if (brainState.key) headers.set('X-Api-Key', brainState.key);
    const response = await fetch(url, { ...options, headers, credentials: 'same-origin' });
    if (!response.ok) throw new Error((await response.text()).slice(0, 240) || `HTTP ${response.status}`);
    const contentType = response.headers.get('content-type') || '';
    return contentType.includes('json') ? response.json() : response.text();
  }

  function jsonOptions(method, body) {
    return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) };
  }

  function replaceInteractive(element) {
    if (!element) return null;
    const clone = element.cloneNode(true);
    element.replaceWith(clone);
    return clone;
  }

  function setupCleanControls() {
    const viewList = byId('viewList');
    const scopeList = byId('scopeList');
    if (viewList) viewList.replaceChildren();
    if (scopeList) scopeList.replaceChildren();
    const segmented = q('.segmented');
    if (segmented) segmented.replaceChildren();
    ['zoomIn', 'zoomOut', 'fitBtn', 'focusBtn', 'closeInspector', 'sourceBtn'].forEach((id) => replaceInteractive(byId(id)));
    const askForm = replaceInteractive(byId('askForm'));
    const stageButtons = qa('.stage-actions .icon-btn');
    if (stageButtons[2]) {
      const options = replaceInteractive(stageButtons[2]);
      options.id = 'brainOptionsBtn';
      options.title = 'AI Beyni ayarları';
      options.setAttribute('aria-label', 'AI Beyni ayarları');
    }
    const sidebarMenu = replaceInteractive(q('.sidebar-head .icon-btn'));
    if (sidebarMenu) sidebarMenu.id = 'brainSidebarMenu';
    return askForm;
  }

  function makeIcon(id, className = 'icon icon-sm') {
    const svg = svgElement('svg', { class: className });
    const use = svgElement('use', { href: `#${id}` });
    svg.appendChild(use);
    return svg;
  }

  function activeSessionIds() {
    const sessions = brainState.overview.sessions || [];
    const active = sessions.filter((session) => session.status === 'active').slice(0, 6);
    const selected = active.length ? active : sessions.slice(0, 1);
    return new Set(selected.map((session) => session.id));
  }

  function renderViewButtons() {
    const activeSessions = activeSessionIds();
    const seenCheckpointSessions = new Set();
    const activeCheckpointCount = (brainState.overview.checkpoints || []).filter((checkpoint) => {
      if (!activeSessions.has(checkpoint.sessionId)) return false;
      if (seenCheckpointSessions.has(checkpoint.sessionId)) return false;
      seenCheckpointSessions.add(checkpoint.sessionId);
      return true;
    }).length;
    const activeMemoryCount = brainState.memoryGraph.nodes.filter((node) =>
      !['session', 'checkpoint'].includes(node.type)
      && (['project', 'project-memory', 'global', 'decision', 'task', 'preference', 'fact'].includes(node.type)
        || (node.type === 'tfact' && node.factStatus === 'active'))).length;
    const counts = {
      active: activeMemoryCount + activeSessions.size + activeCheckpointCount,
      all: brainState.memoryGraph.nodes.length,
      projects: brainState.memoryGraph.nodes.filter((node) => ['project', 'global'].includes(node.type)).length,
      sessions: brainState.overview.stats?.sessions || 0,
      decisions: brainState.overview.stats?.decisions || 0,
      tasks: brainState.overview.stats?.openTasks || 0,
      facts: brainState.memoryGraph.nodes.filter((node) => node.type === 'tfact' && node.factStatus !== 'forgotten').length,
      notes: brainState.noteGraph.nodes?.filter((node) => !node.ghost).length || 0,
    };
    const definitions = [
      ['active', 'i-brain'], ['all', 'i-map'], ['projects', 'i-folder'], ['sessions', 'i-clock'],
      ['decisions', 'i-check'], ['tasks', 'i-list'], ['facts', 'i-spark'], ['notes', 'i-note'],
    ];
    const list = byId('viewList');
    list.replaceChildren(...definitions.map(([id, icon]) => {
      const button = document.createElement('button');
      button.className = `view-button${brainState.filter === id ? ' active' : ''}`;
      button.dataset.brainView = id;
      button.append(makeIcon(icon), document.createTextNode(kindLabels[id]));
      const count = document.createElement('span'); count.className = 'count'; count.textContent = counts[id] || 0;
      button.appendChild(count);
      button.onclick = () => {
        brainState.filter = id;
        if (id === 'notes') brainState.scope = 'notes';
        else if (brainState.scope === 'notes') brainState.scope = 'all';
        renderSidebars();
        renderGraph();
        setMobileSidebar(false);
      };
      return button;
    }));
  }

  function renderScopeButtons() {
    const list = byId('scopeList');
    const projects = brainState.memoryGraph.projects || [];
    const allCount = brainState.memoryGraph.nodes.length + (brainState.noteGraph.nodes?.length || 0);
    const scopes = [
      { id: 'all', name: 'Tüm beyin', count: allCount, color: 'green' },
      ...projects.map((project, index) => ({
        id: project.id, name: project.name,
        count: brainState.memoryGraph.nodes.filter((node) => node.projectId === project.id || node.id === project.id).length,
        color: ['coral', 'blue', 'amber', 'green'][index % 4],
      })),
      { id: 'notes', name: 'Not arşivi', count: brainState.noteGraph.nodes?.filter((node) => !node.ghost).length || 0, color: 'blue' },
    ];
    list.replaceChildren(...scopes.map((scope) => {
      const button = document.createElement('button');
      button.className = `view-button${brainState.scope === scope.id ? ' active' : ''}`;
      const dot = document.createElement('span'); dot.className = `scope-dot ${scope.color}`;
      const count = document.createElement('span'); count.className = 'count'; count.textContent = scope.count;
      button.append(dot, document.createTextNode(scope.name), count);
      button.onclick = () => {
        brainState.scope = scope.id;
        if (scope.id === 'notes') brainState.filter = 'notes';
        else if (brainState.filter === 'notes') brainState.filter = 'active';
        renderSidebars();
        renderGraph();
        setMobileSidebar(false);
      };
      return button;
    }));
  }

  function renderHealth() {
    const health = Number(brainState.overview.stats?.health ?? 100);
    const healthBox = q('.memory-health');
    if (!healthBox) return;
    q('.health-row span', healthBox).textContent = `%${health}`;
    q('.health-track i', healthBox).style.width = `${clamp(health, 0, 100)}%`;
    const providers = brainState.integrations?.providers || [];
    const ready = providers.filter((provider) => provider.installed && provider.hooksConfigured && provider.mcpConfigured).length;
    const disconnected = Math.max(0, (brainState.overview.stats?.memories || 0) - (brainState.overview.stats?.decisions || 0) - (brainState.overview.stats?.openTasks || 0));
    q('.health-meta', healthBox).textContent = providers.length
      ? `${ready}/${providers.length} AI bağlı · ${brainState.overview.stats?.checkpoints || 0} checkpoint`
      : `${brainState.overview.stats?.checkpoints || 0} checkpoint · ${Math.max(0, disconnected)} kalıcı bilgi`;
  }

  function renderSidebars() {
    renderViewButtons();
    renderScopeButtons();
    renderHealth();
    byId('pageTitle').textContent = `Beyin / ${kindLabels[brainState.filter] || 'Aktif bağlam'}`;
    const subtitle = q('.page-title span');
    if (subtitle) subtitle.textContent = brainState.filter === 'notes'
      ? 'Markdown notları ve gerçek bağlantıları'
      : 'Oturumlar, kararlar ve son checkpointler';
  }

  function normalizedMemoryNodes() {
    return (brainState.memoryGraph.nodes || []).map((node) => ({
      ...node,
      group: node.global || !node.projectId || node.type === 'global' ? 'global' : node.projectId,
      radius: nodeRadius(node),
    }));
  }

  function normalizedNoteNodes() {
    return (brainState.noteGraph.nodes || []).map((node) => ({
      ...node,
      id: `note:${node.id}`,
      rawId: node.id,
      type: 'note',
      description: node.description || (node.ghost ? 'Bağlantısı var; not dosyası bulunamadı.' : 'Markdown notu'),
      projectId: 'notes',
      group: `community:${node.community ?? 'none'}`,
      updatedAt: null,
      radius: nodeRadius({ ...node, type: 'note' }),
    }));
  }

  function normalizedNoteEdges() {
    return (brainState.noteGraph.edges || []).map((edge) => ({
      ...edge, source: `note:${edge.source}`, target: `note:${edge.target}`, relation: edge.relation || 'not bağlantısı',
    }));
  }

  function nodeRadius(node) {
    if (node.type === 'project') return 38;
    if (node.type === 'global') return 31;
    if (node.type === 'checkpoint') return 26;
    if (node.type === 'session') return 23;
    if (node.type === 'tfact') return node.factStatus === 'active' ? 22 : 18;
    if (node.type === 'note') return clamp(17 + Math.sqrt(Number(node.degree || 0)) * 2.4, 17, 29);
    return node.pinned ? 24 : 20;
  }

  function filteredData() {
    let nodeList;
    let edgeList;
    if (brainState.filter === 'notes' || brainState.scope === 'notes') {
      nodeList = normalizedNoteNodes().sort((a, b) => Number(b.degree || 0) - Number(a.degree || 0)).slice(0, 140);
      edgeList = normalizedNoteEdges();
    } else {
      nodeList = normalizedMemoryNodes();
      edgeList = (brainState.memoryGraph.edges || []).map((edge) => ({ ...edge }));
      const allowedTypes = {
        active: new Set(['project', 'project-memory', 'global', 'session', 'checkpoint', 'decision', 'task', 'preference', 'fact', 'tfact']),
        projects: new Set(['project', 'global']),
        sessions: new Set(['project', 'global', 'session', 'checkpoint']),
        decisions: new Set(['project', 'global', 'decision']),
        tasks: new Set(['project', 'global', 'task']),
        facts: new Set(['project', 'global', 'tfact']),
      }[brainState.filter];
      if (allowedTypes) nodeList = nodeList.filter((node) => allowedTypes.has(node.type));
      // Fact görünümü zaman akışı içindir: anonim unutulmuş tombstone dahil
      // tüm versiyonlar görünür; diğer görünümler yalnız güncel fact gösterir.
      if (brainState.filter === 'facts') nodeList = nodeList.filter((node) => node.type !== 'tfact' || !!node.factStatus);
      else if (brainState.filter === 'active') nodeList = nodeList.filter((node) => node.type !== 'tfact' || node.factStatus === 'active');
      else nodeList = nodeList.filter((node) => node.type !== 'tfact' || ['active', 'disputed'].includes(node.factStatus));
      if (brainState.filter === 'active') {
        const visibleSessions = activeSessionIds();
        const seenSessions = new Set();
        const latestBySession = new Set();
        for (const checkpoint of brainState.overview.checkpoints || []) {
          if (!visibleSessions.has(checkpoint.sessionId)) continue;
          if (seenSessions.has(checkpoint.sessionId)) continue;
          seenSessions.add(checkpoint.sessionId);
          latestBySession.add(checkpoint.id);
        }
        nodeList = nodeList.filter((node) =>
          (node.type !== 'session' || visibleSessions.has(idTail(node.id)))
          && (node.type !== 'checkpoint' || latestBySession.has(idTail(node.id))));
      }
      if (brainState.filter === 'tasks') nodeList = nodeList.filter((node) => node.type !== 'task' || node.status === 'open');
      if (brainState.scope !== 'all') nodeList = nodeList.filter((node) =>
        node.id === brainState.scope || node.type === 'global' || node.global || !node.projectId || node.projectId === brainState.scope);
      nodeList.sort((a, b) => {
        const priority = { project: 7, global: 7, checkpoint: 6, session: 5, task: 4, decision: 3, 'project-memory': 3, tfact: 3, preference: 2, fact: 1 };
        return (priority[b.type] || 0) - (priority[a.type] || 0)
          || Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0);
      });
      nodeList = nodeList.slice(0, 120);
    }
    const ids = new Set(nodeList.map((node) => node.id));
    edgeList = edgeList.filter((edge) => ids.has(edge.source) && ids.has(edge.target));
    return { nodes: nodeList, edges: edgeList };
  }

  function groupCenters(nodeList) {
    const groups = [...new Set(nodeList.map((node) => brainState.mode === 'clusters' ? node.type : node.group))];
    const columns = Math.max(1, Math.ceil(Math.sqrt(groups.length * 1.5)));
    const rows = Math.max(1, Math.ceil(groups.length / columns));
    const centers = new Map();
    groups.forEach((group, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      centers.set(group, {
        x: columns === 1 ? 600 : 170 + column * (860 / (columns - 1)),
        y: rows === 1 ? 375 : 170 + row * (410 / (rows - 1)),
      });
    });
    return centers;
  }

  function layoutGraph(nodeList, edgeList) {
    const positions = new Map();
    if (!nodeList.length) return positions;
    if (brainState.mode === 'time') {
      const ordered = [...nodeList].sort((a, b) => Date.parse(a.updatedAt || a.createdAt || 0) - Date.parse(b.updatedAt || b.createdAt || 0));
      ordered.forEach((node, index) => {
        const x = 100 + index * (1000 / Math.max(1, ordered.length - 1));
        const lane = ['project', 'global'].includes(node.type) ? 0 : node.type === 'session' ? 1 : node.type === 'checkpoint' ? 2 : 3;
        positions.set(node.id, { x, y: 150 + lane * 145, vx: 0, vy: 0, radius: node.radius });
      });
      return positions;
    }

    const centers = groupCenters(nodeList);
    for (const node of nodeList) {
      const group = brainState.mode === 'clusters' ? node.type : node.group;
      const center = centers.get(group) || { x: 600, y: 375 };
      const hash = hashNumber(node.id);
      const angle = ((hash % 10000) / 10000) * Math.PI * 2;
      const spread = ['project', 'global'].includes(node.type) ? 0 : 78 + ((hash >>> 8) % 130);
      positions.set(node.id, {
        x: center.x + Math.cos(angle) * spread,
        y: center.y + Math.sin(angle) * spread,
        vx: 0, vy: 0, radius: node.radius,
        fixed: ['project', 'global'].includes(node.type),
        center,
      });
    }
    const edgePairs = edgeList.map((edge) => [positions.get(edge.source), positions.get(edge.target)]).filter(([a, b]) => a && b);
    for (let iteration = 0; iteration < 130; iteration++) {
      for (let index = 0; index < nodeList.length; index++) {
        const a = positions.get(nodeList[index].id);
        for (let other = index + 1; other < nodeList.length; other++) {
          const b = positions.get(nodeList[other].id);
          let dx = b.x - a.x, dy = b.y - a.y;
          let distance = Math.sqrt(dx * dx + dy * dy) || 0.1;
          const wanted = a.radius + b.radius + (nodeList.length > 70 ? 18 : 32);
          if (distance >= wanted) continue;
          const force = (wanted - distance) * 0.04;
          dx /= distance; dy /= distance;
          if (!a.fixed) { a.vx -= dx * force; a.vy -= dy * force; }
          if (!b.fixed) { b.vx += dx * force; b.vy += dy * force; }
        }
      }
      for (const [a, b] of edgePairs) {
        let dx = b.x - a.x, dy = b.y - a.y;
        const distance = Math.sqrt(dx * dx + dy * dy) || 1;
        const desired = nodeList.length <= 12 ? 168 : 120;
        const force = (distance - desired) * 0.008;
        dx /= distance; dy /= distance;
        if (!a.fixed) { a.vx += dx * force; a.vy += dy * force; }
        if (!b.fixed) { b.vx -= dx * force; b.vy -= dy * force; }
      }
      for (const node of nodeList) {
        const point = positions.get(node.id);
        if (point.fixed) continue;
        point.vx += (point.center.x - point.x) * 0.0017;
        point.vy += (point.center.y - point.y) * 0.0017;
        point.vx *= 0.78; point.vy *= 0.78;
        point.x = clamp(point.x + point.vx, 66, 1134);
        point.y = clamp(point.y + point.vy, 74, 680);
      }
    }
    return positions;
  }

  function fitBrainViewBox(nodeList, positions) {
    const graph = byId('graph');
    const stage = q('.stage');
    if (!nodeList.length || !stage.clientWidth || !stage.clientHeight) {
      graph.setAttribute('viewBox', '0 0 1200 760');
      return;
    }
    const left = Math.min(...nodeList.map((node) => positions.get(node.id).x - node.radius)) - 80;
    const right = Math.max(...nodeList.map((node) => positions.get(node.id).x + node.radius)) + 80;
    const top = Math.min(...nodeList.map((node) => positions.get(node.id).y - node.radius)) - 80;
    const bottom = Math.max(...nodeList.map((node) => positions.get(node.id).y + node.radius)) + 92;
    const centerX = (left + right) / 2, centerY = (top + bottom) / 2;
    const compact = window.matchMedia('(max-width: 780px)').matches;
    let width = Math.max(compact ? 420 : 620, right - left);
    let height = Math.max(compact ? 400 : 500, bottom - top);
    const aspect = stage.clientWidth / stage.clientHeight;
    if (width / height > aspect) height = width / aspect;
    else width = height * aspect;
    graph.setAttribute('viewBox', `${(centerX - width / 2).toFixed(1)} ${(centerY - height / 2).toFixed(1)} ${width.toFixed(1)} ${height.toFixed(1)}`);
  }

  function clusterBounds(nodeList, positions) {
    const groups = new Map();
    for (const node of nodeList) {
      const group = brainState.mode === 'clusters' ? node.type : node.group;
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push({ node, point: positions.get(node.id) });
    }
    return [...groups.entries()].map(([id, items]) => {
      const xs = items.map((item) => item.point.x), ys = items.map((item) => item.point.y);
      const project = brainState.memoryGraph.projects?.find((item) => item.id === id);
      const communityId = String(id).startsWith('community:') ? Number(String(id).split(':')[1]) : null;
      const community = brainState.noteGraph.communities?.find((item) => item.id === communityId);
      return {
        id,
        label: project?.name || community?.name || typeMeta[id]?.label || (id === 'global' ? 'Kalıcı kapsam' : kindLabels[brainState.filter]),
        x: Math.max(24, Math.min(...xs) - 52), y: Math.max(32, Math.min(...ys) - 52),
        width: Math.min(1152, Math.max(...xs) + 52) - Math.max(24, Math.min(...xs) - 52),
        height: Math.min(714, Math.max(...ys) + 52) - Math.max(32, Math.min(...ys) - 52),
      };
    });
  }

  function renderGraph() {
    const data = filteredData();
    brainState.visibleNodes = data.nodes;
    brainState.visibleEdges = data.edges;
    brainState.positions = layoutGraph(data.nodes, data.edges);
    fitBrainViewBox(data.nodes, brainState.positions);
    if (!data.nodes.some((node) => node.id === brainState.selectedId)) {
      const firstCheckpoint = data.nodes.find((node) => node.type === 'checkpoint');
      brainState.selectedId = (firstCheckpoint || data.nodes.find((node) => node.type === 'project') || data.nodes[0] || {}).id || '';
    }
    const viewport = byId('viewport');
    viewport.replaceChildren();

    for (const cluster of clusterBounds(data.nodes, brainState.positions)) {
      const rect = svgElement('rect', { class: 'cluster-hull', x: cluster.x, y: cluster.y, width: Math.max(80, cluster.width), height: Math.max(80, cluster.height), rx: 26 });
      const label = svgElement('text', { class: 'cluster-label', x: cluster.x + 14, y: cluster.y + 21 });
      label.textContent = shortText(cluster.label || 'Küme', 34).toLocaleUpperCase('tr-TR');
      viewport.append(rect, label);
    }

    const edgeLayer = svgElement('g', { id: 'brainEdges' });
    for (const edge of data.edges) {
      const source = brainState.positions.get(edge.source), target = brainState.positions.get(edge.target);
      if (!source || !target) continue;
      const bend = (hashNumber(`${edge.source}|${edge.target}`) % 41) - 20;
      const mx = (source.x + target.x) / 2 + bend;
      const my = (source.y + target.y) / 2 - bend;
      const path = svgElement('path', {
        class: `relation${edge.relation === 'checkpoint' ? ' strong' : edge.relation === 'preference' ? ' memory' : ''}`,
        d: `M${source.x.toFixed(1)} ${source.y.toFixed(1)} Q${mx.toFixed(1)} ${my.toFixed(1)} ${target.x.toFixed(1)} ${target.y.toFixed(1)}`,
        'data-from': edge.source, 'data-to': edge.target,
      });
      edgeLayer.appendChild(path);
    }
    viewport.appendChild(edgeLayer);

    const latestCheckpoint = brainState.overview.checkpoints?.[0]?.id;
    for (const node of data.nodes) {
      const point = brainState.positions.get(node.id);
      const meta = typeMeta[node.type] || typeMeta.fact;
      const group = svgElement('g', {
        class: `node ${node.type}${brainState.selectedId === node.id ? ' selected' : ''}${node.type === 'checkpoint' && idTail(node.id) === latestCheckpoint ? ' checkpoint' : ''}`,
        'data-id': node.id,
        tabindex: 0,
        role: 'button',
        'aria-label': `${node.label || meta.label}, ${meta.label}`,
        transform: `translate(${point.x.toFixed(1)} ${point.y.toFixed(1)})`,
      });
      if (node.type === 'checkpoint' && idTail(node.id) === latestCheckpoint) group.appendChild(svgElement('circle', { class: 'pulse', r: node.radius + 9 }));
      group.append(svgElement('circle', { class: 'halo', r: node.radius + 7 }));
      group.append(svgElement('circle', { class: 'core', r: node.radius, fill: meta.color }));
      group.append(svgElement('path', { class: 'node-icon', d: meta.icon, transform: `scale(${clamp(node.radius / 24, .75, 1.15)})` }));
      const title = svgElement('text', { class: 'node-title', y: node.radius + 20 });
      const displayLabel = node.type === 'session'
        ? `${cleanText(node.agent, 'AI').replace(/^./u, (letter) => letter.toLocaleUpperCase('tr-TR'))} oturumu`
        : node.label;
      title.textContent = shortText(displayLabel, data.nodes.length > 70 ? 19 : 24);
      const sub = svgElement('text', { class: 'node-sub', y: node.radius + 34 });
      sub.textContent = node.type === 'note' ? `${Number(node.degree || 0)} bağ`
        : node.type === 'session' ? (node.status === 'active' ? 'canlı' : node.status || meta.label)
          : node.type === 'tfact' ? (node.factStatus === 'forgotten'
            ? 'anonim kayıt · unutuldu'
            : `${(factStatusMeta[node.factStatus] || factStatusMeta.active).label} · ${evidenceLabels[node.evidenceLevel] || 'kanıt bilinmiyor'}`) : meta.label;
      group.append(title, sub);
      group.onclick = () => selectBrainNode(node.id);
      group.onkeydown = (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectBrainNode(node.id); }
      };
      viewport.appendChild(group);
    }

    updateLiveStatus(brainState.live, data.nodes.length, data.edges.length);
    window.__notlarBrainStats = { nodes: data.nodes.length, edges: data.edges.length, filter: brainState.filter };
    window.__notlarGraphStats = window.__notlarBrainStats;
    applySearch();

    if (brainState.selectedId) renderInspector(brainState.selectedId);
    else renderEmptyInspector();
  }

  function memoryRecordFor(node) {
    const id = idTail(node.id);
    if (node.type === 'session') return brainState.overview.sessions?.find((item) => item.id === id);
    if (node.type === 'checkpoint') return brainState.overview.checkpoints?.find((item) => item.id === id);
    if (node.type === 'tfact') return brainState.overview.facts?.find((item) => item.id === id);
    if (!['project', 'global', 'note'].includes(node.type)) return brainState.overview.memories?.find((item) => item.id === id);
    if (node.type === 'project') return brainState.memoryGraph.projects?.find((item) => item.id === node.id);
    return node;
  }

  function relatedNodes(id) {
    const related = [];
    for (const edge of brainState.visibleEdges) {
      const otherId = edge.source === id ? edge.target : edge.target === id ? edge.source : '';
      if (!otherId) continue;
      const node = brainState.visibleNodes.find((item) => item.id === otherId);
      if (node) related.push({ node, relation: edge.relation || 'bağlantı' });
    }
    return related.slice(0, 8);
  }

  function listItems(element, items, emptyText) {
    element.replaceChildren();
    const values = (items || []).filter(Boolean).slice(0, 8);
    if (!values.length) {
      const item = document.createElement('li'); item.textContent = emptyText; element.appendChild(item); return;
    }
    for (const value of values) { const item = document.createElement('li'); item.textContent = value; element.appendChild(item); }
  }

  function setRelations(items) {
    const container = byId('relationList');
    container.replaceChildren();
    for (const { node, relation } of items) {
      const row = document.createElement('button');
      row.type = 'button'; row.className = 'relation-item';
      row.style.cssText = 'width:100%;border:0;background:transparent;text-align:left;cursor:pointer;padding:0';
      const swatch = document.createElement('span'); swatch.className = 'swatch'; swatch.style.background = (typeMeta[node.type] || typeMeta.fact).color;
      const info = document.createElement('div');
      const strong = document.createElement('strong'); strong.textContent = node.label;
      const detail = document.createElement('span'); detail.textContent = relation;
      info.append(strong, detail); row.append(swatch, info, makeIcon('i-arrow', 'icon'));
      row.onclick = () => selectBrainNode(node.id);
      container.appendChild(row);
    }
    byId('relationCount').textContent = items.length;
  }

  function renderSource(agent, identifier) {
    const sourceLine = q('.source-line');
    sourceLine.replaceChildren();
    const avatar = document.createElement('span'); avatar.className = 'agent-avatar';
    avatar.textContent = cleanText(agent || 'NS').slice(0, 2).toLocaleUpperCase('tr-TR');
    const info = document.createElement('div');
    const strong = document.createElement('strong'); strong.textContent = agent ? `${agent} kaydı` : 'Notlar Sync';
    const br = document.createElement('br');
    const id = document.createElement('span'); id.className = 'mono'; id.textContent = shortText(identifier, 52);
    info.append(strong, br, id); sourceLine.append(avatar, info);
  }

  function inspectorProgress(node, record) {
    if (node.type === 'checkpoint') {
      const done = record?.completed?.length || 0, open = record?.openTasks?.length || 0;
      return { value: done + open ? Math.round(done / (done + open) * 100) : 100, text: `${done} / ${done + open}`, label: 'Oturum ilerlemesi' };
    }
    if (node.type === 'session') {
      const value = record?.status === 'ended' ? 100 : record?.status === 'interrupted' ? 58 : 72;
      return { value, text: record?.status === 'active' ? 'canlı' : record?.status || 'kayıt', label: 'Oturum durumu' };
    }
    if (node.type === 'project') {
      const health = Number(brainState.overview.stats?.health ?? 100);
      return { value: health, text: `%${health}`, label: 'Hafıza sağlığı' };
    }
    if (node.type === 'note') return { value: clamp(35 + Number(node.degree || 0) * 8, 35, 100), text: `${node.degree || 0} bağ`, label: 'Graf bağlantısı' };
    if (node.type === 'tfact') {
      const confidence = clamp(Math.round(Number(node.confidence ?? record?.confidence ?? 0.7) * 100), 0, 100);
      return { value: confidence, text: (factStatusMeta[node.factStatus] || factStatusMeta.active).label, label: 'Güven' };
    }
    return { value: record?.status === 'done' ? 100 : record?.pinned ? 90 : 76, text: record?.status || 'aktif', label: 'Hafıza durumu' };
  }

  function renderInspector(id) {
    const node = brainState.visibleNodes.find((item) => item.id === id);
    if (!node) return renderEmptyInspector();
    const record = memoryRecordFor(node) || node;
    const meta = typeMeta[node.type] || typeMeta.fact;
    const relations = relatedNodes(id);
    const latestForSession = node.type === 'session'
      ? brainState.overview.checkpoints?.find((item) => item.sessionId === idTail(node.id)) : null;
    const completed = node.type === 'checkpoint' ? record.completed
      : node.type === 'session' ? latestForSession?.completed
        : node.type === 'project' ? brainState.overview.memories?.filter((item) => item.projectId === node.id && item.status === 'done').map((item) => item.key)
          : record.tags;
    const next = node.type === 'checkpoint' ? record.nextStep
      : node.type === 'session' ? latestForSession?.nextStep || record.lastActivity
        : node.type === 'task' ? record.content
          : node.type === 'project' ? brainState.overview.memories?.find((item) => item.projectId === node.id && item.kind === 'task' && item.status === 'open')?.content
            : node.type === 'note' ? 'Notu açarak içeriği ve geri bağlantıları incele.'
              : node.type === 'tfact' ? (record.value || record.object || node.description) : record.content;
    const progress = inspectorProgress(node, record);

    q('#inspectType span').textContent = meta.label;
    byId('inspectType').style.color = meta.color;
    byId('inspectTitle').textContent = node.label || meta.label;
    byId('inspectTime').textContent = `${formatTime(record.updatedAt || record.createdAt || record.heartbeatAt || record.observedAt || record.recordedAt || node.updatedAt)}${(record.agent || record.source?.agent) ? ` · ${record.agent || record.source.agent}` : ''}`;
    byId('inspectSummary').textContent = cleanText(record.summary || record.description || record.content || record.goal || node.description, 'Bu düğüm için açıklama henüz kaydedilmedi.');
    byId('progressText').textContent = progress.text;
    byId('progressLabel').textContent = progress.label;
    byId('progressPercent').textContent = `%${progress.value}`;
    byId('progressBar').style.width = `${progress.value}%`;
    const completedValues = (completed || []).filter(Boolean);
    byId('doneCount').textContent = completedValues.length;
    listItems(byId('doneList'), completedValues, node.type === 'note' ? 'Not graf içinde kayıtlı.' : 'Henüz tamamlanan kayıt yok.');
    byId('nextStep').textContent = cleanText(next, 'Bu kayıt için açık bir sonraki adım yok.');
    setRelations(relations);
    renderSource(record.agent || record.source?.agent || (node.type === 'note' ? 'Not' : 'Notlar Sync'), record.id || node.file || node.id);
    byId('sourceTrust').textContent = node.type === 'tfact'
      ? (evidenceLabels[node.evidenceLevel || record.evidenceLevel] || 'kanıt bilinmiyor').toLocaleLowerCase('tr-TR')
      : 'doğrulandı';
    renderFactSection(node, record);

    const sourceButton = byId('sourceBtn');
    sourceButton.replaceChildren(makeIcon(node.type === 'note' ? 'i-note' : 'i-search'), document.createTextNode(node.type === 'note' ? 'Notu aç' : 'Bağlamı getir'));
    sourceButton.onclick = () => {
      if (node.type === 'note' && node.file) {
        const name = String(node.file).replace(/\.md$/i, '');
        if (window.parent !== window) window.parent.postMessage({ type: 'open-note', name }, location.origin);
        else location.href = `index.html#note=${encodeURIComponent(name)}`;
      } else if (node.type === 'project') {
        brainState.scope = node.id; brainState.filter = 'active'; renderSidebars(); renderGraph();
      } else {
        askMemory(node.label);
      }
    };

    const moreButton = q('.action-row .secondary-btn');
    const forgettable = !['project', 'global', 'session', 'checkpoint', 'note'].includes(node.type) && brainState.role === 'master';
    moreButton.style.display = forgettable ? '' : 'none';
    moreButton.title = 'Bu hafızayı unut';
    moreButton.setAttribute('aria-label', 'Bu hafızayı unut');
    moreButton.onclick = async () => {
      if (!forgettable || !window.confirm(`“${node.label}” hafızası unutulsun mu?`)) return;
      try {
        await brainFetch('/api/memory/forget', jsonOptions('POST', { id: idTail(node.id), reason: 'Kullanıcı AI Beyni ekranından unuttu' }));
        showBrainToast('Hafıza unutuldu');
        await loadBrainData();
      } catch (error) { showBrainToast(error.message, true); }
    };
    setInspectorOpen(brainState.userOpenedInspector || !window.matchMedia('(max-width: 780px)').matches);
  }

  function formatDay(value) {
    const time = Date.parse(value || '');
    if (!time) return '—';
    return new Date(time).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  // Fact düğümü seçilince: durum etiketi, güven, validFrom→validTo,
  // "neden getirildi" açıklaması, önceki/yerine geçen zinciri ve
  // invalidate/dispute eylemleri.
  function renderFactSection(node, record = {}) {
    const section = byId('factSection');
    if (!section) return;
    if (!node || node.type !== 'tfact') { section.hidden = true; return; }
    section.hidden = false;
    const factId = idTail(node.id);
    const status = node.factStatus || record.status || 'active';
    const statusMeta = factStatusMeta[status] || factStatusMeta.active;
    const chip = byId('factStatusChip');
    chip.textContent = statusMeta.label;
    chip.style.color = statusMeta.color;
    const confidence = clamp(Math.round(Number(node.confidence ?? record.confidence ?? 0.7) * 100), 0, 100);
    const validTo = node.validTo || record.validTo;
    byId('factValidity').textContent = `Geçerli: ${formatDay(node.validFrom || record.validFrom)} → ${validTo ? formatDay(validTo) : 'şu an'}`
      + ` · güven %${confidence}`
      + (node.contradictionGroup || record.contradictionGroup ? ' · çelişki grubunda' : '');

    const assertionType = node.assertionType || record.assertionType || 'system';
    const evidenceLevel = node.evidenceLevel || record.evidenceLevel || 'unverified';
    const assertionBadge = byId('factAssertionBadge');
    const evidenceBadge = byId('factEvidenceBadge');
    assertionBadge.textContent = assertionLabels[assertionType] || assertionType;
    assertionBadge.className = 'fact-badge';
    evidenceBadge.textContent = evidenceLabels[evidenceLevel] || evidenceLevel;
    evidenceBadge.className = `fact-badge ${evidenceLevel}`;

    const why = byId('factWhy');
    why.hidden = false;
    const recallReason = brainState.recallWhy.get(factId);
    why.textContent = recallReason ? `Neden getirildi: ${recallReason}` : 'Kaynak zinciri getiriliyor…';
    const evidenceChain = byId('factEvidenceChain');
    evidenceChain.hidden = false;
    evidenceChain.textContent = 'Evidence zinciri getiriliyor…';
    brainFetch(`/api/memory/facts/${encodeURIComponent(factId)}/provenance`).then((prov) => {
      if (brainState.selectedId !== node.id) return;
      if (!recallReason) why.textContent = cleanText(prov.explanation, 'Kaynak bilgisi bulunamadı.');
      const steps = (prov.evidenceChain || []).map((step) => `${step.type}:${step.id}${step.resolved ? ' ✓' : ' ?'}`);
      evidenceChain.textContent = steps.length ? `Evidence zinciri: ${steps.join(' → ')}` : 'Evidence zinciri yok; bilgi kesin gerçek sayılmaz.';
    }).catch(() => {
      if (brainState.selectedId !== node.id) return;
      if (!recallReason) why.textContent = 'Kaynak zinciri alınamadı.';
      evidenceChain.textContent = 'Evidence zinciri alınamadı.';
    });

    const chain = byId('factChain');
    chain.replaceChildren();
    const chainRow = (relatedId, relation) => {
      const target = brainState.overview.facts?.find((item) => item.id === relatedId);
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'relation-item';
      row.style.cssText = 'width:100%;border:0;background:transparent;text-align:left;cursor:pointer;padding:0';
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = (factStatusMeta[target?.status] || factStatusMeta.active).color;
      const info = document.createElement('div');
      const strong = document.createElement('strong');
      strong.textContent = target ? shortText(`${target.subject}: ${target.object || target.value}`, 46) : shortText(relatedId, 30);
      const detail = document.createElement('span');
      detail.textContent = relation;
      info.append(strong, detail);
      row.append(swatch, info, makeIcon('i-arrow', 'icon'));
      row.onclick = () => {
        if (brainState.filter !== 'facts') { brainState.filter = 'facts'; renderSidebars(); renderGraph(); }
        selectBrainNode(`fact:${relatedId}`);
      };
      chain.appendChild(row);
    };
    for (const relatedId of node.supersededBy || record.supersededBy || []) chainRow(relatedId, 'yerine geçen bilgi');
    for (const relatedId of node.supersedes || record.supersedes || []) chainRow(relatedId, 'önceki bilgi');

    const conflictSection = byId('factConflictSection');
    const conflictList = byId('factConflictList');
    const pendingConflicts = (node.conflictSuggestions || record.conflictSuggestions || []).filter((item) => !item.status || item.status === 'pending');
    conflictSection.hidden = !pendingConflicts.length;
    byId('factConflictCount').textContent = pendingConflicts.length;
    conflictList.replaceChildren();
    for (const suggestion of pendingConflicts) {
      const target = brainState.overview.facts?.find((item) => item.id === suggestion.factId);
      const card = document.createElement('div'); card.className = 'conflict-card';
      const title = document.createElement('strong');
      title.textContent = target ? `${target.subject}: ${target.object || target.value}` : `Fact ${shortText(suggestion.factId, 28)}`;
      const reason = document.createElement('span');
      reason.textContent = `%${Math.round(Number(suggestion.similarity || 0) * 100)} benzer · ${(suggestion.reasons || []).join(' · ')}`;
      const buttons = document.createElement('div'); buttons.className = 'conflict-actions';
      const resolveButton = (label, action) => {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'secondary-btn'; button.textContent = label;
        button.onclick = async () => {
          try {
            await brainFetch(`/api/memory/facts/${encodeURIComponent(factId)}/conflict`, jsonOptions('POST', { targetId: suggestion.factId, action }));
            showBrainToast(action === 'supersede' ? 'Bilgi yerine geçirildi' : action === 'dispute' ? 'Bilgiler ihtilaflı işaretlendi' : 'Bilgiler ayrı tutuldu');
            await loadBrainData({ background: true });
          } catch (error) { showBrainToast(error.message, true); }
        };
        buttons.appendChild(button);
      };
      resolveButton('Yerine geçir', 'supersede');
      resolveButton('İhtilaflı işaretle', 'dispute');
      resolveButton('Ayrı bilgi olarak tut', 'keep-separate');
      card.append(title, reason, buttons); conflictList.appendChild(card);
    }

    const actions = byId('factActions');
    actions.replaceChildren();
    if (brainState.role !== 'master' || status === 'forgotten') return;
    const actionButton = (label, handler) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'secondary-btn';
      button.style.cssText = 'width:auto;padding:0 12px';
      button.textContent = label;
      button.onclick = async () => {
        try {
          await handler();
          await loadBrainData({ background: true });
        } catch (error) { showBrainToast(error.message, true); }
      };
      actions.appendChild(button);
    };
    if (['active', 'disputed'].includes(status)) {
      actionButton('Geçersiz kıl', async () => {
        await brainFetch(`/api/memory/facts/${encodeURIComponent(factId)}/invalidate`, jsonOptions('POST', { reason: 'Kullanıcı AI Beyni ekranından geçersiz kıldı' }));
        showBrainToast('Bilgi geçersiz kılındı');
      });
    }
    if (status === 'active') {
      actionButton('İhtilaflı işaretle', async () => {
        await brainFetch(`/api/memory/facts/${encodeURIComponent(factId)}/dispute`, jsonOptions('POST', { reason: 'Kullanıcı bilgiyi ihtilaflı işaretledi' }));
        showBrainToast('Bilgi ihtilaflı işaretlendi');
      });
    }
  }

  function renderEmptyInspector() {
    q('#inspectType span').textContent = 'AI Beyni';
    byId('inspectTitle').textContent = 'Henüz hafıza kaydı yok';
    byId('inspectTime').textContent = 'Yeni bir AI oturumu başladığında burada görünür.';
    byId('inspectSummary').textContent = 'Codex veya Claude bağlantısını ayarlardan kur; ilk checkpoint otomatik olarak bu grafa eklenecek.';
    listItems(byId('doneList'), [], 'Kayıt bekleniyor.');
    byId('nextStep').textContent = 'AI entegrasyonlarını kontrol et.';
    setRelations([]);
    renderFactSection(null);
  }

  function setInspectorOpen(open) {
    const inspector = byId('inspector');
    inspector.classList.toggle('open', !!open);
    inspector.setAttribute('aria-hidden', open ? 'false' : 'true');
    inspector.inert = !open;
  }

  function selectBrainNode(id) {
    brainState.selectedId = id;
    brainState.userOpenedInspector = true;
    qa('#viewport .node').forEach((node) => node.classList.toggle('selected', node.dataset.id === id));
    renderInspector(id);
  }

  function applySearch() {
    const input = byId('search');
    const query = cleanText(input?.value).toLocaleLowerCase('tr-TR');
    const matches = new Set();
    for (const node of brainState.visibleNodes) {
      const text = `${node.label || ''} ${node.description || ''} ${node.type || ''}`.toLocaleLowerCase('tr-TR');
      if (!query || text.includes(query)) matches.add(node.id);
    }
    qa('#viewport .node').forEach((element) => {
      const match = matches.has(element.dataset.id);
      element.classList.toggle('dimmed', !!query && !match);
      element.classList.toggle('match', !!query && match);
    });
    qa('#brainEdges .relation').forEach((edge) => edge.classList.toggle('dimmed', !!query && !(matches.has(edge.dataset.from) && matches.has(edge.dataset.to))));
  }

  function normalizedNoteKey(value) {
    return cleanText(value).replace(/^note:/, '').replace(/\.md$/i, '').toLocaleLowerCase('tr-TR');
  }

  function resultNodeFor(item) {
    if (item.sourceType === 'checkpoint') {
      return brainState.visibleNodes.find((node) => node.id === `checkpoint:${item.id}`);
    }
    if (item.sourceType === 'memory') {
      return brainState.visibleNodes.find((node) => node.id === `memory:${item.id}`);
    }
    if (item.sourceType === 'fact') {
      return brainState.visibleNodes.find((node) => node.id === `fact:${item.id}`);
    }
    if (item.sourceType === 'note') {
      const keys = new Set([item.id, item.source?.note, item.title].map(normalizedNoteKey).filter(Boolean));
      return brainState.visibleNodes.find((node) => node.type === 'note' && [node.rawId, node.file, node.label]
        .map(normalizedNoteKey).some((key) => keys.has(key)));
    }
    return brainState.visibleNodes.find((node) => idTail(node.id) === item.id);
  }

  async function askMemory(question) {
    const queryText = cleanText(question || byId('askInput')?.value);
    if (!queryText) return;
    const askInput = byId('askInput');
    const send = q('#askForm button');
    if (send) send.disabled = true;
    if (askInput) askInput.value = '';
    q('#inspectType span').textContent = 'Hafıza aranıyor';
    byId('inspectType').style.color = 'var(--green)';
    byId('inspectTitle').textContent = queryText;
    byId('inspectSummary').textContent = 'Kararlar, checkpointler, görevler, notlar ve semantik eşleşmeler taranıyor.';
    brainState.userOpenedInspector = true;
    setInspectorOpen(true);
    window.__notlarBrainRecall = { state: 'loading', query: queryText, count: 0, ids: [] };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const project = brainState.memoryGraph.projects?.find((item) => item.id === brainState.scope);
      const result = await brainFetch('/api/memory/recall', {
        ...jsonOptions('POST', {
          query: queryText,
          project: project?.name || '',
          workspace: project?.workspace || '',
          allProjects: !project,
          limit: 10,
          explain: true,
          tokenBudget: brainState.overview.settings?.contextTokenBudget || 2400,
        }),
        signal: controller.signal,
      });
      const results = result.results || [];
      brainState.recallWhy = new Map(results.filter((item) => item.whyMatched).map((item) => [item.id, item.whyMatched]));
      byId('inspectTitle').textContent = queryText;
      q('#inspectType span').textContent = `${results.length} ilgili hafıza`;
      byId('inspectSummary').textContent = cleanText(result.context?.markdown, 'İlgili bir kayıt bulunamadı.').replace(/^#.*\n(?:Proje:.*\n)?/m, '').slice(0, 2200);
      byId('inspectTime').textContent = `${result.embeddingModel ? `Semantik · ${result.embeddingModel}` : result.semanticFallback ? 'Hızlı yerel arama' : 'Yerel karma arama'} · şimdi`;
      const topTitles = results.map((item) => `${item.title} · puan ${Math.round(item.score || 0)}${item.whyMatched ? ` — ${item.whyMatched}` : ''}`);
      byId('doneCount').textContent = topTitles.length;
      listItems(byId('doneList'), topTitles, 'Eşleşme bulunamadı.');
      byId('nextStep').textContent = results[0]?.text || 'Daha belirgin bir proje, karar veya görev adıyla tekrar ara.';
      const resultRelations = results.map((item) => {
        const visible = resultNodeFor(item);
        return visible ? { node: visible, relation: item.kind || item.sourceType } : null;
      }).filter(Boolean);
      setRelations(resultRelations);
      const matchedNodeIds = new Set(resultRelations.map((item) => item.node.id));
      qa('#viewport .node').forEach((element) => element.classList.toggle('match', matchedNodeIds.has(element.dataset.id)));
      window.__notlarBrainRecall = { state: 'success', query: queryText, count: results.length, ids: results.map((item) => item.id), explained: results.filter((item) => item.whyMatched).length };
      showBrainToast(`${results.length} ilgili kayıt bulundu`);
    } catch (error) {
      const message = error.name === 'AbortError' ? 'Hafıza araması zaman aşımına uğradı; tekrar deneyin.' : error.message;
      byId('inspectSummary').textContent = message;
      window.__notlarBrainRecall = { state: 'error', query: queryText, count: 0, ids: [], error: message };
      showBrainToast(message, true);
    } finally {
      clearTimeout(timeout);
      if (send) send.disabled = false;
    }
  }

  let brainToastTimer;
  function showBrainToast(message, error = false) {
    const toast = byId('toast');
    toast.textContent = message;
    toast.classList.toggle('brain-error', error);
    toast.classList.add('open');
    clearTimeout(brainToastTimer);
    brainToastTimer = setTimeout(() => toast.classList.remove('open'), 2600);
  }

  function integrationReady(provider) { return !!(provider.installed && provider.hooksConfigured && provider.mcpConfigured); }

  let dialogReturnFocus = null;
  function closeSettingsDialog() {
    const dialog = byId('brainDialog');
    if (!dialog) return;
    dialog.classList.remove('open');
    dialog.setAttribute('aria-hidden', 'true');
    if (dialogReturnFocus?.isConnected) dialogReturnFocus.focus();
    dialogReturnFocus = null;
  }

  function buildSettingsDialog() {
    let dialog = byId('brainDialog');
    if (dialog) return dialog;
    dialog = document.createElement('div'); dialog.id = 'brainDialog'; dialog.className = 'brain-dialog';
    dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-hidden', 'true'); dialog.setAttribute('aria-labelledby', 'brainDialogTitle');
    const panel = document.createElement('div'); panel.className = 'brain-dialog-panel'; panel.tabIndex = -1;
    const head = document.createElement('div'); head.className = 'brain-dialog-head';
    const heading = document.createElement('h2'); heading.id = 'brainDialogTitle'; heading.textContent = 'AI Beyni ayarları';
    const close = document.createElement('button'); close.className = 'icon-btn'; close.title = 'Kapat'; close.setAttribute('aria-label', 'Ayarları kapat'); close.appendChild(makeIcon('i-x', 'icon'));
    close.onclick = closeSettingsDialog; head.append(heading, close);
    const settings = document.createElement('div'); settings.id = 'brainSettingsFields';
    const integrationsHeading = document.createElement('div'); integrationsHeading.className = 'section-label'; integrationsHeading.textContent = 'AI bağlantıları';
    const integrationList = document.createElement('div'); integrationList.id = 'brainIntegrationList'; integrationList.className = 'integration-list';
    const message = document.createElement('div'); message.id = 'brainDialogMessage'; message.style.cssText = 'min-height:18px;color:var(--muted);font-size:11px;margin-bottom:10px';
    const actions = document.createElement('div'); actions.className = 'brain-dialog-actions';
    const install = document.createElement('button'); install.id = 'brainInstallAll'; install.className = 'secondary-btn'; install.style.width = 'auto'; install.style.padding = '0 12px'; install.textContent = 'Bağlantıları kur / onar';
    const save = document.createElement('button'); save.id = 'brainSaveSettings'; save.className = 'primary-btn'; save.style.flex = 'none'; save.textContent = 'Kaydet';
    actions.append(install, save); panel.append(head, settings, integrationsHeading, integrationList, message, actions); dialog.appendChild(panel); document.body.appendChild(dialog);
    dialog.onclick = (event) => { if (event.target === dialog) closeSettingsDialog(); };
    dialog.onkeydown = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); closeSettingsDialog(); return; }
      if (event.key !== 'Tab') return;
      const focusable = qa('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])', dialog)
        .filter((element) => element.offsetParent !== null);
      if (!focusable.length) { event.preventDefault(); panel.focus(); return; }
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    save.onclick = saveBrainSettings;
    install.onclick = installBrainIntegrations;
    return dialog;
  }

  function settingRow(title, detail, control) {
    const row = document.createElement('label'); row.className = 'brain-setting';
    const info = document.createElement('span');
    const strong = document.createElement('strong'); strong.textContent = title;
    const small = document.createElement('small'); small.textContent = detail;
    info.append(strong, small); row.append(info, control); return row;
  }

  function renderIntegrationRows() {
    const list = byId('brainIntegrationList');
    if (!list) return;
    list.replaceChildren();
    const providers = brainState.integrations?.providers || [];
    if (brainState.integrationLoading) {
      const loading = document.createElement('div'); loading.className = 'integration-row'; loading.textContent = 'Codex ve Claude bağlantıları denetleniyor…'; list.appendChild(loading); return;
    }
    if (!providers.length) {
      const empty = document.createElement('div'); empty.className = 'integration-row'; empty.textContent = brainState.role === 'master' ? 'Kurulu AI istemcisi bulunamadı.' : 'Bağlantı durumu yalnız ana cihazda görünür.'; list.appendChild(empty);
      return;
    }
    for (const provider of providers) {
      const row = document.createElement('div'); row.className = 'integration-row'; row.dataset.provider = provider.id;
      const mark = document.createElement('span'); mark.className = 'integration-mark'; mark.textContent = provider.id === 'codex' ? 'CX' : 'CL';
      const info = document.createElement('div');
      const strong = document.createElement('strong'); strong.textContent = provider.name;
      const detail = document.createElement('small'); detail.textContent = !provider.installed ? 'İstemci bulunamadı' : integrationReady(provider) ? 'MCP + yaşam döngüsü bağlı' : 'Kurulum veya güven onayı gerekli';
      info.append(strong, detail);
      const status = document.createElement('span'); status.className = `type-line${integrationReady(provider) ? '' : ' brain-error'}`; status.textContent = integrationReady(provider) ? 'hazır' : 'eksik';
      row.append(mark, info, status); list.appendChild(row);
    }
  }

  async function refreshBrainIntegrations(force = false) {
    if (brainState.role !== 'master' || brainState.integrationLoading || (brainState.integrations && !force)) return;
    brainState.integrationLoading = true;
    renderIntegrationRows();
    try {
      brainState.integrations = await brainFetch(`/api/integrations${force ? '?refresh=1' : ''}`);
    } catch (error) {
      const message = byId('brainDialogMessage');
      if (message) { message.className = 'brain-error'; message.textContent = error.message; }
    } finally {
      brainState.integrationLoading = false;
      renderIntegrationRows();
      renderHealth();
    }
  }

  function renderSettingsDialog() {
    const dialog = buildSettingsDialog();
    const settings = brainState.overview.settings || {};
    const fields = byId('brainSettingsFields'); fields.replaceChildren();
    const budget = document.createElement('input'); budget.id = 'brainTokenBudget'; budget.type = 'number'; budget.min = '500'; budget.max = '8000'; budget.step = '100'; budget.value = settings.contextTokenBudget || 2400;
    const transcript = document.createElement('select'); transcript.id = 'brainTranscriptMode';
    [['off', 'Kapalı'], ['summaries', 'Özetler'], ['full', 'Tam arşiv']].forEach(([value, label]) => { const option = document.createElement('option'); option.value = value; option.textContent = label; transcript.appendChild(option); });
    transcript.value = settings.transcriptMode || 'summaries';
    const capture = document.createElement('input'); capture.id = 'brainAutoCapture'; capture.type = 'checkbox'; capture.checked = settings.autoCapture !== false;
    fields.append(
      settingRow('Başlangıç bağlamı', 'AI oturumuna verilecek yaklaşık token bütçesi.', budget),
      settingRow('Konuşma arşivi', 'Hassas bilgiler kaydedilmeden önce filtrelenir.', transcript),
      settingRow('Otomatik checkpoint', 'Hook destekleyen ajanlarda önemli oturum durumunu kaydeder.', capture),
    );

    renderIntegrationRows();
    byId('brainInstallAll').disabled = brainState.role !== 'master';
    byId('brainSaveSettings').disabled = brainState.role !== 'master';
    dialogReturnFocus = document.activeElement;
    dialog.setAttribute('aria-hidden', 'false');
    dialog.classList.add('open');
    q('.brain-dialog-panel', dialog).focus();
    void refreshBrainIntegrations();
  }

  async function saveBrainSettings() {
    const message = byId('brainDialogMessage'); message.className = ''; message.textContent = 'Kaydediliyor…';
    try {
      const settings = await brainFetch('/api/memory/settings', jsonOptions('POST', {
        contextTokenBudget: Number(byId('brainTokenBudget').value), transcriptMode: byId('brainTranscriptMode').value, autoCapture: byId('brainAutoCapture').checked,
      }));
      brainState.overview.settings = settings; message.className = ''; message.textContent = 'Hafıza ayarları kaydedildi.';
    } catch (error) { message.textContent = error.message; message.className = 'brain-error'; }
  }

  async function installBrainIntegrations() {
    const button = byId('brainInstallAll'); const message = byId('brainDialogMessage');
    button.disabled = true; button.textContent = 'Kuruluyor…'; message.className = ''; message.textContent = 'Codex ve Claude bağlantıları yapılandırılıyor.';
    try {
      const result = await brainFetch('/api/integrations/install', jsonOptions('POST', { provider: 'all' }));
      brainState.integrations = result.status || result;
      renderIntegrationRows(); renderHealth();
      message.textContent = 'Bağlantılar kuruldu. Codex içinde /hooks ile bir kez güven onayı gerekebilir.';
    } catch (error) { message.textContent = error.message; message.className = 'brain-error'; }
    finally { button.disabled = brainState.role !== 'master'; button.textContent = 'Bağlantıları kur / onar'; }
  }

  function setMobileSidebar(open) {
    const sidebar = q('.sidebar');
    const button = byId('brainMobileMenu');
    if (!sidebar || !button) return;
    sidebar.classList.toggle('mobile-open', !!open);
    sidebar.setAttribute('aria-hidden', open ? 'false' : String(window.matchMedia('(max-width: 1180px)').matches));
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function wireControls(askForm) {
    const segmented = q('.segmented');
    [['connections', 'Bağlantılar'], ['time', 'Zaman'], ['clusters', 'Kümeler']].forEach(([mode, label]) => {
      const button = document.createElement('button'); button.textContent = label; button.dataset.mode = mode; button.className = brainState.mode === mode ? 'active' : '';
      button.onclick = () => { brainState.mode = mode; qa('.segmented button').forEach((item) => item.classList.toggle('active', item === button)); document.documentElement.dataset.mode = mode; renderGraph(); };
      segmented.appendChild(button);
    });
    byId('search').addEventListener('input', applySearch);
    document.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase('tr-TR') === 'k') { event.preventDefault(); byId('search').focus(); }
      if (event.key === 'Escape') {
        byId('search').value = ''; applySearch();
        brainState.userOpenedInspector = false;
        setInspectorOpen(false);
        closeSettingsDialog();
        setMobileSidebar(false);
      }
    });
    byId('zoomIn').onclick = () => setBrainScale(brainState.scale + .12);
    byId('zoomOut').onclick = () => setBrainScale(brainState.scale - .12);
    byId('fitBtn').onclick = () => setBrainScale(1);
    byId('focusBtn').onclick = () => {
      const checkpoint = brainState.visibleNodes.find((node) => node.type === 'checkpoint');
      if (checkpoint) { selectBrainNode(checkpoint.id); setBrainScale(1.12); showBrainToast('Son checkpoint odaklandı'); }
      else showBrainToast('Henüz checkpoint yok');
    };
    byId('closeInspector').onclick = () => { brainState.userOpenedInspector = false; setInspectorOpen(false); };
    askForm.onsubmit = (event) => { event.preventDefault(); askMemory(byId('askInput').value); };
    byId('brainOptionsBtn').onclick = renderSettingsDialog;
    byId('brainSidebarMenu').onclick = () => { setMobileSidebar(false); renderSettingsDialog(); };
    byId('brainMobileMenu').onclick = () => setMobileSidebar(!q('.sidebar').classList.contains('mobile-open'));
    document.addEventListener('pointerdown', (event) => {
      const sidebar = q('.sidebar');
      if (!sidebar.classList.contains('mobile-open') || sidebar.contains(event.target) || byId('brainMobileMenu').contains(event.target)) return;
      setMobileSidebar(false);
    });
    wireStandaloneRail();
  }

  function setBrainScale(value) {
    brainState.scale = clamp(value, .68, 1.55);
    byId('graph').style.transform = `scale(${brainState.scale})`;
  }

  function wireStandaloneRail() {
    const routes = ['overview', 'notes', 'map', 'vault', 'tools'];
    qa('.rail-nav .icon-btn').forEach((button, index) => {
      button.onclick = () => {
        const view = routes[index] || 'overview';
        if (window.parent !== window) window.parent.postMessage({ type: 'brain-nav', view }, location.origin);
        else location.href = `index.html#view=${view}`;
      };
    });
    const settings = q('.rail > .icon-btn');
    if (settings) settings.onclick = renderSettingsDialog;
  }

  function updateLiveStatus(live, nodeCount = brainState.visibleNodes.length, edgeCount = brainState.visibleEdges.length) {
    brainState.live = !!live;
    const dot = q('.stage-status .live-dot');
    if (dot) dot.classList.toggle('offline', !live);
    const status = q('.stage-status span:last-child');
    if (status) status.textContent = `${live ? 'Canlı' : 'Bağlantı bekleniyor'} · ${nodeCount} düğüm · ${edgeCount} bağlantı`;
  }

  function showLoading(message, error = false) {
    let loading = byId('brainLoading');
    if (!loading) { loading = document.createElement('div'); loading.id = 'brainLoading'; loading.className = 'brain-loading'; q('.stage').appendChild(loading); }
    loading.hidden = false; loading.textContent = message; loading.classList.toggle('brain-error', error);
  }
  function hideLoading() { const loading = byId('brainLoading'); if (loading) loading.hidden = true; }

  async function loadBrainData(options = {}) {
    const version = ++brainState.loadVersion;
    clearTimeout(brainState.dataRetryTimer);
    if (!options.background) showLoading('AI Beyni yükleniyor…');
    const requests = await Promise.allSettled([
      brainState.sessionLoaded ? Promise.resolve(null) : brainFetch('/api/session'),
      brainFetch('/api/memory/graph'),
      brainFetch('/api/memory/overview?sessionLimit=100&checkpointLimit=100&memoryLimit=200&factLimit=200'),
      brainFetch('/api/graph'),
    ]);
    if (version !== brainState.loadVersion) return;
    const [session, memoryGraph, overview, noteGraph] = requests;
    if (session.status === 'fulfilled' && session.value) {
      brainState.role = session.value.role || 'device';
      brainState.sessionLoaded = true;
      localStorage.removeItem('key');
      brainState.key = '';
    }
    if (memoryGraph.status === 'fulfilled') brainState.memoryGraph = memoryGraph.value;
    if (overview.status === 'fulfilled') brainState.overview = overview.value;
    if (noteGraph.status === 'fulfilled') brainState.noteGraph = noteGraph.value;
    if (memoryGraph.status === 'rejected' && overview.status === 'rejected') {
      showLoading(`AI Beyni açılamadı: ${memoryGraph.reason?.message || overview.reason?.message}`, true);
      updateLiveStatus(false, 0, 0);
      brainState.dataRetryTimer = setTimeout(() => loadBrainData(), 3000);
      connectBrainSocket();
      return;
    }
    renderSidebars(); renderGraph();
    if (!brainState.presented && window.matchMedia('(max-width: 780px)').matches) setInspectorOpen(false);
    brainState.presented = true;
    hideLoading(); connectBrainSocket();
    window.__notlarBrainReady = true;
  }

  let reloadTimer;
  function scheduleBrainReload() { clearTimeout(reloadTimer); reloadTimer = setTimeout(() => loadBrainData({ background: true }), 350); }

  function connectBrainSocket() {
    if (brainState.ws && brainState.ws.readyState <= 1) return;
    clearTimeout(brainState.socketRetryTimer);
    try {
      const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/`);
      let initialListSeen = false;
      brainState.ws = socket;
      socket.onopen = () => {
        brainState.socketRetry = 0;
        updateLiveStatus(true);
        socket.send(JSON.stringify({ type: 'auth', key: brainState.key }));
      };
      socket.onmessage = (event) => {
        let message; try { message = JSON.parse(event.data); } catch { return; }
        if (message.type === 'list' && !initialListSeen) { initialListSeen = true; return; }
        if (['memory', 'list', 'content', 'renamed', 'deleted'].includes(message.type)) scheduleBrainReload();
      };
      socket.onerror = () => { try { socket.close(); } catch {} };
      socket.onclose = () => {
        if (brainState.ws !== socket) return;
        brainState.ws = null;
        updateLiveStatus(false);
        const delay = Math.min(15000, 800 * (2 ** brainState.socketRetry++));
        brainState.socketRetryTimer = setTimeout(connectBrainSocket, delay);
      };
    } catch {
      updateLiveStatus(false);
      brainState.socketRetryTimer = setTimeout(connectBrainSocket, 1600);
    }
  }

  function resetInitialUi() {
    byId('pageTitle').textContent = 'Beyin / Yükleniyor';
    const subtitle = q('.page-title span'); if (subtitle) subtitle.textContent = 'Gerçek hafıza ve oturum verisi hazırlanıyor';
    q('#inspectType span').textContent = 'AI Beyni';
    byId('inspectTitle').textContent = 'Canlı bağlam yükleniyor';
    byId('inspectTime').textContent = 'Oturum, checkpoint ve not grafı denetleniyor.';
    byId('inspectSummary').textContent = 'Bu panel yalnız gerçek hafıza kayıtları yüklendiğinde ayrıntı gösterecek.';
    byId('progressText').textContent = '—'; byId('progressPercent').textContent = '—'; byId('progressBar').style.width = '0%';
    byId('doneCount').textContent = '0'; listItems(byId('doneList'), [], 'Kayıt yükleniyor.');
    byId('nextStep').textContent = 'Bağlantı bekleniyor.'; setRelations([]);
    renderFactSection(null);
    q('.source-line').replaceChildren();
    updateLiveStatus(false, 0, 0);
  }

  const cleanAskForm = setupCleanControls();
  resetInitialUi();
  wireControls(cleanAskForm);
  setMobileSidebar(false);
  const staticViewport = byId('viewport');
  if (staticViewport) staticViewport.replaceChildren();
  if (window.matchMedia('(max-width: 780px)').matches) setInspectorOpen(false);

  let authStarted = false;
  function startWithAuth() {
    if (authStarted && !brainState.key) return;
    authStarted = true;
    loadBrainData();
  }
  window.addEventListener('message', (event) => {
    if (event.origin !== location.origin || event.source !== window.parent || !event.data) return;
    if (event.data.type === 'notlar-key') {
      const changed = brainState.key !== (event.data.key || '');
      brainState.key = event.data.key || '';
      if (changed) {
        brainState.sessionLoaded = false;
        brainState.integrations = null;
        if (brainState.ws) { try { brainState.ws.close(); } catch {} brainState.ws = null; }
      }
      startWithAuth();
    }
  });
  if (brainState.key || window.parent === window) startWithAuth();
  else {
    window.parent.postMessage({ type: 'harita-hazir' }, location.origin);
    setTimeout(startWithAuth, 1200);
  }
})();
