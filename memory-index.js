'use strict';

// Canonical veri state.json'da kalir. Bu dosya yalnizca yeniden kurulabilir,
// yerel bir aday indeksi tutar. Node'un gomulu SQLite/FTS5'i varsa onu,
// yoksa atomik JSON inverted-index'i kullanir. Her hata dogru sonuctan odun
// vermeden caller'in lineer JSON yoluna dusmesi icin raporlanir.

const fs = require('fs');
const path = require('path');

const INDEX_VERSION = 1;
const MAX_QUERY_CANDIDATES = 2000;

function createFactIndex({ root, atomicJson, normalizeForSearch, safeText }) {
  const sqliteFile = path.join(root, 'facts-index.sqlite');
  const jsonFile = path.join(root, 'facts-index.json');
  let engine = 'inverted-json';
  let db = null;
  let jsonCache = null;
  let lastError = '';

  const chmodPrivate = (file) => { try { fs.chmodSync(file, 0o600); } catch {} };
  const isoMs = (value) => {
    const parsed = Date.parse(String(value || ''));
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const revisionOf = (state) => Number(state.factIndexRevision) || 0;
  const indexable = (fact) => fact && fact.id && fact.status !== 'forgotten';
  const source = (fact) => (fact.source && typeof fact.source === 'object' ? fact.source : {});
  const textOf = (fact) => normalizeForSearch([
    fact.subject, fact.predicate, fact.topic, fact.object, fact.value,
    ...(Array.isArray(fact.tags) ? fact.tags : []),
  ].filter(Boolean).join(' '));
  const docOf = (fact) => ({
    id: fact.id,
    projectId: fact.projectId || '',
    workspace: safeText(fact.workspace, 700),
    subject: normalizeForSearch(fact.subject),
    predicate: normalizeForSearch(fact.predicate).replace(/\s+/g, '-'),
    topic: normalizeForSearch(fact.topic),
    status: fact.status || 'active',
    validFrom: isoMs(fact.validFrom || fact.recordedAt),
    validTo: fact.validTo ? isoMs(fact.validTo) : null,
    assertionType: fact.assertionType || 'system',
    evidenceLevel: fact.evidenceLevel || 'unverified',
    sourceAgent: safeText(source(fact).agent, 80),
    sourceSession: safeText(source(fact).sessionId, 120),
    sourceCheckpoint: safeText(source(fact).checkpointId, 120),
    sourceEvent: safeText(source(fact).eventId, 120),
    sourceNote: safeText(source(fact).noteId, 220),
    sourceFile: safeText(source(fact).file, 700),
    text: textOf(fact),
  });
  const queryTokens = (value) => [...new Set(normalizeForSearch(value).split(/\s+/).filter((token) => token.length > 1))].slice(0, 32);

  function initSqlite() {
    try {
      // Dynamic require keeps Node 18/20 compatibility; fallback below is a
      // complete implementation, not a startup failure.
      const { DatabaseSync } = require('node:sqlite');
      db = new DatabaseSync(sqliteFile);
      engine = 'sqlite-fts5';
      db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA foreign_keys=ON;');
      db.exec(`
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS facts (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          workspace TEXT NOT NULL,
          subject TEXT NOT NULL,
          predicate TEXT NOT NULL,
          topic TEXT NOT NULL,
          status TEXT NOT NULL,
          valid_from INTEGER NOT NULL,
          valid_to INTEGER,
          assertion_type TEXT NOT NULL,
          evidence_level TEXT NOT NULL,
          source_agent TEXT NOT NULL,
          source_session TEXT NOT NULL,
          source_checkpoint TEXT NOT NULL,
          source_event TEXT NOT NULL,
          source_note TEXT NOT NULL,
          source_file TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS facts_scope_idx ON facts(project_id, status, valid_from, valid_to);
        CREATE INDEX IF NOT EXISTS facts_fields_idx ON facts(subject, predicate, topic);
        CREATE INDEX IF NOT EXISTS facts_evidence_idx ON facts(assertion_type, evidence_level, source_agent);
        CREATE VIRTUAL TABLE IF NOT EXISTS fact_fts USING fts5(id UNINDEXED, text, subject, predicate, topic, tokenize='unicode61');
      `);
      chmodPrivate(sqliteFile);
      setSqliteMeta('version', INDEX_VERSION);
      return true;
    } catch (error) {
      lastError = safeText(error.message || error, 500);
      try { db?.close(); } catch {}
      db = null;
      engine = 'inverted-json';
      return false;
    }
  }

  function sqliteMeta(key) {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(String(key));
    return row ? row.value : '';
  }

  function setSqliteMeta(key, value) {
    db.prepare('INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(String(key), String(value));
  }

  function insertSqliteDoc(doc) {
    db.prepare(`INSERT INTO facts(
      id,project_id,workspace,subject,predicate,topic,status,valid_from,valid_to,
      assertion_type,evidence_level,source_agent,source_session,source_checkpoint,
      source_event,source_note,source_file
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      doc.id, doc.projectId, doc.workspace, doc.subject, doc.predicate, doc.topic,
      doc.status, doc.validFrom, doc.validTo, doc.assertionType, doc.evidenceLevel,
      doc.sourceAgent, doc.sourceSession, doc.sourceCheckpoint, doc.sourceEvent,
      doc.sourceNote, doc.sourceFile,
    );
    db.prepare('INSERT INTO fact_fts(id,text,subject,predicate,topic) VALUES (?,?,?,?,?)')
      .run(doc.id, doc.text, doc.subject, doc.predicate, doc.topic);
  }

  function rebuildSqlite(state) {
    const facts = state.facts.filter(indexable);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('DELETE FROM fact_fts; DELETE FROM facts;');
      for (const fact of facts) insertSqliteDoc(docOf(fact));
      setSqliteMeta('revision', revisionOf(state));
      setSqliteMeta('count', facts.length);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    chmodPrivate(sqliteFile);
    return { engine, file: sqliteFile, records: facts.length, rebuilt: true };
  }

  function jsonState(state) {
    const docs = {};
    const postings = {};
    for (const fact of state.facts.filter(indexable)) {
      const doc = docOf(fact);
      docs[doc.id] = doc;
      for (const token of queryTokens(doc.text)) {
        if (!postings[token]) postings[token] = [];
        postings[token].push(doc.id);
      }
    }
    return { version: INDEX_VERSION, revision: revisionOf(state), docs, postings };
  }

  function rebuildJson(state) {
    jsonCache = jsonState(state);
    atomicJson(jsonFile, jsonCache);
    chmodPrivate(jsonFile);
    return { engine, file: jsonFile, records: Object.keys(jsonCache.docs).length, rebuilt: true };
  }

  function loadJson() {
    if (jsonCache) return jsonCache;
    try { jsonCache = JSON.parse(fs.readFileSync(jsonFile, 'utf8')); }
    catch { jsonCache = { version: INDEX_VERSION, revision: -1, docs: {}, postings: {} }; }
    return jsonCache;
  }

  function rebuild(state) {
    lastError = '';
    try { return engine === 'sqlite-fts5' ? rebuildSqlite(state) : rebuildJson(state); }
    catch (error) {
      lastError = safeText(error.message || error, 500);
      if (engine === 'sqlite-fts5') {
        try { db?.close(); } catch {}
        db = null;
        engine = 'inverted-json';
        return rebuildJson(state);
      }
      throw error;
    }
  }

  function ensure(state) {
    try {
      if (engine === 'sqlite-fts5') {
        const revision = Number(sqliteMeta('revision'));
        const count = Number(sqliteMeta('count'));
        const expected = state.facts.filter(indexable).length;
        if (revision !== revisionOf(state) || count !== expected) return rebuild(state);
        return { engine, file: sqliteFile, records: count, rebuilt: false };
      }
      const index = loadJson();
      const expected = state.facts.filter(indexable).length;
      if (index.version !== INDEX_VERSION || Number(index.revision) !== revisionOf(state)
        || Object.keys(index.docs || {}).length !== expected) return rebuild(state);
      return { engine, file: jsonFile, records: expected, rebuilt: false };
    } catch (error) {
      lastError = safeText(error.message || error, 500);
      return { engine, file: engine === 'sqlite-fts5' ? sqliteFile : jsonFile, records: 0, rebuilt: false, error: lastError };
    }
  }

  function eligible(doc, input = {}) {
    if (!input.allProjects && doc.projectId && doc.projectId !== input.projectId) return false;
    if (input.workspace && doc.workspace && doc.workspace !== input.workspace) return false;
    if (input.subject && !doc.subject.includes(normalizeForSearch(input.subject))) return false;
    if (input.predicate && doc.predicate !== normalizeForSearch(input.predicate).replace(/\s+/g, '-')) return false;
    if (input.topic && !doc.topic.includes(normalizeForSearch(input.topic))) return false;
    if (input.status && doc.status !== input.status) return false;
    if (input.assertionType && doc.assertionType !== input.assertionType) return false;
    if (input.evidenceLevel && doc.evidenceLevel !== input.evidenceLevel) return false;
    if (input.sourceAgent && doc.sourceAgent !== input.sourceAgent) return false;
    const asOf = input.asOf ? Date.parse(input.asOf) : NaN;
    if (Number.isFinite(asOf)) return doc.validFrom <= asOf && (doc.validTo === null || asOf < doc.validTo);
    if (input.status) return true;
    if (input.includeHistorical) return true;
    return doc.status === 'active' || doc.status === 'disputed';
  }

  function querySqlite(state, input, tokens) {
    const status = ensure(state);
    if (status.error) return { ...status, used: false, fallbackReason: 'index-error', ids: [], matches: {} };
    const strictMatch = tokens.map((token) => `"${token}"*`).join(' AND ');
    const looseMatch = tokens.map((token) => `"${token}"*`).join(' OR ');
    const where = ['fact_fts MATCH ?'];
    const params = [strictMatch];
    if (!input.allProjects) { where.push('(f.project_id = ? OR f.project_id = ?)'); params.push(input.projectId || '', ''); }
    if (input.subject) { where.push('f.subject LIKE ?'); params.push(`%${normalizeForSearch(input.subject)}%`); }
    if (input.predicate) { where.push('f.predicate = ?'); params.push(normalizeForSearch(input.predicate).replace(/\s+/g, '-')); }
    if (input.topic) { where.push('f.topic LIKE ?'); params.push(`%${normalizeForSearch(input.topic)}%`); }
    if (input.status) { where.push('f.status = ?'); params.push(input.status); }
    if (input.assertionType) { where.push('f.assertion_type = ?'); params.push(input.assertionType); }
    if (input.evidenceLevel) { where.push('f.evidence_level = ?'); params.push(input.evidenceLevel); }
    if (input.sourceAgent) { where.push('f.source_agent = ?'); params.push(input.sourceAgent); }
    const asOf = input.asOf ? Date.parse(input.asOf) : NaN;
    if (Number.isFinite(asOf)) {
      where.push('f.valid_from <= ? AND (f.valid_to IS NULL OR ? < f.valid_to)');
      params.push(asOf, asOf);
    } else if (!input.status && !input.includeHistorical) where.push("f.status IN ('active','disputed')");
    params.push(MAX_QUERY_CANDIDATES);
    const statement = db.prepare(`SELECT f.*, bm25(fact_fts) AS rank
      FROM fact_fts JOIN facts f ON f.id = fact_fts.id
      WHERE ${where.join(' AND ')}
      ORDER BY rank LIMIT ?`);
    let rows = statement.all(...params);
    if (!rows.length && strictMatch !== looseMatch) {
      params[0] = looseMatch;
      rows = statement.all(...params);
    }
    const matches = {};
    for (const row of rows) matches[row.id] = { engine, lexical: true, rank: Number(row.rank) || 0, tokens };
    return { ...status, used: rows.length > 0, fallbackReason: rows.length ? '' : 'no-index-match', ids: rows.map((row) => row.id), matches };
  }

  function queryJson(state, input, tokens) {
    const status = ensure(state);
    if (status.error) return { ...status, used: false, fallbackReason: 'index-error', ids: [], matches: {} };
    const index = loadJson();
    const counts = new Map();
    for (const token of tokens) {
      for (const [indexedToken, ids] of Object.entries(index.postings || {})) {
        if (!indexedToken.startsWith(token)) continue;
        for (const id of ids) counts.set(id, (counts.get(id) || 0) + 1);
      }
    }
    const ids = [...counts.entries()].sort((a, b) => b[1] - a[1])
      .map(([id]) => id).filter((id) => index.docs[id] && eligible(index.docs[id], input)).slice(0, MAX_QUERY_CANDIDATES);
    const matches = {};
    for (const id of ids) matches[id] = { engine, lexical: true, rank: counts.get(id), tokens };
    return { ...status, used: ids.length > 0, fallbackReason: ids.length ? '' : 'no-index-match', ids, matches };
  }

  function query(state, input = {}) {
    const tokens = queryTokens(input.query);
    if (!tokens.length) {
      const status = ensure(state);
      return { ...status, used: false, fallbackReason: 'query-empty', ids: [], matches: {} };
    }
    try { return engine === 'sqlite-fts5' ? querySqlite(state, input, tokens) : queryJson(state, input, tokens); }
    catch (error) {
      lastError = safeText(error.message || error, 500);
      return { engine, file: engine === 'sqlite-fts5' ? sqliteFile : jsonFile, used: false, fallbackReason: 'index-error', error: lastError, ids: [], matches: {} };
    }
  }

  function applyChanges(state, changes = {}) {
    const changedIds = [...new Set((changes.changedIds || []).filter(Boolean))];
    const removedIds = [...new Set((changes.removedIds || []).filter(Boolean))];
    const affectedIds = [...new Set([...changedIds, ...removedIds])];
    const currentFacts = new Map(state.facts.map((fact) => [fact.id, fact]));
    const removalIds = affectedIds.filter((id) => !indexable(currentFacts.get(id)));
    let recordsRemoved = 0;
    try {
      if (engine === 'sqlite-fts5') {
        const exists = db.prepare('SELECT 1 AS present FROM facts WHERE id = ?');
        recordsRemoved = removalIds.reduce((total, id) => total + (exists.get(id) ? 1 : 0), 0);
      } else {
        const current = loadJson();
        recordsRemoved = removalIds.reduce((total, id) => total + (current.docs?.[id] ? 1 : 0), 0);
      }
    } catch { recordsRemoved = 0; }
    if (changes.forceRebuild || engine !== 'sqlite-fts5') {
      const result = rebuild(state);
      if (changes.purge) purge();
      return { ...result, recordsChanged: changedIds.length, recordsRemoved };
    }
    try {
      const expectedPrevious = Math.max(0, revisionOf(state) - 1);
      if (Number(sqliteMeta('revision')) !== expectedPrevious) {
        const result = rebuild(state);
        if (changes.purge) purge();
        return { ...result, recordsChanged: changedIds.length, recordsRemoved: removedIds.length };
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        const removeFact = db.prepare('DELETE FROM facts WHERE id = ?');
        const removeFts = db.prepare('DELETE FROM fact_fts WHERE id = ?');
        for (const id of affectedIds) { removeFts.run(id); removeFact.run(id); }
        const byId = new Map(state.facts.map((fact) => [fact.id, fact]));
        for (const id of changedIds) {
          const fact = byId.get(id);
          if (indexable(fact)) insertSqliteDoc(docOf(fact));
        }
        setSqliteMeta('revision', revisionOf(state));
        setSqliteMeta('count', state.facts.filter(indexable).length);
        db.exec('COMMIT');
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch {}
        throw error;
      }
      if (changes.purge) purge();
      chmodPrivate(sqliteFile);
      return {
        engine, file: sqliteFile, records: state.facts.filter(indexable).length,
        recordsChanged: changedIds.length, recordsRemoved, rebuilt: false,
      };
    } catch (error) {
      lastError = safeText(error.message || error, 500);
      return { ...rebuild(state), recordsChanged: changedIds.length, recordsRemoved, recoveredFrom: lastError };
    }
  }

  function purge() {
    if (engine !== 'sqlite-fts5') return;
    try { db.exec('PRAGMA secure_delete=ON; VACUUM;'); chmodPrivate(sqliteFile); }
    catch (error) { lastError = safeText(error.message || error, 500); }
  }

  function status(state) {
    const current = ensure(state);
    return { ...current, healthy: !current.error, error: current.error || lastError || '' };
  }

  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(root, 0o700); } catch {}
  if (process.env.NOTLAR_MEMORY_INDEX !== 'json') initSqlite();

  return { query, ensure, rebuild, applyChanges, status, purge };
}

module.exports = { createFactIndex, INDEX_VERSION, MAX_QUERY_CANDIDATES };
