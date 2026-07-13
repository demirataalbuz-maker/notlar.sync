'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const temporalModule = require('./temporal');
const { createFactIndex } = require('./memory-index');

const VERSION = 3;
const SESSION_STALE_MS = 30 * 60 * 1000;
const MAX_MEMORIES = 5000;
const MAX_SESSIONS = 2000;
const MAX_CHECKPOINTS = 4000;
const KINDS = new Set(['preference', 'fact', 'decision', 'task', 'project', 'person', 'reference']);
const EVENT_TYPES = new Set(['action', 'decision', 'task', 'result', 'error', 'preference', 'fact', 'message_summary', 'note']);
const MEMORY_STATUSES = new Set(['active', 'open', 'done', 'superseded', 'forgotten']);
const SESSION_STATUSES = new Set(['active', 'ended', 'interrupted']);
const DEFAULT_SETTINGS = Object.freeze({
  contextTokenBudget: 2400,
  retentionDays: 365,
  transcriptMode: 'summaries',
  autoCapture: true,
});

const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]'],
  [/\b(?:sk|rk|pk)-(?:live|test|proj)?[-_a-zA-Z0-9]{16,}\b/g, '[REDACTED_API_KEY]'],
  [/\b(?:ghp|github_pat|glpat|xox[baprs]|hf)_[a-zA-Z0-9_-]{16,}\b/g, '[REDACTED_TOKEN]'],
  [/\bBearer\s+[a-zA-Z0-9._~+\/-]{16,}\b/gi, 'Bearer [REDACTED_TOKEN]'],
  [/\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/g, '[REDACTED_JWT]'],
  [/((?:password|parola|passwd|secret|token|api[_ -]?key|anahtar)\s*[=:]\s*)('[^']*'|"[^"]*"|[^\s,;]+)/gi, '$1[REDACTED]'],
];

function clamp(value, min, max, fallback = min) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function nowIso() { return new Date().toISOString(); }

