'use strict';

// Notlar Sync peer replikasyonu.
//
// Her bilgisayar kendi ~/NotlarSync/notes kopyasini canonical olarak tutar.
// Not bazli vector clock sayesinde bir taraf kapaliyken yapilan degisiklikler
// yeniden baglaninca nedensel olarak birlesir. Eszamanli iki farkli icerikte
// sessiz last-write-wins yerine deterministik ana surum + cakisma kopyasi
// uretilir. Peer tokenlari yalniz sync/peers.json (0600) icinde saklanir.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const STATE_VERSION = 1;
const PAIR_TTL_MS = 3 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_CHANGE_LIMIT = 5000;
const MAX_JSON_BYTES = 5 * 1024 * 1024;
const MAX_NOTE_BYTES = 10 * 1024 * 1024;
const MAX_VECTOR_ACTORS = 256;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

const clone = (value) => JSON.parse(JSON.stringify(value));
const randomToken = (prefix = 'sync') => `${prefix}_${crypto.randomBytes(32).toString('base64url')}`;
const hashToken = (value) => crypto.createHash('sha256').update(String(value || '')).digest('hex');
const hashContent = (value) => crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
const validId = (value) => /^[A-Za-z0-9_-]{1,128}$/.test(String(value || ''));
const validToken = (value, prefix) => new RegExp(`^${prefix}_[A-Za-z0-9_-]{40,100}$`).test(String(value || ''));
const safeLabel = (value, fallback = 'Cihaz') => {
  const clean = String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return clean || fallback;
};
const secureEqual = (a, b) => {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
};

function atomicWrite(file, data, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(file), 0o700); } catch {}
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  fs.writeFileSync(temp, data, { encoding: 'utf8', mode });
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes(error.code) || !fs.existsSync(file)) {
      try { fs.unlinkSync(temp); } catch {}
      throw error;
    }
    fs.unlinkSync(file);
    fs.renameSync(temp, file);
  }
  try { fs.chmodSync(file, mode); } catch {}
}

function safePart(value) {
  if (typeof value !== 'string') return '';
  const clean = value.normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 120);
  return !clean || clean === '.' || clean === '..' || clean.startsWith('.') || WINDOWS_RESERVED.test(clean) ? '' : clean;
}

function safeNoteId(value) {
  if (typeof value !== 'string') return '';
  const raw = value.normalize('NFC').replace(/\\/g, '/').trim().replace(/^\/+|\/+$/g, '');
  const parts = raw.split('/');
  if (!raw || parts.length > 16 || parts.some((part) => !part || part === '.' || part === '..')) return '';
  const clean = parts.map(safePart);
  return clean.every(Boolean) ? clean.join('/') : '';
}

function normalizeVector(value) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  const entries = Object.entries(value);
  if (entries.length > MAX_VECTOR_ACTORS) return out;
  for (const [key, raw] of entries) {
    const id = String(key || '').slice(0, 128);
    const counter = Number(raw);
    if (validId(id) && Number.isSafeInteger(counter) && counter >= 0) out[id] = counter;
  }
  return out;
}

function compareVectors(localValue, remoteValue) {
  const local = normalizeVector(localValue);
  const remote = normalizeVector(remoteValue);
  const keys = new Set([...Object.keys(local), ...Object.keys(remote)]);
  let localGreater = false;
  let remoteGreater = false;
  for (const key of keys) {
    const a = local[key] || 0;
    const b = remote[key] || 0;
    if (a > b) localGreater = true;
    if (b > a) remoteGreater = true;
  }
  if (localGreater && remoteGreater) return 'concurrent';
  if (localGreater) return 'local';
  if (remoteGreater) return 'remote';
  return 'equal';
}

function mergeVectors(aValue, bValue) {
  const a = normalizeVector(aValue);
  const b = normalizeVector(bValue);
  const out = { ...a };
  for (const [key, value] of Object.entries(b)) out[key] = Math.max(out[key] || 0, value);
  return out;
}

function normalizeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 500) throw new Error('gecersiz cihaz adresi');
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('gecersiz cihaz adresi');
  if (!url.hostname || url.hash || url.search) throw new Error('gecersiz cihaz adresi');
  return url.origin;
}

