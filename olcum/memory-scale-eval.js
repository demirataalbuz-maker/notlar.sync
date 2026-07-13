'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');

const memory = require('../memory');

const args = new Set(process.argv.slice(2));
const count = Math.max(10000, Number(process.env.MEMORY_SCALE_COUNT) || (args.has('--large') ? 100000 : 10000));
const queryRuns = args.has('--ci') ? 12 : 48;
const targetP95 = 500;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notlar-memory-scale-'));
let failures = 0;

function percentile(values, pct) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * pct) - 1))] || 0;
}

function ms(value) { return `${value.toFixed(1)} ms`; }
function factText(item) { return `${item.title || ''} ${item.text || ''}`; }
function resultFacts(result) { return result.results.filter((item) => item.sourceType === 'fact'); }
function check(condition, label) {
  if (condition) return;
  failures++;
  console.error(`  ✗ ${label}`);
}

try {
  const bootstrap = memory.createStore(dataDir);
  const projects = [
    bootstrap.projectOf({ project: 'Scale-A', workspace: '/scale/a' }),
    bootstrap.projectOf({ project: 'Scale-B', workspace: '/scale/b' }),
    bootstrap.projectOf({ project: 'Scale-C', workspace: '/scale/c' }),
    bootstrap.projectOf({ project: 'Scale-D', workspace: '/scale/d' }),
  ];
  const facts = [];
  const oldDate = '2025-01-01T00:00:00.000Z';
  const switchDate = '2025-07-01T00:00:00.000Z';
  const newDate = '2026-01-01T00:00:00.000Z';

  // Ilk 80 kayit 40 temporal zincirdir; kalanlar yuksek kardinaliteli,
  // proje-izole lexical veri uretir.
  for (let index = 0; index < 40; index++) {
    const project = projects[index % projects.length];
    const slot = `${project.id}|temporal konu ${index}|kullanir|topic:surum`;
    const oldId = `fact_scale_history_old_${index}`;
    const newId = `fact_scale_history_new_${index}`;
    facts.push({
      id: oldId, projectId: project.id, projectName: project.name, workspace: project.workspace,
      subject: `temporal konu ${index}`, predicate: 'kullanir', topic: 'surum',
      object: `eski-surum-${index}`, value: `tarihsel-hedef-${index} eski-surum-${index}`,
      status: 'superseded', confidence: 0.9, assertionType: 'imported', evidenceLevel: 'direct',
      observedAt: oldDate, recordedAt: oldDate, validFrom: oldDate, validTo: switchDate,
      source: { agent: 'scale-eval', noteId: `scale:old:${index}` },
      supersedes: [], supersededBy: [newId], contradictionGroup: null, tags: ['scale', 'history'], redactions: 0, slot,
    });
    facts.push({
      id: newId, projectId: project.id, projectName: project.name, workspace: project.workspace,
      subject: `temporal konu ${index}`, predicate: 'kullanir', topic: 'surum',
      object: `yeni-surum-${index}`, value: `guncel-hedef-${index} yeni-surum-${index}`,
      status: 'active', confidence: 0.9, assertionType: 'imported', evidenceLevel: 'direct',
      observedAt: newDate, recordedAt: newDate, validFrom: switchDate, validTo: null,
      source: { agent: 'scale-eval', noteId: `scale:new:${index}` },
      supersedes: [oldId], supersededBy: [], contradictionGroup: null, tags: ['scale', 'current'], redactions: 0, slot,
    });
  }
  for (let index = facts.length; index < count; index++) {
    const project = projects[index % projects.length];
    const subject = `olcek konu ${index}`;
    facts.push({
      id: `fact_scale_${index}`, projectId: project.id, projectName: project.name, workspace: project.workspace,
      subject, predicate: 'sahip', topic: `kategori-${index % 50}`,
      object: `benzersiz-${index}`, value: `olcek-anahtar-${index} sonuc-${index} proje-${project.name}`,
      status: 'active', confidence: 0.82, assertionType: 'imported', evidenceLevel: 'direct',
      observedAt: newDate, recordedAt: newDate, validFrom: newDate, validTo: null,
      source: { agent: 'scale-eval', noteId: `scale:${index}` },
      supersedes: [], supersededBy: [], contradictionGroup: null, tags: ['scale', `bucket-${index % 100}`], redactions: 0,
      slot: `${project.id}|${subject}|sahip|topic:kategori ${index % 50}`,
    });
  }

  const state = {
    version: memory.VERSION,
    settings: { ...memory.DEFAULT_SETTINGS },
    memories: [], sessions: [], checkpoints: [], facts,
    factIndexRevision: 1,
  };
  const memoryDir = path.join(dataDir, 'memory');
  fs.mkdirSync(memoryDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(memoryDir, 'state.json'), JSON.stringify(state), { mode: 0o600 });
  fs.chmodSync(memoryDir, 0o700);
  fs.chmodSync(path.join(memoryDir, 'state.json'), 0o600);

  const store = memory.createStore(dataDir);
  const buildStarted = performance.now();
  const index = store.rebuildFactIndex();
  const buildMs = performance.now() - buildStarted;

  // Isinma: SQLite sayfalari ve JS modul yollari p95'e kurulum maliyeti katmasin.
  store.recall({ project: projects[0].name, workspace: projects[0].workspace, query: 'olcek anahtar 100', noTouch: true, limit: 5 });

  const currentTimes = [];
  let currentTop3 = 0;
  for (let run = 0; run < queryRuns; run++) {
    let target = 100 + ((run * 197) % Math.max(1, count - 100));
    while (target % projects.length !== 0) target++;
    if (target >= count) target = 100 + (run % 20) * projects.length;
    const started = performance.now();
    const result = store.recall({
      project: projects[0].name, workspace: projects[0].workspace,
      query: `olcek-anahtar-${target} sonuc-${target}`, explain: true, noTouch: true, limit: 8,
    });
    currentTimes.push(performance.now() - started);
    if (resultFacts(result).slice(0, 3).some((item) => item.id === `fact_scale_${target}`)) currentTop3++;
    else console.error(`  ✗ current target ${target}: ${resultFacts(result).slice(0, 3).map((item) => item.id).join(', ') || '(bos)'}`);
    check(result.index.engine === index.engine, `indeks motoru run ${run}`);
  }

  const historicalTimes = [];
  let historicalTop3 = 0;
  for (let run = 0; run < Math.min(queryRuns, 40); run++) {
    const indexNo = run % 40;
    const project = projects[indexNo % projects.length];
    const started = performance.now();
    const result = store.recall({
      project: project.name, workspace: project.workspace,
      query: `tarihsel-hedef-${indexNo} eski-surum-${indexNo}`,
      asOf: '2025-03-01T00:00:00.000Z', explain: true, noTouch: true, limit: 8,
    });
    historicalTimes.push(performance.now() - started);
    if (resultFacts(result).slice(0, 3).some((item) => item.id === `fact_scale_history_old_${indexNo}`)) historicalTop3++;
  }

  const isolatedIndex = Math.min(count - 1, 1000 + projects.length);
  const owner = projects[isolatedIndex % projects.length];
  const other = projects[(isolatedIndex + 1) % projects.length];
  const ownerResult = store.recall({ project: owner.name, workspace: owner.workspace, query: `olcek-anahtar-${isolatedIndex}`, noTouch: true, limit: 10 });
  const otherResult = store.recall({ project: other.name, workspace: other.workspace, query: `olcek-anahtar-${isolatedIndex}`, noTouch: true, limit: 10 });
  const isolated = resultFacts(ownerResult).some((item) => item.id === `fact_scale_${isolatedIndex}`)
    && !resultFacts(otherResult).some((item) => item.id === `fact_scale_${isolatedIndex}`);
  check(isolated, 'proje izolasyonu');

  const forgetId = `fact_scale_${Math.min(count - 1, 500)}`;
  const forgetStarted = performance.now();
  const forgotten = store.forget({ id: forgetId, mode: 'hard', confirm: 'KALICI OLARAK UNUT' });
  const forgetMs = performance.now() - forgetStarted;
  const afterForget = store.recall({ allProjects: true, query: 'olcek-anahtar-500', includeHistorical: true, noTouch: true, limit: 20 });
  const forgetClean = forgotten.factsRemoved === 1 && forgotten.indexRecordsRemoved === 1
    && !resultFacts(afterForget).some((item) => item.id === forgetId);
  check(forgetClean, 'forget sonrasi indeks temizligi');

  const currentP95 = percentile(currentTimes, 0.95);
  const historicalP95 = percentile(historicalTimes, 0.95);
  const cpu = os.cpus()[0]?.model || 'bilinmiyor';
  console.log('Memory scale evaluation');
  console.log(`  ortam       : Node ${process.version} · ${process.platform}/${process.arch} · ${cpu}`);
  console.log(`  veri        : ${count.toLocaleString('tr-TR')} fact · ${projects.length} proje · ${index.engine}`);
  console.log(`  index build : ${ms(buildMs)} · ${index.records.toLocaleString('tr-TR')} kayit`);
  console.log(`  current     : p50 ${ms(percentile(currentTimes, 0.5))} · p95 ${ms(currentP95)} · top3 ${currentTop3}/${queryRuns}`);
  console.log(`  historical  : p50 ${ms(percentile(historicalTimes, 0.5))} · p95 ${ms(historicalP95)} · top3 ${historicalTop3}/${historicalTimes.length}`);
  console.log(`  hard forget : ${ms(forgetMs)} · temiz=${forgetClean ? 'evet' : 'hayir'}`);
  console.log(`  izolasyon   : ${isolated ? 'gecti' : 'kaldi'}`);
  if (currentP95 >= targetP95 || historicalP95 >= targetP95) {
    console.log(`  performans  : hedef ${targetP95} ms p95 asildi (raporlandi; flaky failure degil)`);
  } else console.log(`  performans  : p95 hedefi <${targetP95} ms gecti`);

  check(currentTop3 === queryRuns, 'current top3 dogrulugu');
  check(historicalTop3 === historicalTimes.length, 'historical top3 dogrulugu');
  if (failures) {
    console.error(`scale-eval: ${failures} dogruluk hatasi`);
    process.exitCode = 1;
  } else console.log('scale-eval: ok');
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}