function randomId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('base64url')}`;
}

function safeText(value, max = 4000) {
  return String(value ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max);
}

function safeId(value, max = 120) {
  const text = safeText(value, max);
  return /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(text) ? text : '';
}

function safeList(value, maxItems = 40, maxText = 500) {
  return (Array.isArray(value) ? value : [])
    .map((item) => safeText(item, maxText))
    .filter(Boolean)
    .slice(0, maxItems);
}

function redact(value) {
  let text = safeText(value, 20000);
  let redactions = 0;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    text = text.replace(pattern, (...args) => {
      redactions++;
      return String(replacement).replace('$1', args[1] || '');
    });
  }
  return { text, redactions };
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

function normalizeForSearch(value) {
  return safeText(value, 30000).toLocaleLowerCase('tr')
    .replace(/ı/g, 'i').replace(/ğ/g, 'g').replace(/ü/g, 'u')
    .replace(/ş/g, 's').replace(/ö/g, 'o').replace(/ç/g, 'c')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

function tokens(value) {
  return normalizeForSearch(value).split(/\s+/).filter((token) => token.length > 1).slice(0, 3000);
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
  let dot = 0, aa = 0, bb = 0;
  for (let index = 0; index < a.length; index++) {
    dot += a[index] * b[index];
    aa += a[index] * a[index];
    bb += b[index] * b[index];
  }
  return aa && bb ? dot / (Math.sqrt(aa) * Math.sqrt(bb)) : 0;
}

function embeddingCacheKey(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex').slice(0, 24);
}

const temporal = temporalModule.createTemporal({
  clamp, nowIso, randomId, safeText, safeId, safeList, redact, normalizeForSearch,
});

function defaultState() {
  return {
    version: VERSION,
    settings: { ...DEFAULT_SETTINGS },
    memories: [],
    sessions: [],
    checkpoints: [],
    facts: [],
    factIndexRevision: 0,
  };
}

function createStore(dataDir) {
  const root = path.join(dataDir, 'memory');
  const stateFile = path.join(root, 'state.json');
  const eventsDir = path.join(root, 'events');
  fs.mkdirSync(eventsDir, { recursive: true, mode: 0o700 });
  for (const dir of [root, eventsDir]) try { fs.chmodSync(dir, 0o700); } catch {}
  const factIndex = createFactIndex({ root, atomicJson, normalizeForSearch, safeText });

  function load() {
    let state;
    try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
    catch { state = defaultState(); }
    if (!state || typeof state !== 'object') state = defaultState();
    state.version = VERSION;
    state.settings = { ...DEFAULT_SETTINGS, ...(state.settings || {}) };
    state.memories = Array.isArray(state.memories) ? state.memories : [];
    state.sessions = Array.isArray(state.sessions) ? state.sessions : [];
    state.checkpoints = Array.isArray(state.checkpoints) ? state.checkpoints : [];
    state.facts = Array.isArray(state.facts) ? state.facts : [];
    state.factIndexRevision = Math.max(0, Number(state.factIndexRevision) || 0);
    for (const fact of state.facts) {
      fact.source = fact.source && typeof fact.source === 'object' ? fact.source : {};
      if (!fact.assertionType) fact.assertionType = fact.source.agent && fact.source.agent !== 'user' ? 'agent' : 'user';
      if (!fact.evidenceLevel) {
        fact.evidenceLevel = fact.source.checkpointId || fact.source.eventId ? 'derived'
          : (fact.source.sessionId || fact.source.noteId || fact.source.file || fact.assertionType === 'user') ? 'direct' : 'unverified';
      }
      if (fact.assertionType === 'user' && !fact.source.agent) fact.source.agent = 'user';
    }
    return state;
  }

  function projectOf(input = {}) {
    const workspace = safeText(input.workspace || input.cwd, 700);
    const explicit = safeText(input.projectKey || input.projectId, 180);
    const projectName = safeText(input.project || input.projectName, 120)
      || (workspace ? path.basename(workspace.replace(/[\\/]+$/, '')) : '')
      || 'Genel';
    const key = explicit || workspace || projectName;
    return {
      id: /^prj_[a-f0-9]{16}$/.test(explicit)
        ? explicit
        : `prj_${crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)}`,
      name: projectName,
      workspace,
    };
  }

  function recoverStale(state, at = Date.now()) {
    let changed = false;
    for (const session of state.sessions) {
      if (session.status !== 'active') continue;
      const heartbeat = Date.parse(session.heartbeatAt || session.startedAt || 0);
      if (!heartbeat || at - heartbeat <= SESSION_STALE_MS) continue;
      session.status = 'interrupted';
      session.endedAt = new Date(heartbeat || at).toISOString();
      session.endReason = 'heartbeat-timeout';
      changed = true;
    }
    return changed;
  }

  function prune(state) {
    const cutoff = Date.now() - clamp(state.settings.retentionDays, 1, 3650, 365) * 86400000;
    const pinnedSessionIds = new Set(state.memories.filter((item) => item.pinned).map((item) => item.source?.sessionId).filter(Boolean));
    const expiredSessions = state.sessions
      .filter((session) => session.status !== 'active' && !pinnedSessionIds.has(session.id)
        && Date.parse(session.endedAt || session.startedAt || 0) < cutoff)
      .map((session) => session.id);
    const expired = new Set(expiredSessions);
    if (expired.size) {
      state.sessions = state.sessions.filter((session) => !expired.has(session.id));
      state.checkpoints = state.checkpoints.filter((checkpoint) => !expired.has(checkpoint.sessionId));
      for (const id of expired) try { fs.unlinkSync(path.join(eventsDir, `${id}.jsonl`)); } catch {}
    }
    if (state.memories.length > MAX_MEMORIES) {
      const keep = state.memories.filter((item) => item.pinned);
      const rest = state.memories.filter((item) => !item.pinned)
        .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0))
        .slice(0, Math.max(0, MAX_MEMORIES - keep.length));
      state.memories = [...keep, ...rest];
    }
    if (state.sessions.length > MAX_SESSIONS) {
      state.sessions = state.sessions.sort((a, b) => Date.parse(b.startedAt || 0) - Date.parse(a.startedAt || 0)).slice(0, MAX_SESSIONS);
    }
    if (state.checkpoints.length > MAX_CHECKPOINTS) {
      state.checkpoints = state.checkpoints.sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0)).slice(0, MAX_CHECKPOINTS);
    }
    return temporal.pruneFacts(state);
  }

  function save(state, factChanges = null) {
    recoverStale(state);
    const prunedFacts = prune(state) || { removedIds: [], changedIds: [] };
    let changes = factChanges ? { ...factChanges } : null;
    if (prunedFacts.removedIds.length) {
      changes = changes || {};
      changes.forceRebuild = true;
      changes.purge = true;
      changes.removedIds = [...new Set([...(changes.removedIds || []), ...prunedFacts.removedIds])];
      changes.changedIds = [...new Set([...(changes.changedIds || []), ...prunedFacts.changedIds])];
    }
    if (changes) {
      state.factIndexRevision = Math.max(0, Number(state.factIndexRevision) || 0) + 1;
    }
    atomicJson(stateFile, state);
    return changes ? factIndex.applyChanges(state, changes) : null;
  }

  function appendEvent(sessionId, event) {
    const id = safeId(sessionId);
    if (!id) throw new Error('gecersiz oturum kimligi');
    const file = path.join(eventsDir, `${id}.jsonl`);
    fs.appendFileSync(file, JSON.stringify(event) + '\n', { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch {}
  }

  function readEvents(sessionId, limit = 100) {
    const id = safeId(sessionId);
    if (!id) return [];
    let lines;
    try { lines = fs.readFileSync(path.join(eventsDir, `${id}.jsonl`), 'utf8').trim().split('\n'); }
    catch { return []; }
    return lines.slice(-clamp(limit, 1, 1000, 100)).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  }

  function memoryKey(input, project) {
    const kind = KINDS.has(input.kind) ? input.kind : 'fact';
    const scope = input.scope === 'global' ? 'global' : 'project';
    const key = normalizeForSearch(input.key || input.title || input.content).slice(0, 180);
    return `${scope}|${scope === 'global' ? 'global' : project.id}|${kind}|${key}`;
  }

  function factEmbeddingText(fact) {
    if (!fact) return '';
    const title = `${fact.subject || ''} ${fact.predicate || ''}${fact.topic ? ` ${fact.topic}` : ''}`;
    const text = fact.value && fact.value !== fact.object
      ? `${fact.object || ''}\n${fact.value || ''}`.trim()
      : (fact.value || fact.object || '');
    return `${title}: ${text}`.slice(0, 4000);
  }

  function memoryEmbeddingText(item) {
    return item ? `${item.key || ''}: ${item.content || ''}`.slice(0, 4000) : '';
  }

  function purgeEmbeddingCache(texts) {
    const keys = new Set((texts || []).filter(Boolean).map(embeddingCacheKey));
    if (!keys.size) return 0;
    const file = path.join(dataDir, 'embed-cache.json');
    let cache;
    try { cache = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { return 0; }
    if (!cache || typeof cache !== 'object' || Array.isArray(cache)) return 0;
    let removed = 0;
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(cache, key)) continue;
      delete cache[key];
      removed++;
    }
    if (removed) atomicJson(file, cache);
    return removed;
  }

  function upsertMemoryInState(state, input, source = {}) {
    const project = projectOf(input);
    const kind = KINDS.has(input.kind) ? input.kind : 'fact';
    const scope = input.scope === 'global' ? 'global' : 'project';
    const redacted = redact(input.content);
    if (!redacted.text) throw new Error('hafiza icerigi bos');
    const key = memoryKey({ ...input, kind, scope, content: redacted.text }, project);
    const at = nowIso();
    let item = state.memories.find((candidate) => candidate.dedupeKey === key && candidate.status !== 'forgotten');
    const previous = item ? item.content : '';
    if (!item) {
      item = { id: randomId('mem'), createdAt: at, accessCount: 0 };
      state.memories.push(item);
    }
    Object.assign(item, {
      dedupeKey: key,
      kind,
      scope,
      projectId: scope === 'global' ? null : project.id,
      projectName: scope === 'global' ? null : project.name,
      key: safeText(input.key || input.title || redacted.text.split('\n')[0], 180),
      content: redacted.text,
      importance: clamp(input.importance, 1, 5, item.importance || 3),
      status: MEMORY_STATUSES.has(input.status) ? input.status : (kind === 'task' ? 'open' : 'active'),
      pinned: input.pinned === undefined ? !!item.pinned : !!input.pinned,
      tags: safeList(input.tags, 16, 50),
      updatedAt: at,
      source: {
        agent: safeText(source.agent || input.agent, 80),
        client: safeText(source.client || input.client, 80),
        sessionId: safeId(source.sessionId || input.sessionId),
        checkpointId: safeId(source.checkpointId || input.checkpointId),
        at,
      },
      redactions: (item.redactions || 0) + redacted.redactions,
    });
    if (previous && previous !== item.content) item.revision = (item.revision || 1) + 1;
    else item.revision = item.revision || 1;
    return item;
  }

  // Fact'lere ozel skor etkileri: guven katkisi, guncel bilgi onceligi ve
  // tarihsel/ihtilafli ceza. asOf verildiginde aday listesi zaten o ana gore
  // suzuldugu icin tarihsel ceza uygulanmaz.
  function factScoreParts(candidate, opts = {}) {
    const confidenceBoost = (clamp(candidate.confidence, 0, 1, 0.7) - 0.6) * 20;
    let historicalPenalty = 0;
    let disputedPenalty = 0;
    let currentBoost = 0;
    if (opts.asOf) currentBoost = 4;
    else if (candidate.factStatus === 'active') currentBoost = 6;
    else if (candidate.factStatus === 'disputed') disputedPenalty = opts.includeDisputed ? 0 : -28;
    else historicalPenalty = -25;
    const evidencePenalty = candidate.evidenceLevel === 'unverified' ? -18
      : candidate.evidenceLevel === 'derived' ? -3 : 0;
    const assertionPenalty = candidate.assertionType === 'inferred' ? -4 : 0;
    return {
      confidenceBoost, historicalPenalty, disputedPenalty, currentBoost, evidencePenalty, assertionPenalty,
      total: confidenceBoost + historicalPenalty + disputedPenalty + currentBoost + evidencePenalty + assertionPenalty,
    };
  }

  function scoreCandidates(candidates, query, projectId, allProjects = false, opts = {}) {
    const queryTokens = [...new Set(tokens(query))];
    const documentTokens = candidates.map((candidate) => tokens(`${candidate.title || ''} ${candidate.text || ''} ${(candidate.tags || []).join(' ')}`));
    const documentFrequency = new Map();
    for (const list of documentTokens) {
      for (const token of new Set(list)) documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
    }
    const total = Math.max(1, candidates.length);
    return candidates.map((candidate, index) => {
      const list = documentTokens[index];
      const counts = new Map();
      for (const token of list) counts.set(token, (counts.get(token) || 0) + 1);
      let lexical = 0;
      for (const token of queryTokens) {
        const count = counts.get(token) || 0;
        if (!count) continue;
        const idf = Math.log(1 + (total - (documentFrequency.get(token) || 0) + 0.5) / ((documentFrequency.get(token) || 0) + 0.5));
        lexical += idf * ((count * 2.2) / (count + 1.2));
      }
      const ageDays = Math.max(0, (Date.now() - Date.parse(candidate.updatedAt || candidate.createdAt || 0)) / 86400000);
      const recency = 10 * Math.exp(-ageDays / 90);
      const scope = allProjects
        ? (!candidate.projectId ? 5 : 0)
        : candidate.projectId === projectId ? 12 : (!candidate.projectId ? 5 : -4);
      const pinned = candidate.pinned ? 20 : 0;
      const importance = clamp(candidate.importance, 1, 5, 2) * 2;
      const status = candidate.status === 'open' ? 5 : candidate.status === 'done' ? -1 : 0;
      const queryless = queryTokens.length ? 0 : recency + importance;
      const fact = candidate.sourceType === 'fact' ? factScoreParts(candidate, opts) : null;
      const score = lexical * 12 + recency + scope + pinned + importance + status + queryless + (fact?.total || 0);
      return {
        ...candidate, score, lexicalScore: lexical,
        scoreParts: {
          lexical: lexical * 12, recency, projectScope: scope, pinned, importance, status, queryless,
          semantic: 0, graph: 0,
          confidence: fact?.confidenceBoost || 0,
          historicalPenalty: fact?.historicalPenalty || 0,
          disputedPenalty: fact?.disputedPenalty || 0,
          currentBoost: fact?.currentBoost || 0,
          evidencePenalty: fact?.evidencePenalty || 0,
          assertionPenalty: fact?.assertionPenalty || 0,
        },
      };
    }).sort((a, b) => b.score - a.score || Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));
  }

  function candidatesFor(state, input = {}, externalItems = []) {
    const allProjects = input.allProjects === true;
    const project = allProjects
      ? { id: 'scope:all', name: 'Tüm beyin', workspace: '' }
      : projectOf(input);
    const candidates = [];
    for (const item of state.memories) {
      if (item.status === 'forgotten' || (!allProjects && item.projectId && item.projectId !== project.id)) continue;
      candidates.push({
        id: item.id, sourceType: 'memory', kind: item.kind, title: item.key,
        text: item.content, projectId: item.projectId, projectName: item.projectName,
        status: item.status, pinned: item.pinned, importance: item.importance,
        tags: item.tags, updatedAt: item.updatedAt, source: item.source,
      });
    }
    for (const checkpoint of state.checkpoints) {
      if (!allProjects && checkpoint.projectId !== project.id) continue;
      candidates.push({
        id: checkpoint.id, sourceType: 'checkpoint', kind: 'checkpoint',
        title: checkpoint.title || 'Oturum checkpointi',
        text: [checkpoint.summary, checkpoint.nextStep, ...checkpoint.decisions, ...checkpoint.openTasks]
          .filter(Boolean).filter((part, index, all) => !all.slice(0, index).some((previous) => previous.includes(part))).join('\n'),
        projectId: checkpoint.projectId, projectName: checkpoint.projectName,
        status: checkpoint.status || 'active', importance: 4, tags: checkpoint.tags,
        updatedAt: checkpoint.createdAt, source: { agent: checkpoint.agent, sessionId: checkpoint.sessionId },
      });
    }
    const indexResult = factIndex.query(state, {
      query: input.query || input.goal || '',
      projectId: project.id,
      workspace: project.workspace,
      allProjects,
      asOf: input.asOf,
      includeHistorical: input.includeHistorical === true,
      subject: input.subject,
      predicate: input.predicate,
      topic: input.topic,
      status: input.status,
      assertionType: input.assertionType,
      evidenceLevel: input.evidenceLevel,
      sourceAgent: input.sourceAgent,
    });
    const indexedIds = indexResult.used ? new Set(indexResult.ids) : null;
    if (indexedIds && Array.isArray(input.semanticScores)) {
      for (const item of input.semanticScores) if (item?.id) indexedIds.add(item.id);
    }
    const candidateOrder = indexedIds
      ? Object.fromEntries([...indexedIds].map((id, order) => [id, order])) : null;
    for (const fact of temporal.factCandidates(state, {
      projectId: project.id,
      allProjects,
      asOf: input.asOf,
      includeHistorical: input.includeHistorical === true,
      subject: input.subject,
      predicate: input.predicate,
      topic: input.topic,
      status: input.status,
      assertionType: input.assertionType,
      evidenceLevel: input.evidenceLevel,
      sourceAgent: input.sourceAgent,
      candidateIds: indexedIds,
      candidateOrder,
      indexMatches: indexResult.matches,
    })) candidates.push(fact);
    for (const raw of Array.isArray(externalItems) ? externalItems : []) {
      const text = safeText(raw.text || raw.content, 12000);
      if (!text) continue;
      candidates.push({
        id: safeText(raw.id, 220) || randomId('src'), sourceType: safeText(raw.sourceType, 40) || 'note',
        kind: safeText(raw.kind, 40) || 'note', title: safeText(raw.title, 180) || 'Not', text,
        projectId: raw.projectId || (allProjects ? null : project.id),
        projectName: raw.projectName || (allProjects ? null : project.name),
        status: 'active', importance: clamp(raw.importance, 1, 5, 2), tags: safeList(raw.tags, 20, 50),
        updatedAt: raw.updatedAt || nowIso(), graphBoost: clamp(raw.graphBoost, 0, 20, 0), source: raw.source || {},
      });
    }
    return { project, candidates, allProjects, indexResult };
  }

  function contextMarkdown(items, project, tokenBudget, heading = 'Notlar Sync AI Beyni') {
    const maxChars = clamp(tokenBudget, 300, 8000, DEFAULT_SETTINGS.contextTokenBudget) * 4;
    const lines = [`# ${heading}`, `Proje: ${project.name}`, ''];
    let used = lines.join('\n').length;
    const selected = [];
    for (const item of items) {
      const label = item.kind === 'checkpoint' ? 'Checkpoint' : item.kind;
      const body = safeText(item.text, 1800).replace(/\s+/g, ' ');
      const line = `- [${label}] ${item.title}: ${body}`;
      if (used + line.length > maxChars && selected.length) break;
      lines.push(line.slice(0, Math.max(0, maxChars - used)));
      used = lines.join('\n').length;
      selected.push(item);
      if (used >= maxChars) break;
    }
    if (!selected.length) lines.push('- Bu proje için henüz kalıcı bağlam yok.');
    return { markdown: lines.join('\n'), items: selected, approxTokens: Math.ceil(lines.join('\n').length / 4) };
  }

  // Kullaniciya gosterilebilir "bu kayit neden geldi" cumlesi.
  function whyMatchedText(item) {
    const parts = [];
    const sp = item.scoreParts || {};
    if (sp.lexical > 0) parts.push('sorguyla sözcük eşleşmesi');
    if (item.candidateOrigin === 'local-index') parts.push('yerel indeksten aday');
    if (sp.semantic > 8) parts.push('anlamsal benzerlik');
    if (sp.projectScope > 0) parts.push('bu projenin kapsamında');
    if (sp.graph > 0) parts.push('bilgi grafında bağlantılı');
    if (sp.pinned > 0) parts.push('sabitlenmiş kayıt');
    if (sp.recency > 6) parts.push('güncel kayıt');
    if (item.sourceType === 'fact') {
      if (sp.currentBoost > 0 && item.factStatus === 'active') parts.push('şu an geçerli bilgi');
      if (item.factStatus === 'superseded') parts.push('tarihsel: yerine yenisi geldi');
      if (item.factStatus === 'invalidated') parts.push('geçersiz kılınmış bilgi');
      if (item.factStatus === 'disputed') parts.push('ihtilaflı bilgi — doğrulanmadı');
      if (item.evidenceLevel === 'direct') parts.push('doğrudan kanıt');
      else if (item.evidenceLevel === 'derived') parts.push('türetilmiş kanıt');
      else parts.push('kanıt doğrulanmadı — puan cezası');
      parts.push(`güven ${Number(clamp(item.confidence, 0, 1, 0.7)).toFixed(2)}`);
    }
    return parts.join(' · ') || 'genel bağlam eşleşmesi';
  }

  function recall(input = {}, externalItems = []) {
    const state = load();
    recoverStale(state);
    const asOf = input.asOf && Number.isFinite(Date.parse(input.asOf)) ? new Date(Date.parse(input.asOf)).toISOString() : '';
    const { project, candidates, allProjects, indexResult } = candidatesFor(state, { ...input, asOf }, externalItems);
    let ranked = scoreCandidates(candidates, input.query || input.goal || '', project.id, allProjects, {
      asOf, includeDisputed: input.includeDisputed === true,
    }).map((item) => ({
      ...item,
      score: item.score + (item.graphBoost || 0),
      scoreParts: { ...item.scoreParts, graph: item.graphBoost || 0 },
    }));
    if (Array.isArray(input.semanticScores)) {
      const semantic = new Map(input.semanticScores.map((item) => [item.id, clamp(item.score, -1, 1, 0)]));
      ranked = ranked.map((item) => ({
        ...item,
        semanticScore: semantic.get(item.id) || 0,
        score: item.score + (semantic.get(item.id) || 0) * 35,
        scoreParts: { ...item.scoreParts, semantic: (semantic.get(item.id) || 0) * 35 },
      })).sort((a, b) => b.score - a.score);
    }
    const seenResults = new Set();
    ranked = ranked.filter((item) => {
      const signature = `${item.sourceType}|${normalizeForSearch(item.title)}|${normalizeForSearch(item.text).slice(0, 600)}`;
      if (seenResults.has(signature)) return false;
      seenResults.add(signature);
      return true;
    });
    ranked = ranked.slice(0, clamp(input.limit, 1, 50, 12));
    ranked = ranked.map(({ scoreParts, ...item }) => (input.explain === true
      ? {
        ...item,
        explain: { ...scoreParts, total: item.score },
        whyMatched: whyMatchedText({ ...item, scoreParts }),
      }
      : item));
    if (!input.noTouch) {
      for (const result of ranked) {
        const memory = state.memories.find((item) => item.id === result.id);
        if (memory) { memory.lastAccessedAt = nowIso(); memory.accessCount = (memory.accessCount || 0) + 1; }
      }
      save(state);
    }
    return {
      project,
      query: safeText(input.query || input.goal, 1000),
      asOf: asOf || undefined,
      results: ranked,
      index: {
        engine: indexResult.engine,
        used: !!indexResult.used,
        fallback: !indexResult.used,
        fallbackReason: indexResult.fallbackReason || '',
        candidates: indexResult.ids?.length || 0,
        rebuilt: !!indexResult.rebuilt,
        error: indexResult.error || '',
      },
      context: contextMarkdown(ranked, project, input.tokenBudget || state.settings.contextTokenBudget),
    };
  }

  function startSession(input = {}, externalItems = []) {
    const state = load();
    recoverStale(state);
    const project = projectOf(input);
    const requestedId = safeId(input.sessionId);
    let session = requestedId ? state.sessions.find((item) => item.id === requestedId && item.status === 'active') : null;
    if (!session) {
      let id = requestedId || randomId('ses');
      if (state.sessions.some((item) => item.id === id)) id = `${id}_${crypto.randomBytes(3).toString('hex')}`;
      const at = nowIso();
      session = {
        id,
        agent: safeText(input.agent || 'unknown-agent', 80),
        client: safeText(input.client || 'mcp', 80),
        projectId: project.id,
        projectName: project.name,
        workspace: project.workspace,
        title: safeText(input.title || input.goal || 'Yeni AI oturumu', 180),
        goal: redact(input.goal).text,
        status: 'active',
        startedAt: at,
        heartbeatAt: at,
        endedAt: null,
        eventCount: 0,
        redactions: redact(input.goal).redactions,
      };
      state.sessions.push(session);
    } else {
      session.heartbeatAt = nowIso();
      if (input.goal) session.goal = redact(input.goal).text;
      if (input.title) session.title = safeText(input.title, 180);
    }
    save(state);
    const result = recall({ ...input, projectKey: project.id, project: project.name, workspace: project.workspace, query: input.goal || input.query || '', tokenBudget: input.tokenBudget }, externalItems);
    return { session, context: result.context, project };
  }

  function heartbeat(input = {}) {
    const state = load();
    const id = safeId(input.sessionId);
    const session = state.sessions.find((item) => item.id === id);
    if (!session) throw new Error('oturum bulunamadi');
    if (session.status !== 'active') throw new Error('oturum aktif degil');
    session.heartbeatAt = nowIso();
    if (input.activity) session.lastActivity = safeText(input.activity, 240);
    save(state);
    return session;
  }

  function remember(input = {}) {
    const state = load();
    const session = safeId(input.sessionId) ? state.sessions.find((item) => item.id === safeId(input.sessionId)) : null;
    const memory = upsertMemoryInState(state, input, {
      agent: input.agent || session?.agent,
      client: input.client || session?.client,
      sessionId: session?.id || input.sessionId,
      checkpointId: input.checkpointId,
    });
    save(state);
    return memory;
  }

  function recordEvent(input = {}) {
    const state = load();
    const id = safeId(input.sessionId);
    const session = state.sessions.find((item) => item.id === id);
    if (!session) throw new Error('oturum bulunamadi');
    if (session.status !== 'active') throw new Error('oturum aktif degil');
    const type = EVENT_TYPES.has(input.type) ? input.type : 'note';
    const cleaned = redact(input.content || input.summary);
    if (!cleaned.text) throw new Error('olay icerigi bos');
    const event = {
      id: randomId('evt'), sessionId: session.id, projectId: session.projectId,
      type, content: cleaned.text, importance: clamp(input.importance, 1, 5, 2),
      tags: safeList(input.tags, 16, 50), files: safeList(input.files, 50, 700),
      createdAt: nowIso(), redactions: cleaned.redactions,
    };
    if (input.remember || ['decision', 'preference', 'fact', 'task'].includes(type)) {
      event.memoryId = upsertMemoryInState(state, {
        ...input,
        projectKey: session.projectId,
        project: session.projectName,
        workspace: session.workspace,
        kind: type === 'note' ? 'fact' : type,
        content: cleaned.text,
      }, { agent: session.agent, client: session.client, sessionId: session.id }).id;
    }
    // Olay uzerinden acik fact yazimi: olay kimligi provenance olarak tasinir.
    let factChanges = null;
    if (input.fact && typeof input.fact === 'object') {
      const factResult = temporal.upsertFact(state, input.fact, {
        agent: session.agent, client: session.client, sessionId: session.id, eventId: event.id,
      }, { id: session.projectId, name: session.projectName, workspace: session.workspace });
      event.factId = factResult.fact.id;
      factChanges = { changedIds: factResult.affectedIds || [factResult.fact.id] };
    }
    appendEvent(session.id, event);
    session.eventCount = (session.eventCount || 0) + 1;
    session.heartbeatAt = event.createdAt;
    session.redactions = (session.redactions || 0) + cleaned.redactions;
    session.lastActivity = cleaned.text.slice(0, 240);
    save(state, factChanges);
    return event;
  }

  function createCheckpointInState(state, input, session) {
    const summaryValue = redact(input.summary || session.lastActivity || session.goal || 'Oturum checkpointi');
    const rollingKey = safeId(input.rollingKey, 80);
    let checkpoint = rollingKey
      ? state.checkpoints.find((item) => item.sessionId === session.id && item.rollingKey === rollingKey)
      : null;
    const createdAt = nowIso();
    if (!checkpoint) checkpoint = { id: randomId('chk'), firstCreatedAt: createdAt };
    Object.assign(checkpoint, {
      sessionId: session.id,
      projectId: session.projectId,
      projectName: session.projectName,
      agent: session.agent,
      title: safeText(input.title || session.title || 'Oturum checkpointi', 180),
      summary: summaryValue.text,
      completed: safeList(input.completed, 50, 700),
      files: safeList(input.files, 100, 700),
      decisions: safeList(input.decisions, 40, 700).map((item) => redact(item).text),
      openTasks: safeList(input.openTasks || input.tasks, 40, 700).map((item) => redact(item).text),
      risks: safeList(input.risks, 30, 700).map((item) => redact(item).text),
      nextStep: redact(input.nextStep).text,
      tags: safeList(input.tags, 20, 50),
      rollingKey: rollingKey || null,
      createdAt,
      redactions: summaryValue.redactions,
    });
    if (!state.checkpoints.some((item) => item.id === checkpoint.id)) state.checkpoints.push(checkpoint);
    session.lastCheckpointId = checkpoint.id;
    session.heartbeatAt = checkpoint.createdAt;
    session.lastActivity = checkpoint.summary.slice(0, 240);
    for (const decision of checkpoint.decisions) {
      upsertMemoryInState(state, {
        projectKey: session.projectId, project: session.projectName, workspace: session.workspace,
        kind: 'decision', content: decision, importance: 4, sessionId: session.id, checkpointId: checkpoint.id,
      }, { agent: session.agent, client: session.client, sessionId: session.id, checkpointId: checkpoint.id });
    }
    for (const task of checkpoint.openTasks) {
      upsertMemoryInState(state, {
        projectKey: session.projectId, project: session.projectName, workspace: session.workspace,
        kind: 'task', content: task, status: 'open', importance: 3, sessionId: session.id, checkpointId: checkpoint.id,
      }, { agent: session.agent, client: session.client, sessionId: session.id, checkpointId: checkpoint.id });
    }
    checkpoint.factIds = temporal.factsFromCheckpoint(state, checkpoint, session);
    return checkpoint;
  }

  function checkpoint(input = {}) {
    const state = load();
    const id = safeId(input.sessionId);
    const session = state.sessions.find((item) => item.id === id);
    if (!session) throw new Error('oturum bulunamadi');
    if (session.status !== 'active') throw new Error('oturum aktif degil');
    const value = createCheckpointInState(state, input, session);
    save(state, { changedIds: value.factIds || [] });
    return value;
  }

  function endSession(input = {}) {
    const state = load();
    const id = safeId(input.sessionId);
    const session = state.sessions.find((item) => item.id === id);
    if (!session) throw new Error('oturum bulunamadi');
    let finalCheckpoint = null;
    if (input.summary || input.completed || input.nextStep || input.openTasks || input.decisions) {
      finalCheckpoint = createCheckpointInState(state, input, session);
    }
    session.status = SESSION_STATUSES.has(input.status) && input.status !== 'active' ? input.status : 'ended';
    session.endedAt = nowIso();
    session.heartbeatAt = session.endedAt;
    session.endReason = safeText(input.reason || 'normal', 80);
    save(state, finalCheckpoint ? { changedIds: finalCheckpoint.factIds || [] } : null);
    return { session, checkpoint: finalCheckpoint };
  }

  function listMemories(input = {}) {
    const state = load();
    const project = projectOf(input);
    const query = normalizeForSearch(input.query);
    return state.memories
      .filter((item) => input.includeForgotten || item.status !== 'forgotten')
      .filter((item) => input.scope === 'global' ? item.scope === 'global' : (!item.projectId || item.projectId === project.id))
      .filter((item) => !input.kind || item.kind === input.kind)
      .filter((item) => !input.status || item.status === input.status)
      .filter((item) => !query || normalizeForSearch(`${item.key} ${item.content} ${(item.tags || []).join(' ')}`).includes(query))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0))
      .slice(0, clamp(input.limit, 1, 500, 100));
  }

  function forget(input = {}) {
    const state = load();
    const id = safeId(input.id);
    const mode = input.mode === 'hard' || input.hard === true ? 'hard' : 'soft';
    if (mode === 'hard' && input.confirm !== 'KALICI OLARAK UNUT') {
      throw new Error('hard forget icin KALICI OLARAK UNUT yazin');
    }
    const index = state.memories.findIndex((item) => item.id === id);
    if (index === -1) {
      // Ayni unutma kapisi temporal fact'ler icin de calisir.
      const originalFact = state.facts.find((item) => item.id === id);
      const embeddingRecordsRemoved = purgeEmbeddingCache([factEmbeddingText(originalFact)]);
      const factResult = temporal.forgetFact(state, { ...input, mode });
      if (!factResult) throw new Error('hafiza bulunamadi');
      const indexResult = save(state, {
        changedIds: factResult.changedIds,
        removedIds: factResult.removedIds,
        purge: true,
      });
      return {
        ...factResult,
        indexRecordsRemoved: indexResult?.recordsRemoved || 0,
        embeddingRecordsRemoved,
        index: indexResult,
      };
    }
    const originalMemory = state.memories[index];
    const sourcedFacts = state.facts.filter((fact) => fact.migrationKey === id);
    const embeddingRecordsRemoved = purgeEmbeddingCache([
      memoryEmbeddingText(originalMemory), ...sourcedFacts.map(factEmbeddingText),
    ]);
    if (mode === 'hard') state.memories.splice(index, 1);
    else {
      state.memories[index].status = 'forgotten';
      state.memories[index].forgottenAt = nowIso();
      state.memories[index].forgetReason = safeText(redact(input.reason).text, 240);
      state.memories[index].content = '[UNUTULDU]';
      state.memories[index].key = 'Unutulmuş hafıza';
      state.memories[index].tags = [];
    }
    // Bu hafizadan migrationla turetilen fact'ler de kaynaklariyla unutulur.
    const facts = temporal.forgetFactsBySource(state, { memoryId: id, mode });
    const indexResult = facts.factsForgotten || facts.factsRemoved
      ? save(state, { changedIds: facts.changedIds, removedIds: facts.removedIds, purge: true })
      : save(state);
    return {
      ok: true, id, mode, hard: mode === 'hard',
      factsForgotten: facts.factsForgotten,
      factsRemoved: facts.factsRemoved,
      relationsCleaned: facts.relationsCleaned,
      indexRecordsRemoved: indexResult?.recordsRemoved || 0,
      embeddingRecordsRemoved,
      index: indexResult,
    };
  }

  function deleteSession(input = {}) {
    const state = load();
    const id = safeId(input.sessionId || input.id);
    const session = state.sessions.find((item) => item.id === id);
    if (!session) throw new Error('oturum bulunamadi');
    const sourceFacts = state.facts.filter((item) => item.source?.sessionId === id);
    const sourceMemories = state.memories.filter((item) => item.source?.sessionId === id && !item.pinned);
    const embeddingRecordsRemoved = purgeEmbeddingCache([
      ...sourceFacts.map(factEmbeddingText), ...sourceMemories.map(memoryEmbeddingText),
    ]);
    state.sessions = state.sessions.filter((item) => item.id !== id);
    state.checkpoints = state.checkpoints.filter((item) => item.sessionId !== id);
    state.memories = state.memories.filter((item) => item.source?.sessionId !== id || item.pinned);
    const facts = temporal.forgetFactsBySource(state, { sessionId: id, mode: 'hard' });
    try { fs.unlinkSync(path.join(eventsDir, `${id}.jsonl`)); } catch {}
    const indexResult = facts.factsRemoved
      ? save(state, { changedIds: facts.changedIds, removedIds: facts.removedIds, purge: true })
      : save(state);
    return {
      ok: true, id, factsRemoved: facts.factsRemoved, relationsCleaned: facts.relationsCleaned,
      embeddingRecordsRemoved, index: indexResult,
    };
  }

  function updateSettings(input = {}) {
    const state = load();
    if (input.contextTokenBudget !== undefined) state.settings.contextTokenBudget = clamp(input.contextTokenBudget, 500, 8000, DEFAULT_SETTINGS.contextTokenBudget);
    if (input.retentionDays !== undefined) state.settings.retentionDays = clamp(input.retentionDays, 1, 3650, DEFAULT_SETTINGS.retentionDays);
    if (input.transcriptMode !== undefined) {
      if (!['off', 'summaries', 'full'].includes(input.transcriptMode)) throw new Error('gecersiz transcript modu');
      state.settings.transcriptMode = input.transcriptMode;
    }
    if (input.autoCapture !== undefined) state.settings.autoCapture = !!input.autoCapture;
    save(state);
    return state.settings;
  }

  function recordFact(input = {}) {
    const state = load();
    const project = input.scope === 'global' ? null : projectOf(input);
    const session = safeId(input.sessionId) ? state.sessions.find((item) => item.id === safeId(input.sessionId)) : null;
    const result = temporal.upsertFact(state, input, {
      agent: input.agent || session?.agent,
      client: input.client || session?.client,
      sessionId: session?.id || safeId(input.sessionId),
      checkpointId: input.checkpointId,
      eventId: input.eventId,
      noteId: input.noteId,
      file: input.file,
    }, project);
    result.index = save(state, { changedIds: result.affectedIds || [result.fact.id] });
    return result;
  }

  function listFacts(input = {}) {
    const state = load();
    const project = projectOf(input);
    return temporal.selectFacts(state, {
      projectId: project.id,
      allProjects: input.allProjects === true,
      subject: input.subject,
      predicate: input.predicate,
      status: input.status,
      query: input.query || input.q,
      asOf: input.asOf,
      includeHistorical: input.includeHistorical === true,
      assertionType: input.assertionType,
      evidenceLevel: input.evidenceLevel,
      sourceAgent: input.sourceAgent,
      includeForgotten: input.includeForgotten === true,
      limit: input.limit,
    });
  }

  function invalidateFact(input = {}) {
    const state = load();
    const fact = temporal.invalidateFact(state, input);
    save(state, { changedIds: [fact.id] });
    return fact;
  }

  function disputeFact(input = {}) {
    const state = load();
    const fact = temporal.disputeFact(state, input);
    const changedIds = state.facts.filter((item) => item.id === fact.id
      || (fact.contradictionGroup && item.contradictionGroup === fact.contradictionGroup)).map((item) => item.id);
    save(state, { changedIds });
    return fact;
  }

  function suggestFactConflicts(input = {}) {
    const state = load();
    const project = input.scope === 'global' ? null : projectOf(input);
    const candidate = {
      id: '',
      projectId: input.scope === 'global' ? null : project.id,
      workspace: input.scope === 'global' ? '' : project.workspace,
      subject: safeText(redact(input.subject).text, 200),
      predicate: safeText(redact(input.predicate).text, 80) || 'durum',
      object: safeText(redact(input.object).text, 700),
      value: safeText(redact(input.value).text, 2000),
      topic: safeText(redact(input.topic).text, 80) || null,
      confidence: clamp(input.confidence, 0, 1, 0.7),
      conflictDismissals: safeList(input.conflictDismissals, 40, 120),
    };
    candidate.slot = temporal.factSlot(candidate);
    return { suggestions: temporal.suggestFactConflicts(state, candidate, input) };
  }

  function resolveFactConflict(input = {}) {
    const state = load();
    const result = temporal.resolveFactConflict(state, input);
    result.index = save(state, { changedIds: result.affectedIds });
    return result;
  }

  function factTimeline(input = {}) {
    const state = load();
    const project = projectOf(input);
    return temporal.timeline(state, {
      ...input,
      projectId: project.id,
      allProjects: input.allProjects === true || (!input.project && !input.workspace && !input.projectKey && !input.projectId),
    });
  }

  function factProvenance(id) {
    const state = load();
    return temporal.provenance(state, id, readEvents);
  }

  function migrateFacts() {
    const state = load();
    const result = temporal.migrateMemories(state);
    result.index = save(state, { forceRebuild: true });
    return result;
  }

  function rebuildFactIndex() {
    const state = load();
    return factIndex.rebuild(state);
  }

  function factIndexStatus() {
    const state = load();
    return factIndex.status(state);
  }

  function overview(input = {}) {
    const state = load();
    const changed = recoverStale(state);
    if (changed) save(state);
    const project = projectOf(input);
    const sessions = state.sessions.filter((item) => !input.project || item.projectId === project.id)
      .sort((a, b) => Date.parse(b.startedAt || 0) - Date.parse(a.startedAt || 0));
    const checkpoints = state.checkpoints.filter((item) => !input.project || item.projectId === project.id)
      .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
    const memories = state.memories.filter((item) => item.status !== 'forgotten' && (!item.projectId || !input.project || item.projectId === project.id));
    const facts = temporal.selectFacts(state, {
      projectId: project.id,
      allProjects: !input.project,
      includeHistorical: true,
      includeForgotten: true,
      limit: clamp(input.factLimit, 1, 300, 60),
    });
    const countsByKind = {};
    for (const item of memories) countsByKind[item.kind] = (countsByKind[item.kind] || 0) + 1;
    const connected = memories.filter((item) => item.source?.sessionId || item.tags?.length).length;
    return {
      version: VERSION,
      project,
      settings: state.settings,
      stats: {
        memories: memories.length,
        sessions: sessions.length,
        activeSessions: sessions.filter((item) => item.status === 'active').length,
        interruptedSessions: sessions.filter((item) => item.status === 'interrupted').length,
        checkpoints: checkpoints.length,
        openTasks: memories.filter((item) => item.kind === 'task' && item.status === 'open').length,
        decisions: memories.filter((item) => item.kind === 'decision').length,
        preferences: memories.filter((item) => item.kind === 'preference').length,
        facts: facts.filter((item) => item.status === 'active').length,
        disputedFacts: facts.filter((item) => item.status === 'disputed').length,
        historicalFacts: facts.filter((item) => ['superseded', 'invalidated'].includes(item.status)).length,
        health: memories.length ? Math.round((connected / memories.length) * 100) : 100,
        byKind: countsByKind,
      },
      sessions: sessions.slice(0, clamp(input.sessionLimit, 1, 100, 20)),
      checkpoints: checkpoints.slice(0, clamp(input.checkpointLimit, 1, 100, 20)),
      memories: memories.sort((a, b) => Number(b.pinned) - Number(a.pinned) || Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0)).slice(0, clamp(input.memoryLimit, 1, 200, 40)),
      facts,
    };
  }

  function graph(input = {}) {
    const data = overview({ ...input, sessionLimit: 80, checkpointLimit: 120, memoryLimit: 240, factLimit: 160 });
    const projects = new Map();
    const addProject = (id, name, workspace = '') => {
      if (!id || projects.has(id)) return;
      projects.set(id, { id, name: name || 'Adsız proje', workspace });
    };
    if (input.project) addProject(data.project.id, data.project.name, data.project.workspace);
    for (const session of data.sessions) addProject(session.projectId, session.projectName, session.workspace);
    for (const checkpoint of data.checkpoints) addProject(checkpoint.projectId, checkpoint.projectName);
    for (const item of data.memories) addProject(item.projectId, item.projectName);
    for (const fact of data.facts) addProject(fact.projectId, fact.projectName);
    if (!projects.size) addProject(data.project.id, data.project.name, data.project.workspace);

    const hasGlobal = data.memories.some((item) => !item.projectId) || data.facts.some((item) => !item.projectId);
    const nodes = [...projects.values()].map((project) => ({
      id: project.id,
      label: project.name,
      type: 'project',
      description: project.workspace || 'AI hafıza projesi',
      projectId: project.id,
    }));
    if (hasGlobal) nodes.push({ id: 'scope:global', label: 'Kalıcı tercihler', type: 'global', description: 'Tüm projelerde kullanılan hafıza' });
    const edges = [];
    for (const session of data.sessions) {
      nodes.push({ id: `session:${session.id}`, label: session.title, type: 'session', description: session.goal || session.lastActivity || '', agent: session.agent, status: session.status, updatedAt: session.heartbeatAt, projectId: session.projectId });
      edges.push({ source: `session:${session.id}`, target: projects.has(session.projectId) ? session.projectId : data.project.id, relation: 'oturum' });
    }
    for (const checkpoint of data.checkpoints) {
      nodes.push({ id: `checkpoint:${checkpoint.id}`, label: checkpoint.title, type: 'checkpoint', description: checkpoint.summary, agent: checkpoint.agent, updatedAt: checkpoint.createdAt, projectId: checkpoint.projectId });
      const sessionTarget = data.sessions.some((session) => session.id === checkpoint.sessionId)
        ? `session:${checkpoint.sessionId}`
        : checkpoint.projectId;
      edges.push({ source: `checkpoint:${checkpoint.id}`, target: sessionTarget, relation: 'checkpoint' });
    }
    for (const item of data.memories) {
      nodes.push({
        id: `memory:${item.id}`,
        label: item.key,
        type: item.kind === 'project' ? 'project-memory' : item.kind,
        memoryKind: item.kind,
        description: item.content,
        status: item.status,
        pinned: item.pinned,
        updatedAt: item.updatedAt,
        projectId: item.projectId || null,
        global: !item.projectId,
      });
      const sourceSession = item.source?.sessionId && data.sessions.some((session) => session.id === item.source.sessionId);
      const projectTarget = item.projectId && projects.has(item.projectId) ? item.projectId : (hasGlobal && !item.projectId ? 'scope:global' : data.project.id);
      edges.push({ source: `memory:${item.id}`, target: sourceSession ? `session:${item.source.sessionId}` : projectTarget, relation: item.kind });
    }
    const factIds = new Set(data.facts.map((fact) => `fact:${fact.id}`));
    for (const fact of data.facts) {
      nodes.push({
        id: `fact:${fact.id}`,
        label: `${fact.subject}: ${fact.object || fact.value}`.slice(0, 120),
        type: 'tfact',
        description: fact.value || fact.object,
        subject: fact.subject,
        predicate: fact.predicate,
        factStatus: fact.status,
        status: fact.status,
        confidence: fact.confidence,
        assertionType: fact.assertionType,
        evidenceLevel: fact.evidenceLevel,
        validFrom: fact.validFrom,
        validTo: fact.validTo,
        contradictionGroup: fact.contradictionGroup,
        supersedes: fact.supersedes || [],
        supersededBy: fact.supersededBy || [],
        updatedAt: fact.observedAt || fact.recordedAt,
        projectId: fact.projectId || null,
        global: !fact.projectId,
        source: fact.source,
        tombstone: !!fact.tombstone,
        conflictSuggestions: fact.conflictSuggestions || [],
      });
      const sourceSession = fact.source?.sessionId && data.sessions.some((session) => session.id === fact.source.sessionId);
      const projectTarget = fact.projectId && projects.has(fact.projectId) ? fact.projectId : (hasGlobal && !fact.projectId ? 'scope:global' : data.project.id);
      edges.push({ source: `fact:${fact.id}`, target: sourceSession ? `session:${fact.source.sessionId}` : projectTarget, relation: 'fact' });
      for (const oldId of fact.supersedes || []) {
        if (factIds.has(`fact:${oldId}`)) edges.push({ source: `fact:${fact.id}`, target: `fact:${oldId}`, relation: 'yerine geçti' });
      }
    }
    return { project: data.project, projects: [...projects.values()], stats: data.stats, nodes, edges };
  }

  return {
    root,
    stateFile,
    projectOf,
    startSession,
    heartbeat,
    recordEvent,
    checkpoint,
    endSession,
    remember,
    recall,
    listMemories,
    forget,
    deleteSession,
    updateSettings,
    overview,
    graph,
    readEvents,
    load,
    recordFact,
    listFacts,
    invalidateFact,
    disputeFact,
    suggestFactConflicts,
    resolveFactConflict,
    factTimeline,
    factProvenance,
    migrateFacts,
    rebuildFactIndex,
    factIndexStatus,
  };
}

module.exports = {
  VERSION,
  DEFAULT_SETTINGS,
  KINDS,
  EVENT_TYPES,
  createStore,
  redact,
  normalizeForSearch,
  cosine,
};
