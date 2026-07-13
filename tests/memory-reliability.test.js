'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createStore } = require('../memory');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notlar-memory-reliability-'));
const store = createStore(dataDir);
const ALFA = { project: 'Alfa', workspace: '/proje/alfa' };
const BETA = { project: 'Beta', workspace: '/proje/beta' };

function fact(input) { return store.recordFact(input); }
function serialized(value) { return JSON.stringify(value); }
function assertAbsent(value, needles, message) {
  const output = serialized(value);
  for (const needle of needles) assert(!output.includes(needle), `${message}: ${needle}`);
}

try {
  // Manuel kullanici girdisi kaynaksiz kabul edilir; AI girdisi kesin gercek
  // sayilmaz ve evidence cezasiyla ihtilafli olarak tutulur.
  const manual = fact({ ...ALFA, subject: 'kullanici', predicate: 'tercih-eder', topic: 'tema', object: 'koyu' }).fact;
  assert.equal(manual.assertionType, 'user');
  assert.equal(manual.evidenceLevel, 'direct');
  assert.equal(manual.source.agent, 'user');

  const unsupportedAgent = fact({
    ...ALFA, assertionType: 'agent', agent: 'codex', subject: 'Alfa', predicate: 'sahip', object: 'kaynaksiz iddia', confidence: 0.94,
  }).fact;
  assert.equal(unsupportedAgent.status, 'disputed');
  assert.equal(unsupportedAgent.evidenceLevel, 'unverified');
  assert(unsupportedAgent.confidence <= 0.35);
  const unsupportedRecall = store.recall({ ...ALFA, query: 'kaynaksiz iddia', includeDisputed: true, explain: true, noTouch: true, limit: 10 });
  const unsupportedResult = unsupportedRecall.results.find((item) => item.id === unsupportedAgent.id);
  assert(unsupportedResult, 'kaynaksiz fact recall sonucunda bulunmali');
  assert(unsupportedResult.explain.evidencePenalty < 0, 'unverified evidence cezasi explain ciktisinda gorunmeli');

  // Checkpoint -> fact zinciri hem insan hem makine tarafindan okunabilir.
  const session = store.startSession({ ...ALFA, sessionId: 'reliability-session', agent: 'codex', client: 'test', goal: 'provenance testi' });
  const checkpoint = store.checkpoint({
    sessionId: session.session.id,
    title: 'Guvenceli karar',
    summary: 'Kalici karar alindi',
    decisions: ['Arama indeksi yerel kalacak'],
  });
  const checkpointFact = store.listFacts({ ...ALFA, q: 'Arama indeksi yerel kalacak', includeHistorical: true })[0];
  const provenance = store.factProvenance(checkpointFact.id);
  assert.equal(checkpointFact.assertionType, 'agent');
  assert.equal(checkpointFact.evidenceLevel, 'derived');
  assert.equal(provenance.source.session.id, session.session.id);
  assert.equal(provenance.source.checkpoint.id, checkpoint.id);
  assert(provenance.evidenceChain.some((step) => step.type === 'session' && step.resolved));
  assert(provenance.evidenceChain.some((step) => step.type === 'checkpoint' && step.resolved));
  assert(/turetilmis|türet/i.test(provenance.explanation));

  // Adversarial zaman pencereleri: ayni timestamp deterministik kalir;
  // geriye tarihli ve cakisan aralik guncel fact'i ezmez.
  const sameTimeOld = fact({ ...ALFA, subject: 'es-zaman', predicate: 'kullanir', object: 'A', validFrom: '2026-04-01T00:00:00.000Z' }).fact;
  const sameTimeNew = fact({ ...ALFA, subject: 'es-zaman', predicate: 'kullanir', object: 'B', validFrom: '2026-04-01T00:00:00.000Z' }).fact;
  assert.equal(store.factProvenance(sameTimeOld.id).fact.validTo, '2026-04-01T00:00:00.000Z');
  assert.equal(sameTimeNew.status, 'active');
  const currentFirst = fact({ ...ALFA, subject: 'geri-tarih', predicate: 'kullanir', object: 'guncel', validFrom: '2026-06-01T00:00:00.000Z' }).fact;
  const backdated = fact({
    ...ALFA, subject: 'geri-tarih', predicate: 'kullanir', object: 'eski',
    validFrom: '2026-03-01T00:00:00.000Z', validTo: '2026-08-01T00:00:00.000Z',
  }).fact;
  assert.equal(backdated.status, 'superseded');
  assert.equal(backdated.validTo, '2026-06-01T00:00:00.000Z');
  assert.equal(store.factProvenance(currentFirst.id).fact.status, 'active');

  // Yeni source alanlarinda da gizli veri redakte edilir.
  const redactedSource = fact({
    ...ALFA, assertionType: 'imported', evidenceLevel: 'direct',
    subject: 'belge', predicate: 'sahip', object: 'kayit',
    file: '/tmp/password=asla-gorunmesin-source', noteId: 'token=asla-gorunmesin-note',
  }).fact;
  assertAbsent(redactedSource, ['asla-gorunmesin-source', 'asla-gorunmesin-note'], 'source redaksiyonu sizdirmamali');
  assert(serialized(redactedSource).includes('REDACTED'));

  // Soft forget: kronoloji ve kimlik kalir, ozgun metnin tum yuzeylerden izi silinir.
  const secrets = ['ozel-ozne-771', 'ozel-nesne-772', 'ozel-deger-773', 'ozel-konu-774', 'ozel-etiket-775', 'ozel-dosya-776', 'ozel-not-777'];
  const softTarget = fact({
    ...ALFA,
    subject: secrets[0], predicate: 'sahip', object: secrets[1], value: secrets[2], topic: secrets[3], tags: [secrets[4]],
    assertionType: 'imported', evidenceLevel: 'direct', file: `/tmp/${secrets[5]}`, noteId: secrets[6],
  }).fact;
  const softEmbeddingText = `${softTarget.subject} ${softTarget.predicate} ${softTarget.topic}: ${softTarget.object}\n${softTarget.value}`.slice(0, 4000);
  const softEmbeddingKey = require('crypto').createHash('sha256').update(softEmbeddingText).digest('hex').slice(0, 24);
  const embeddingCacheFile = path.join(dataDir, 'embed-cache.json');
  fs.writeFileSync(embeddingCacheFile, JSON.stringify({ [softEmbeddingKey]: [0.1, 0.2, 0.3] }), { mode: 0o600 });
  const softResult = store.forget({ id: softTarget.id, mode: 'soft', reason: 'kullanici talebi' });
  assert.equal(softResult.mode, 'soft');
  assert.equal(softResult.factsForgotten, 1);
  assert.equal(softResult.embeddingRecordsRemoved, 1);
  assert(!Object.prototype.hasOwnProperty.call(JSON.parse(fs.readFileSync(embeddingCacheFile, 'utf8')), softEmbeddingKey));
  const softSurfaces = {
    facts: store.listFacts({ ...ALFA, includeHistorical: true, includeForgotten: true, limit: 500 }),
    graph: store.graph(ALFA),
    timeline: store.factTimeline({ ...ALFA, includeForgotten: true }),
    provenance: store.factProvenance(softTarget.id),
    recall: store.recall({ ...ALFA, query: 'unutulmus kayit', includeHistorical: true, explain: true, noTouch: true, limit: 50 }),
  };
  assertAbsent(softSurfaces, secrets, 'soft forget API yuzeylerinde ozgun metin');
  assert(serialized(softSurfaces).includes('[UNUTULDU]'));
  assertAbsent(fs.readFileSync(store.stateFile, 'utf8'), secrets, 'soft forget canonical state');
  const softIndexBytes = fs.readFileSync(store.factIndexStatus().file).toString('latin1');
  for (const secret of secrets) {
    assert(!softIndexBytes.includes(secret), `soft forget indeks ham metni: ${secret}`);
    assert(!softIndexBytes.includes(secret.replace(/-/g, ' ')), `soft forget indeks normalize metni: ${secret}`);
  }

  // Hard forget: fact ve tum ters iliskiler tamamen kalkar; acik onay zorunludur.
  const hardOld = fact({ ...ALFA, subject: 'hard-zincir', predicate: 'kullanir', object: 'eski', validFrom: '2026-01-01T00:00:00.000Z' }).fact;
  const hardNew = fact({ ...ALFA, subject: 'hard-zincir', predicate: 'kullanir', object: 'yeni', validFrom: '2026-02-01T00:00:00.000Z' }).fact;
  assert(hardNew.supersedes.includes(hardOld.id));
  assert.throws(() => store.forget({ id: hardOld.id, mode: 'hard' }), /KALICI OLARAK UNUT/);
  const hardResult = store.forget({ id: hardOld.id, mode: 'hard', confirm: 'KALICI OLARAK UNUT' });
  assert.equal(hardResult.mode, 'hard');
  assert.equal(hardResult.factsRemoved, 1);
  assert(hardResult.relationsCleaned >= 1);
  assert(hardResult.indexRecordsRemoved >= 1);
  const hardState = store.load();
  assert(!hardState.facts.some((item) => item.id === hardOld.id));
  assert(!hardState.facts.some((item) => (item.supersedes || []).includes(hardOld.id) || (item.supersededBy || []).includes(hardOld.id)));
  assertAbsent({
    facts: store.listFacts({ ...ALFA, includeHistorical: true, includeForgotten: true, limit: 500 }),
    graph: store.graph(ALFA),
    timeline: store.factTimeline({ ...ALFA, subject: 'hard-zincir' }),
  }, [hardOld.id], 'hard forget sonrasi fact kimligi');
  assert.throws(() => store.factProvenance(hardOld.id), /bulunamadi/);

  // Kesin slot ayniysa supersede; yalnizca benzerse oner, otomatik hukum verme.
  const exactOld = fact({ ...ALFA, subject: 'takim', predicate: 'kullanir', topic: 'ana editor', object: 'VS Code', confidence: 0.8 }).fact;
  const exactNew = fact({ ...ALFA, subject: 'takim', predicate: 'kullanir', topic: 'ana editor', object: 'Zed', confidence: 0.9 }).fact;
  assert(exactNew.supersedes.includes(exactOld.id));

  const similarBase = fact({ ...ALFA, subject: 'gelistirme takimi', predicate: 'tercih-eder', topic: 'kod editoru', object: 'VS Code koyu tema', confidence: 0.85 }).fact;
  const similar = fact({ ...ALFA, subject: 'gelistirme takimi', predicate: 'tercih-eder', topic: 'editor tercihi', object: 'VS Code acik tema', confidence: 0.8 });
  assert.equal(similar.fact.status, 'active');
  assert(!similar.fact.supersedes.includes(similarBase.id));
  assert(similar.conflictSuggestions.some((item) => item.fact.id === similarBase.id));
  assert(similar.conflictSuggestions.every((item) => ['supersede', 'dispute', 'keep-separate'].includes(item.suggestedAction)));

  const lowConfidence = fact({ ...ALFA, subject: 'gelistirme takimi', predicate: 'tercih-eder', topic: 'editor secimi', object: 'VS Code beta', confidence: 0.2 });
  assert.equal(lowConfidence.fact.status, 'disputed');
  const isolated = fact({ ...BETA, subject: 'gelistirme takimi', predicate: 'tercih-eder', topic: 'editor tercihi', object: 'VS Code acik tema', confidence: 0.8 });
  assert(!isolated.conflictSuggestions.some((item) => item.fact.projectId === similarBase.projectId));

  // Yerel indeks kullanilir; bozuldugunda rebuild/fallback dogru sonucu korur.
  const indexed = store.recall({ ...ALFA, query: 'yerel arama indeksi', explain: true, noTouch: true, limit: 20 });
  assert(indexed.index && ['sqlite-fts5', 'inverted-json'].includes(indexed.index.engine));
  assert(indexed.results.some((item) => item.sourceType === 'fact' && item.candidateOrigin === 'local-index'));
  const rebuilt = store.rebuildFactIndex();
  assert(rebuilt.records >= store.load().facts.filter((item) => item.status !== 'forgotten').length);
  assert.equal(fs.statSync(path.join(dataDir, 'memory')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(rebuilt.file).mode & 0o777, 0o600);

  // SQLite bulunmayan/eski Node yolunda atomik inverted-index bozulursa
  // canonical JSON'dan yeniden kurulur ve dogru sonuc korunur.
  const fallbackDir = path.join(dataDir, 'fallback-runtime');
  process.env.NOTLAR_MEMORY_INDEX = 'json';
  const fallbackStore = createStore(fallbackDir);
  const fallbackFact = fallbackStore.recordFact({
    project: 'Fallback', workspace: '/fallback', subject: 'fallback konu', predicate: 'sahip', object: 'yeniden-kurulan-hedef',
  }).fact;
  const fallbackIndex = fallbackStore.factIndexStatus();
  fs.writeFileSync(fallbackIndex.file, '{bozuk-index', { mode: 0o600 });
  const recoveredStore = createStore(fallbackDir);
  const recovered = recoveredStore.recall({ project: 'Fallback', workspace: '/fallback', query: 'yeniden kurulan hedef', noTouch: true, explain: true });
  assert(recovered.results.some((item) => item.id === fallbackFact.id));
  assert.equal(recovered.index.engine, 'inverted-json');
  delete process.env.NOTLAR_MEMORY_INDEX;

  console.log('memory-reliability: ok');
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}