async function responseTextLimited(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length')) || 0;
  if (declared > maxBytes) throw new Error('peer cevabi cok buyuk');
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw new Error('peer cevabi cok buyuk');
    return text;
  }
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    size += chunk.length;
    if (size > maxBytes) {
      try { await reader.cancel(); } catch {}
      throw new Error('peer cevabi cok buyuk');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

function notePath(notesDir, name) {
  const safe = safeNoteId(name);
  if (!safe) throw new Error('gecersiz not yolu');
  const parts = safe.split('/');
  return path.join(notesDir, ...parts.slice(0, -1), parts.at(-1) + '.md');
}

function walkNotes(notesDir, dir = notesDir, prefix = '') {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walkNotes(notesDir, path.join(dir, entry.name), relative));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(relative.slice(0, -3));
  }
  return out;
}

function normalizeRecord(value) {
  if (!value || typeof value !== 'object') return null;
  const name = safeNoteId(String(value.name || ''));
  const vector = normalizeVector(value.vector);
  const deleted = !!value.deleted;
  const hash = deleted ? '' : String(value.hash || '').toLowerCase();
  if (!name || (!deleted && !/^[a-f0-9]{64}$/.test(hash)) || !Object.keys(vector).length) return null;
  return {
    name,
    vector,
    hash,
    deleted,
    updatedAt: Math.max(0, Number(value.updatedAt) || 0),
    origin: String(value.origin || '').slice(0, 128),
    revision: Math.max(0, Number(value.revision) || 0),
    conflict: !!value.conflict,
  };
}

function publicPeer(peer) {
  return {
    id: peer.id,
    name: peer.name,
    url: peer.url,
    cursor: Number(peer.cursor) || 0,
    paused: !!peer.paused,
    lastSeen: peer.lastSeen || null,
    lastSync: peer.lastSync || null,
    lastError: peer.lastError || '',
    failures: Number(peer.failures) || 0,
    online: !peer.paused && !!peer.lastSeen && Date.now() - Number(peer.lastSeen) < 30000 && !peer.lastError,
  };
}

function createReplica(options = {}) {
  const dataDir = path.resolve(options.dataDir || path.join(os.homedir(), 'NotlarSync'));
  const notesDir = path.resolve(options.notesDir || path.join(dataDir, 'notes'));
  const syncDir = path.join(dataDir, 'sync');
  const blobsDir = path.join(syncDir, 'blobs');
  const stateFile = path.join(syncDir, 'state.json');
  const peersFile = path.join(syncDir, 'peers.json');
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const onApplied = typeof options.onApplied === 'function' ? options.onApplied : () => {};
  const onSync = typeof options.onSync === 'function' ? options.onSync : () => {};
  const beforeSync = typeof options.beforeSync === 'function' ? options.beforeSync : async () => {};
  const configuredInterval = Number(options.intervalMs ?? process.env.NOTLAR_SYNC_INTERVAL_MS);
  const intervalMs = Number.isFinite(configuredInterval) && configuredInterval > 0
    ? Math.max(250, configuredInterval)
    : DEFAULT_INTERVAL_MS;
  const configuredChangeLimit = Number(options.maxChanges ?? process.env.NOTLAR_SYNC_CHANGE_LIMIT);
  const changeLimit = Number.isInteger(configuredChangeLimit) && configuredChangeLimit > 0
    ? Math.min(10000, configuredChangeLimit)
    : DEFAULT_CHANGE_LIMIT;

  fs.mkdirSync(notesDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(syncDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(blobsDir, { recursive: true, mode: 0o700 });
  for (const dir of [dataDir, notesDir, syncDir, blobsDir]) try { fs.chmodSync(dir, 0o700); } catch {}

  let loadedState = null;
  try { loadedState = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
  const requestedDeviceId = validId(String(options.deviceId || '').trim()) ? String(options.deviceId).trim() : '';
  const persistedDeviceId = validId(String(loadedState?.deviceId || '').trim()) ? String(loadedState.deviceId).trim() : '';
  const deviceId = requestedDeviceId || persistedDeviceId || `peer_${crypto.randomBytes(12).toString('hex')}`;
  const deviceName = safeLabel(options.deviceName || loadedState?.deviceName || os.hostname(), 'Notlar Sync');
  const state = {
    version: STATE_VERSION,
    deviceId,
    deviceName,
    counter: Math.max(0, Number(loadedState?.counter) || 0),
    revision: Math.max(0, Number(loadedState?.revision) || 0),
    notes: {},
  };
  if (loadedState?.notes && typeof loadedState.notes === 'object') {
    for (const value of Object.values(loadedState.notes)) {
      const record = normalizeRecord(value);
      if (!record) continue;
      state.notes[record.name] = record;
      state.revision = Math.max(state.revision, record.revision);
      state.counter = Math.max(state.counter, record.vector[deviceId] || 0);
    }
  }

  let peers = [];
  try {
    const raw = JSON.parse(fs.readFileSync(peersFile, 'utf8'));
    if (Array.isArray(raw)) peers = raw.filter((peer) => peer && validId(peer.id) && peer.url
      && validToken(peer.outboundToken, 'peer') && /^[a-f0-9]{64}$/.test(String(peer.inboundTokenHash || ''))).map((peer) => ({
        id: String(peer.id).slice(0, 128),
        name: safeLabel(peer.name),
        url: normalizeUrl(peer.url),
        outboundToken: String(peer.outboundToken),
        inboundTokenHash: String(peer.inboundTokenHash),
        cursor: Math.max(0, Number(peer.cursor) || 0),
        paused: !!peer.paused,
        lastSeen: Number(peer.lastSeen) || null,
        lastSync: Number(peer.lastSync) || null,
        lastError: String(peer.lastError || '').slice(0, 300),
        failures: Math.max(0, Number(peer.failures) || 0),
        nextAttemptAt: Math.max(0, Number(peer.nextAttemptAt) || 0),
      }));
  } catch {}

  const pairSessions = new Map();
  const pendingOutgoing = new Map();
  const syncing = new Set();
  let timer = null;
  let closed = false;

  const saveState = () => atomicWrite(stateFile, JSON.stringify(state, null, 2));
  const savePeers = () => atomicWrite(peersFile, JSON.stringify(peers, null, 2));
  const nextCounter = () => ++state.counter;
  const stampRecord = (record) => {
    state.revision++;
    record.revision = state.revision;
    state.notes[record.name] = record;
    return record;
  };
  const persistRecord = (record) => {
    stampRecord(record);
    saveState();
    return clone(record);
  };
  const readContent = (name) => fs.readFileSync(notePath(notesDir, name), 'utf8');
  const blobPath = (hash) => path.join(blobsDir, String(hash || '').toLowerCase());
  const storeBlob = (content, expectedHash) => {
    const text = String(content);
    const hash = hashContent(text);
    if (expectedHash && hash !== expectedHash) throw new Error('icerik ozeti uyusmuyor');
    const file = blobPath(hash);
    if (!fs.existsSync(file)) atomicWrite(file, text, 0o600);
    else try { fs.chmodSync(file, 0o600); } catch {}
    return hash;
  };
  const readVersion = (name, expectedHash) => {
    const hash = String(expectedHash || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('gecersiz icerik ozeti');
    try {
      const current = readContent(name);
      if (hashContent(current) === hash) return current;
    } catch {}
    const content = fs.readFileSync(blobPath(hash), 'utf8');
    if (hashContent(content) !== hash) throw new Error('surum blobu bozuk');
    return content;
  };
  const writeContent = (name, content) => {
    const file = notePath(notesDir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    for (let dir = path.dirname(file); dir.startsWith(notesDir); dir = path.dirname(dir)) {
      try { fs.chmodSync(dir, 0o700); } catch {}
      if (dir === notesDir) break;
    }
    const text = String(content);
    storeBlob(text);
    atomicWrite(file, text, 0o600);
  };
  const removeContent = (name) => {
    try { fs.unlinkSync(notePath(notesDir, name)); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  };

  function localRecord(name, deleted, content, persist = true) {
    const safe = safeNoteId(name);
    if (!safe) throw new Error('gecersiz not yolu');
    const current = state.notes[safe] || null;
    const hash = deleted ? '' : hashContent(content);
    if (current && current.deleted === deleted && current.hash === hash) return clone(current);
    if (!deleted) storeBlob(content, hash);
    const vector = { ...(current?.vector || {}) };
    vector[deviceId] = nextCounter();
    const record = {
      name: safe,
      vector,
      hash,
      deleted,
      updatedAt: now(),
      origin: deviceId,
      revision: 0,
      conflict: false,
    };
    stampRecord(record);
    if (persist) saveState();
    return clone(record);
  }

  function noteChanged(name) {
    const safe = safeNoteId(name);
    if (!safe) throw new Error('gecersiz not yolu');
    const content = readContent(safe);
    return localRecord(safe, false, content, true);
  }

  function noteDeleted(name) {
    return localRecord(name, true, '', true);
  }

  function scan() {
    const existing = new Set(walkNotes(notesDir));
    let changed = false;
    for (const name of existing) {
      const content = readContent(name);
      const current = state.notes[name];
      const hash = hashContent(content);
      if (current && !current.deleted && current.hash === hash) continue;
      localRecord(name, false, content, false);
      changed = true;
    }
    for (const [name, record] of Object.entries(state.notes)) {
      if (record.deleted || existing.has(name)) continue;
      localRecord(name, true, '', false);
      changed = true;
    }
    if (changed || !fs.existsSync(stateFile)) saveState();
    return changed;
  }

  function changes(sinceValue = 0) {
    const since = Math.max(0, Number(sinceValue) || 0);
    const full = since === 0 || since > state.revision;
    const candidates = Object.values(state.notes)
      .filter((record) => full || record.revision > since)
      .sort((a, b) => a.revision - b.revision || a.name.localeCompare(b.name, 'tr'));
    const more = candidates.length > changeLimit;
    const records = candidates.slice(0, changeLimit).map(clone);
    const revision = more && records.length ? records.at(-1).revision : state.revision;
    return { version: STATE_VERSION, deviceId, revision, headRevision: state.revision, full, more, records };
  }

  function conflictName(name, loser) {
    const slash = name.lastIndexOf('/');
    const parent = slash >= 0 ? name.slice(0, slash + 1) : '';
    const base = (slash >= 0 ? name.slice(slash + 1) : name).slice(0, 78).trim();
    const origin = String(loser.origin || 'cihaz').replace(/[^a-zA-Z0-9_-]/g, '').slice(-12) || 'cihaz';
    return `${parent}${base} - çakışma ${origin}-${String(loser.hash || 'silindi').slice(0, 8)}`;
  }

  function recordRank(record) {
    return [Number(record.updatedAt) || 0, String(record.origin || ''), String(record.hash || '')];
  }

  function remoteWins(local, remote) {
    const a = recordRank(local);
    const b = recordRank(remote);
    for (let i = 0; i < a.length; i++) {
      if (a[i] === b[i]) continue;
      return b[i] > a[i];
    }
    return false;
  }

  async function getVerifiedContent(record, fetchContent) {
    const content = String(await fetchContent(record.name, record.hash));
    const bytes = Buffer.byteLength(content);
    if (bytes > MAX_NOTE_BYTES) throw new Error(`not cok buyuk: ${record.name}`);
    if (hashContent(content) !== record.hash) throw new Error(`not ozeti uyusmuyor: ${record.name}`);
    return content;
  }

  async function applyRecords(rawRecords, fetchContent, remoteDeviceId = '') {
    if (!Array.isArray(rawRecords) || rawRecords.length > 100000) throw new Error('gecersiz replikasyon paketi');
    const summary = { applied: 0, deleted: 0, conflicts: 0, unchanged: 0, ignored: 0, names: [] };
    const work = rawRecords.map((raw) => ({ raw, attempt: 0 }));
    const contentCache = new Map();
    const remoteContent = (record) => {
      const key = `${record.name}\0${record.hash}`;
      if (!contentCache.has(key)) contentCache.set(key, getVerifiedContent(record, fetchContent));
      return contentCache.get(key);
    };
    for (let index = 0; index < work.length; index++) {
      const item = work[index];
      const remote = normalizeRecord(item.raw);
      if (!remote) { summary.ignored++; continue; }
      const local = state.notes[remote.name] || null;
      const changedWhileFetching = () => (state.notes[remote.name] || null) !== local;
      const retryWithCurrentState = () => {
        if (item.attempt >= 8) throw new Error(`not esitleme sirasinda surekli degisiyor: ${remote.name}`);
        work.splice(index + 1, 0, { raw: remote, attempt: item.attempt + 1 });
      };
      if (!local) {
        if (remote.deleted) {
          removeContent(remote.name);
          persistRecord({ ...remote, revision: 0 });
          summary.deleted++;
          onApplied({ type: 'deleted', name: remote.name, remoteDeviceId });
        } else {
          const content = await remoteContent(remote);
          if (changedWhileFetching()) { retryWithCurrentState(); continue; }
          writeContent(remote.name, content);
          persistRecord({ ...remote, revision: 0 });
          summary.applied++;
          onApplied({ type: 'content', name: remote.name, content, hash: remote.hash, remoteDeviceId });
        }
        summary.names.push(remote.name);
        continue;
      }

      const relation = compareVectors(local.vector, remote.vector);
      if (relation === 'local') { summary.ignored++; continue; }
      if (relation === 'equal' && local.deleted === remote.deleted && local.hash === remote.hash) {
        summary.unchanged++;
        continue;
      }

      if (relation === 'remote') {
        if (remote.deleted) {
          removeContent(remote.name);
          persistRecord({ ...remote, revision: 0 });
          summary.deleted++;
          onApplied({ type: 'deleted', name: remote.name, remoteDeviceId });
        } else {
          const content = await remoteContent(remote);
          if (changedWhileFetching()) { retryWithCurrentState(); continue; }
          writeContent(remote.name, content);
          persistRecord({ ...remote, revision: 0 });
          summary.applied++;
          onApplied({ type: 'content', name: remote.name, content, hash: remote.hash, remoteDeviceId });
        }
        summary.names.push(remote.name);
        continue;
      }

      const mergedVector = mergeVectors(local.vector, remote.vector);
      // Ayni icerik farkli cihazlarda bagimsiz olustuysa yalniz vektorleri birlestir.
      if (local.deleted === remote.deleted && local.hash === remote.hash) {
        persistRecord({
          ...local,
          vector: mergedVector,
          updatedAt: Math.max(local.updatedAt, remote.updatedAt),
          origin: remoteWins(local, remote) ? remote.origin : local.origin,
          revision: 0,
        });
        summary.unchanged++;
        continue;
      }

      // Silme ile icerik eszamanliysa veri kaybetmemek icin icerik kazanir.
      if (local.deleted !== remote.deleted) {
        const contentRecord = local.deleted ? remote : local;
        let content;
        if (contentRecord === remote) {
          content = await remoteContent(remote);
          if (changedWhileFetching()) { retryWithCurrentState(); continue; }
        }
        else content = readContent(local.name);
        writeContent(local.name, content);
        persistRecord({
          name: local.name,
          vector: mergedVector,
          hash: contentRecord.hash,
          deleted: false,
          updatedAt: Math.max(local.updatedAt, remote.updatedAt),
          origin: contentRecord.origin,
          revision: 0,
          conflict: true,
        });
        summary.applied++;
        summary.conflicts++;
        summary.names.push(local.name);
        onApplied({ type: 'content', name: local.name, content, hash: contentRecord.hash, conflict: true, remoteDeviceId });
        continue;
      }

      // Iki farkli icerik: ayni siralama iki cihazda da ayni kazanan/kaybedeni verir.
      const fetchedRemoteContent = await remoteContent(remote);
      if (changedWhileFetching()) { retryWithCurrentState(); continue; }
      const localContent = readVersion(local.name, local.hash);
      const chooseRemote = remoteWins(local, remote);
      const winner = chooseRemote ? remote : local;
      const loser = chooseRemote ? local : remote;
      const winnerContent = chooseRemote ? fetchedRemoteContent : localContent;
      const loserContent = chooseRemote ? localContent : fetchedRemoteContent;
      const copy = conflictName(local.name, loser);

      writeContent(local.name, winnerContent);
      persistRecord({
        name: local.name,
        vector: mergedVector,
        hash: winner.hash,
        deleted: false,
        updatedAt: Math.max(local.updatedAt, remote.updatedAt),
        origin: winner.origin,
        revision: 0,
        conflict: true,
      });

      const copyCurrent = state.notes[copy] || null;
      writeContent(copy, loserContent);
      persistRecord({
        name: copy,
        vector: mergeVectors(copyCurrent?.vector || {}, mergedVector),
        hash: loser.hash,
        deleted: false,
        updatedAt: Math.max(local.updatedAt, remote.updatedAt),
        origin: loser.origin,
        revision: 0,
        conflict: true,
      });
      summary.applied += 2;
      summary.conflicts++;
      summary.names.push(local.name, copy);
      onApplied({ type: 'conflict', name: local.name, copy, content: winnerContent, conflictContent: loserContent, remoteDeviceId });
    }
    return summary;
  }

  function cleanupPairSessions() {
    const current = now();
    for (const [code, session] of pairSessions)
      if (current - session.createdAt > PAIR_TTL_MS) pairSessions.delete(code);
    for (const [id, pending] of pendingOutgoing)
      if (current - pending.createdAt > PAIR_TTL_MS) pendingOutgoing.delete(id);
  }

  function pairCode(localUrl) {
    cleanupPairSessions();
    let code;
    do { code = String(crypto.randomInt(0, 1e6)).padStart(6, '0'); } while (pairSessions.has(code));
    pairSessions.set(code, { code, createdAt: now(), localUrl: normalizeUrl(localUrl), claim: null });
    return { code, expiresAt: now() + PAIR_TTL_MS, url: normalizeUrl(localUrl), deviceId, deviceName };
  }

  function claimPair(body) {
    cleanupPairSessions();
    const code = String(body?.code || '').trim();
    const session = pairSessions.get(code);
    if (!session) throw new Error('kod gecersiz ya da suresi gecmis');
    if (session.claim) throw new Error('bu kod zaten kullanildi');
    const peer = body?.peer || {};
    const peerId = String(peer.id || '').slice(0, 128);
    const peerName = safeLabel(peer.name);
    const peerUrl = normalizeUrl(peer.url);
    const token = String(body?.token || '');
    const requestId = String(body?.requestId || '').slice(0, 128);
    const confirmSecret = String(body?.confirmSecret || '');
    if (!validId(peerId) || peerId === deviceId || !validToken(token, 'peer')
      || !/^req_[a-f0-9]{32}$/.test(requestId) || !validToken(confirmSecret, 'confirm'))
      throw new Error('gecersiz eslestirme talebi');
    session.claim = { peerId, peerName, peerUrl, token, requestId, confirmSecret, createdAt: now() };
    return { requestId, deviceName: peerName };
  }

  function pendingPairs() {
    cleanupPairSessions();
    return [...pairSessions.values()].filter((session) => session.claim).map((session) => ({
      code: session.code,
      createdAt: session.createdAt,
      peer: {
        id: session.claim.peerId,
        name: session.claim.peerName,
        url: session.claim.peerUrl,
      },
    }));
  }

  function addPeer(record) {
    if (!validId(record.id) || record.id === deviceId || !validToken(record.outboundToken, 'peer')
      || !/^[a-f0-9]{64}$/.test(String(record.inboundTokenHash || '')))
      throw new Error('gecersiz peer kaydi');
    const next = {
      id: String(record.id).slice(0, 128),
      name: safeLabel(record.name),
      url: normalizeUrl(record.url),
      outboundToken: String(record.outboundToken),
      inboundTokenHash: String(record.inboundTokenHash),
      cursor: Math.max(0, Number(record.cursor) || 0),
      paused: false,
      lastSeen: null,
      lastSync: null,
      lastError: '',
      failures: 0,
      nextAttemptAt: 0,
    };
    const old = peers.findIndex((peer) => peer.id === next.id);
    if (old >= 0) peers.splice(old, 1, next); else peers.push(next);
    savePeers();
    setTimeout(() => syncAll().catch(() => {}), 25);
    return publicPeer(next);
  }

  async function requestJson(base, pathname, init = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('fetch kullanilamiyor');
    const url = new URL(pathname.replace(/^\//, ''), normalizeUrl(base) + '/');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(init.timeoutMs) || 8000);
    try {
      const response = await fetchImpl(url, {
        method: init.method || 'GET',
        headers: init.headers || {},
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        redirect: 'error',
        signal: controller.signal,
      });
      const text = await responseTextLimited(response, MAX_JSON_BYTES);
      if (!response.ok) throw new Error((text || `HTTP ${response.status}`).slice(0, 300));
      return text ? JSON.parse(text) : {};
    } finally { clearTimeout(timeout); }
  }

  async function connect(remoteUrlValue, codeValue, localUrlValue, requestedName) {
    cleanupPairSessions();
    const remoteUrl = normalizeUrl(remoteUrlValue);
    const localUrl = normalizeUrl(localUrlValue);
    const code = String(codeValue || '').trim();
    if (!/^\d{6}$/.test(code)) throw new Error('kod 6 haneli olmali');
    const requestId = `req_${crypto.randomBytes(16).toString('hex')}`;
    const confirmSecret = randomToken('confirm');
    const inboundToken = randomToken('peer');
    pendingOutgoing.set(requestId, {
      requestId, confirmSecret, inboundToken, remoteUrl, createdAt: now(),
    });
    try {
      await requestJson(remoteUrl, '/api/sync/pair/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: {
          code,
          requestId,
          confirmSecret,
          token: inboundToken,
          peer: { id: deviceId, name: safeLabel(requestedName || deviceName), url: localUrl },
        },
      });
    } catch (error) {
      pendingOutgoing.delete(requestId);
      throw error;
    }
    return { requestId, status: 'approval-required', remoteUrl };
  }

  function confirmPair(body) {
    cleanupPairSessions();
    const requestId = String(body?.requestId || '');
    const pending = pendingOutgoing.get(requestId);
    if (!pending || !secureEqual(pending.confirmSecret, body?.confirmSecret)) throw new Error('eslestirme dogrulanamadi');
    const remote = body?.peer || {};
    const remoteId = String(remote.id || '').slice(0, 128);
    const outboundToken = String(body?.token || '');
    if (!validId(remoteId) || remoteId === deviceId || !validToken(outboundToken, 'peer')) throw new Error('gecersiz peer bilgisi');
    const result = addPeer({
      id: remoteId,
      name: safeLabel(remote.name),
      url: normalizeUrl(remote.url || pending.remoteUrl),
      outboundToken,
      inboundTokenHash: hashToken(pending.inboundToken),
    });
    pendingOutgoing.delete(requestId);
    return result;
  }

  async function approvePair(codeValue, localUrlValue) {
    cleanupPairSessions();
    const code = String(codeValue || '').trim();
    const session = pairSessions.get(code);
    if (!session?.claim) throw new Error('bekleyen eslestirme yok');
    const claim = session.claim;
    const tokenForPeer = randomToken('peer');
    await requestJson(claim.peerUrl, '/api/sync/pair/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        requestId: claim.requestId,
        confirmSecret: claim.confirmSecret,
        token: tokenForPeer,
        peer: { id: deviceId, name: deviceName, url: normalizeUrl(localUrlValue || session.localUrl) },
      },
    });
    const result = addPeer({
      id: claim.peerId,
      name: claim.peerName,
      url: claim.peerUrl,
      outboundToken: claim.token,
      inboundTokenHash: hashToken(tokenForPeer),
    });
    pairSessions.delete(code);
    return result;
  }

  function rejectPair(codeValue) {
    return pairSessions.delete(String(codeValue || '').trim());
  }

  function authenticate(token) {
    const digest = hashToken(token);
    const peer = peers.find((item) => secureEqual(item.inboundTokenHash, digest));
    if (!peer || peer.paused) return null;
    const current = now();
    if (!peer.lastSeen || current - peer.lastSeen > 10000) {
      peer.lastSeen = current;
      savePeers();
    }
    return peer;
  }

  async function fetchPeerContent(peer, name, expectedHash) {
    if (typeof fetchImpl !== 'function') throw new Error('fetch kullanilamiyor');
    const url = new URL('/api/sync/replica/content', peer.url);
    url.searchParams.set('name', name);
    url.searchParams.set('hash', expectedHash);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetchImpl(url, {
        headers: { 'X-Sync-Key': peer.outboundToken },
        redirect: 'error', signal: controller.signal,
      });
      const content = await responseTextLimited(response, MAX_NOTE_BYTES);
      if (!response.ok) throw new Error(content.slice(0, 300) || `HTTP ${response.status}`);
      if (hashContent(content) !== expectedHash)
        throw new Error(`not ozeti uyusmuyor: ${name}`);
      return content;
    } finally { clearTimeout(timeout); }
  }

  async function syncPeer(peerOrId) {
    const peer = typeof peerOrId === 'string' ? peers.find((item) => item.id === peerOrId) : peerOrId;
    if (!peer || peer.paused || closed || syncing.has(peer.id) || Number(peer.nextAttemptAt) > now()) return null;
    syncing.add(peer.id);
    try {
      await beforeSync();
      scan();
      const result = { applied: 0, deleted: 0, conflicts: 0, unchanged: 0, ignored: 0, names: [] };
      let cursor = Math.max(0, Number(peer.cursor) || 0);
      let completed = false;
      for (let page = 0; page < 100; page++) {
        const packet = await requestJson(peer.url, `/api/sync/replica/changes?since=${encodeURIComponent(cursor)}`, {
          headers: { 'X-Sync-Key': peer.outboundToken },
        });
        if (!packet || !Array.isArray(packet.records) || !Number.isFinite(Number(packet.revision)))
          throw new Error('gecersiz peer paketi');
        if (packet.full && page === 0) cursor = 0;
        const pageResult = await applyRecords(packet.records,
          (name, hash) => fetchPeerContent(peer, name, hash), packet.deviceId || peer.id);
        for (const key of ['applied', 'deleted', 'conflicts', 'unchanged', 'ignored']) result[key] += Number(pageResult[key]) || 0;
        if (result.names.length < 200) result.names.push(...(pageResult.names || []).slice(0, 200 - result.names.length));
        const nextCursor = Math.max(0, Number(packet.revision) || 0);
        if (packet.more && nextCursor <= cursor) throw new Error('peer sayfalama ilerlemiyor');
        cursor = nextCursor;
        if (!packet.more) { completed = true; break; }
      }
      if (!completed) throw new Error('peer degisiklik sayfasi siniri asildi');
      peer.cursor = cursor;
      peer.lastSeen = now();
      peer.lastSync = now();
      peer.lastError = '';
      peer.failures = 0;
      peer.nextAttemptAt = 0;
      savePeers();
      onSync({ peer: publicPeer(peer), ...result });
      return result;
    } catch (error) {
      peer.failures = Math.min(12, (Number(peer.failures) || 0) + 1);
      peer.lastError = String(error.message || error).slice(0, 300);
      peer.nextAttemptAt = now() + Math.min(60000, 1000 * (2 ** Math.min(6, peer.failures - 1)));
      savePeers();
      onSync({ peer: publicPeer(peer), error: peer.lastError });
      return { error: peer.lastError };
    } finally { syncing.delete(peer.id); }
  }

  async function syncAll() {
    return Promise.all(peers.map((peer) => syncPeer(peer)));
  }

  function removePeer(id) {
    const before = peers.length;
    peers = peers.filter((peer) => peer.id !== String(id || ''));
    if (peers.length === before) return false;
    savePeers();
    return true;
  }

  function pausePeer(id, paused) {
    const peer = peers.find((item) => item.id === String(id || ''));
    if (!peer) return null;
    peer.paused = !!paused;
    peer.nextAttemptAt = 0;
    savePeers();
    if (!peer.paused) setTimeout(() => syncPeer(peer).catch(() => {}), 25);
    return publicPeer(peer);
  }

  function status() {
    cleanupPairSessions();
    return {
      version: STATE_VERSION,
      device: { id: deviceId, name: deviceName },
      revision: state.revision,
      notes: Object.keys(state.notes).length,
      tombstones: Object.values(state.notes).filter((record) => record.deleted).length,
      pendingPairings: pendingPairs(),
      outgoingPairings: pendingOutgoing.size,
      peers: peers.map(publicPeer),
    };
  }

  scan();
  function start() {
    if (closed || timer) return false;
    timer = setInterval(() => syncAll().catch(() => {}), intervalMs);
    timer.unref?.();
    setTimeout(() => syncAll().catch(() => {}), Math.min(750, intervalMs)).unref?.();
    return true;
  }
  if (options.autoStart !== false) start();

  return {
    identity: () => ({ deviceId, deviceName }),
    hashContent,
    scan,
    noteChanged,
    noteDeleted,
    changes,
    getRecord: (name) => state.notes[safeNoteId(name)] ? clone(state.notes[safeNoteId(name)]) : null,
    readContent,
    readVersion,
    applyRecords,
    pairCode,
    claimPair,
    pendingPairs,
    connect,
    confirmPair,
    approvePair,
    rejectPair,
    authenticate,
    syncPeer,
    syncAll,
    removePeer,
    pausePeer,
    status,
    start,
    close: () => { closed = true; if (timer) clearInterval(timer); },
  };
}

module.exports = {
  STATE_VERSION,
  createReplica,
  compareVectors,
  mergeVectors,
  normalizeUrl,
  safeNoteId,
  hashContent,
};
