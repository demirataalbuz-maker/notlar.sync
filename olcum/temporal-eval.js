'use strict';

// Temporal hafiza degerlendirmesi: izole bir gecici dizinde gercekci bir
// senaryo kurar (iki proje, oturumlar, checkpointler, zaman icinde degisen
// fact'ler) ve 30+ temporal soruyu üç metrikle puanlar:
//   - current recall:    "X su an ne kullaniyor?" -> aktif dogru fact ilk K'da mi?
//   - historical recall: "X mart ayinda ne kullaniyordu?" / "ne zaman gecersiz oldu?"
//   - provenance:        "bu karar hangi checkpoint/oturumdan geldi?"
// Kullanim: npm run eval:temporal   (cikis 0 = esikler gecti)

const fs = require('fs');
const os = require('os');
const path = require('path');
const memory = require('../memory');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notlar-temporal-eval-'));
const store = memory.createStore(dataDir);

const ATLAS = { project: 'Atlas', workspace: '/proje/atlas' };
const BOZKIR = { project: 'Bozkir', workspace: '/proje/bozkir' };

function fact(input) { return store.recordFact(input).fact; }

// --- senaryo: zaman icinde degisen bilgiler ---
const editorV1 = fact({ ...ATLAS, subject: 'kullanici', predicate: 'kullanir', topic: 'editor', object: 'VSCode', confidence: 0.85, validFrom: '2026-01-10T09:00:00.000Z' });
const editorV2 = fact({ ...ATLAS, subject: 'kullanici', predicate: 'kullanir', topic: 'editor', object: 'Neovim', confidence: 0.85, validFrom: '2026-04-02T09:00:00.000Z' });
const editorV3 = fact({ ...ATLAS, subject: 'kullanici', predicate: 'kullanir', topic: 'editor', object: 'Zed', confidence: 0.9, validFrom: '2026-06-20T09:00:00.000Z' });

const temaV1 = fact({ ...ATLAS, subject: 'kullanici', predicate: 'tercih-eder', topic: 'tema', object: 'acik tema', confidence: 0.8, validFrom: '2026-01-05T09:00:00.000Z' });
const temaV2 = fact({ ...ATLAS, subject: 'kullanici', predicate: 'tercih-eder', topic: 'tema', object: 'koyu tema', confidence: 0.85, validFrom: '2026-03-15T09:00:00.000Z' });

const dbV1 = fact({ ...ATLAS, subject: 'Atlas', predicate: 'kullanir', topic: 'veritabani', object: 'SQLite', confidence: 0.9, validFrom: '2026-02-01T09:00:00.000Z' });
const dbV2 = fact({ ...ATLAS, subject: 'Atlas', predicate: 'kullanir', topic: 'veritabani', object: 'Postgres', confidence: 0.9, validFrom: '2026-05-10T09:00:00.000Z' });

const bulutV1 = fact({ ...ATLAS, subject: 'Atlas', predicate: 'kullanir', topic: 'bulut', object: 'AWS', confidence: 0.9, validFrom: '2026-02-20T09:00:00.000Z' });
const bulutV2 = fact({ ...ATLAS, subject: 'Atlas', predicate: 'kullanir', topic: 'bulut', object: 'Hetzner', confidence: 0.4, validFrom: '2026-06-01T09:00:00.000Z' }); // dusuk guven -> disputed

const bozkirDil = fact({ ...BOZKIR, subject: 'Bozkir', predicate: 'kullanir', topic: 'dil', object: 'Rust', confidence: 0.9, validFrom: '2026-03-01T09:00:00.000Z' });

// --- oturum + checkpoint kaynakli fact'ler (provenance) ---
const ses = store.startSession({ ...ATLAS, agent: 'codex', sessionId: 'eval-ses-atlas', goal: 'Atlas altyapi kararlari' });
const chk1 = store.checkpoint({
  sessionId: ses.session.id,
  title: 'Mimari karar turu',
  summary: 'Gercek zamanli katman icin karar verildi',
  decisions: ['Gercek zamanli katman WebSocket ile kurulacak', 'Kimlik dogrulama cihaz anahtariyla yapilacak'],
  openTasks: ['CI pipeline kur', 'Yedekleme planini yaz'],
  risks: ['Tek sunucu tek hata noktasi'],
});
const chk2 = store.checkpoint({
  sessionId: ses.session.id,
  title: 'Uygulama turu',
  summary: 'CI tamamlandi',
  completed: ['CI pipeline kur'],
});
const invalidated = fact({ ...ATLAS, subject: 'Atlas', predicate: 'sahip', object: 'demo lisansi', confidence: 0.8, validFrom: '2026-01-01T09:00:00.000Z' });
store.invalidateFact({ id: invalidated.id, reason: 'lisans iptal edildi', validTo: '2026-05-01T09:00:00.000Z' });

const factOf = (query, opts = {}) => {
  const facts = store.listFacts({ ...ATLAS, q: query, includeHistorical: true, ...opts });
  if (!facts.length) throw new Error(`senaryo kaydi bulunamadi: ${query}`);
  return facts[0];
};
const wsDecision = factOf('WebSocket');
const ciAcik = store.factTimeline({ ...ATLAS, subject: 'CI pipeline kur' }).slots[0];

// --- soru seti ---
const TOP_K = 3;
const questions = [];
const current = (q, expectText, forbidText = null, scope = ATLAS) =>
  questions.push({ type: 'current', q, run: () => topFacts({ ...scope, query: q }), expectText, forbidText });
const historical = (q, opts, check) => questions.push({ type: 'historical', q, run: () => opts.timeline
  ? store.factTimeline(opts.timeline)
  : topFacts({ ...(opts.scope || ATLAS), query: opts.query || q, asOf: opts.asOf, includeHistorical: opts.includeHistorical }), check });
const provenance = (q, factId, check) => questions.push({ type: 'provenance', q, run: () => store.factProvenance(factId), check });

function topFacts(input) {
  const result = store.recall({ ...input, explain: true, noTouch: true, limit: 12 });
  return result.results.filter((item) => item.sourceType === 'fact').slice(0, TOP_K);
}
const hasText = (items, text) => items.some((item) => `${item.title} ${item.text}`.includes(text));

// 12 current soru
current('kullanici su an hangi editoru kullaniyor', 'Zed', 'VSCode');
current('kullanici editor', 'Zed', 'Neovim');
current('kullanici hangi temayi tercih ediyor', 'koyu tema', 'acik tema');
current('kullanici tema tercihi nedir', 'koyu tema');
current('Atlas hangi veritabanini kullaniyor', 'Postgres', 'SQLite');
current('Atlas veritabani', 'Postgres');
current('Atlas bulut saglayicisi hangisi', 'AWS');            // disputed Hetzner one gecmemeli
current('Atlas bulut', 'AWS', null);
current('Bozkir hangi dili kullaniyor', 'Rust', null, BOZKIR);
current('Bozkir dil', 'Rust', null, BOZKIR);
current('gercek zamanli katman karari nedir', 'WebSocket');
current('kimlik dogrulama nasil yapilacak', 'cihaz anahtari');

// 12 historical soru
historical('kullanici mart ayinda hangi editoru kullaniyordu', { query: 'kullanici editor', asOf: '2026-03-01T00:00:00.000Z' },
  (items) => hasText(items, 'VSCode') && !hasText(items, 'Neovim') && !hasText(items, 'Zed'));
historical('kullanici mayis ayinda hangi editoru kullaniyordu', { query: 'kullanici editor', asOf: '2026-05-01T00:00:00.000Z' },
  (items) => hasText(items, 'Neovim') && !hasText(items, 'Zed'));
historical('kullanici subat ayinda hangi temayi tercih ediyordu', { query: 'kullanici tema', asOf: '2026-02-01T00:00:00.000Z' },
  (items) => hasText(items, 'acik tema') && !hasText(items, 'koyu tema'));
historical('kullanici nisan ayinda hangi temayi tercih ediyordu', { query: 'kullanici tema', asOf: '2026-04-01T00:00:00.000Z' },
  (items) => hasText(items, 'koyu tema') && !hasText(items, 'acik tema'));
historical('Atlas mart ayinda hangi veritabanini kullaniyordu', { query: 'Atlas veritabani', asOf: '2026-03-01T00:00:00.000Z' },
  (items) => hasText(items, 'SQLite') && !hasText(items, 'Postgres'));
historical('Atlas haziran ayinda hangi veritabanini kullaniyordu', { query: 'Atlas veritabani', asOf: '2026-06-15T00:00:00.000Z' },
  (items) => hasText(items, 'Postgres') && !hasText(items, 'SQLite'));
historical('editor bilgisi kac kez degisti', { timeline: { ...ATLAS, subject: 'kullanici', predicate: 'kullanir' } },
  (tl) => (tl.slots.find((slot) => slot.slot.includes('topic:editor'))?.versions.length || 0) === 3);
historical('VSCode bilgisi ne zaman gecersiz oldu', { timeline: { ...ATLAS, subject: 'kullanici', predicate: 'kullanir' } },
  (tl) => tl.slots.flatMap((slot) => slot.versions).find((v) => v.object === 'VSCode')?.validTo === '2026-04-02T09:00:00.000Z');
historical('SQLite bilgisi ne zaman gecersiz oldu', { timeline: { ...ATLAS, subject: 'Atlas', predicate: 'kullanir' } },
  (tl) => tl.slots.flatMap((slot) => slot.versions).find((v) => v.object === 'SQLite')?.validTo === '2026-05-10T09:00:00.000Z');
historical('demo lisansi ne zaman gecersiz kilindi', { timeline: { ...ATLAS, subject: 'Atlas', predicate: 'sahip' } },
  (tl) => {
    const v = tl.slots.flatMap((slot) => slot.versions).find((item) => item.object === 'demo lisansi');
    return v?.status === 'invalidated' && v?.validTo === '2026-05-01T09:00:00.000Z';
  });
historical('bulut bilgisi neden ihtilafli', { timeline: { ...ATLAS, subject: 'Atlas', predicate: 'kullanir' } },
  (tl) => {
    const versions = tl.slots.find((slot) => slot.slot.includes('topic:bulut'))?.versions || [];
    return versions.some((v) => v.object === 'Hetzner' && v.status === 'disputed')
      && versions.some((v) => v.object === 'AWS' && v.status === 'active');
  });
historical('gecmis dahil edilince eski editor kayitlari da gorunur', { query: 'kullanici editor', includeHistorical: true },
  (items) => hasText(items, 'Zed') && (hasText(items, 'Neovim') || hasText(items, 'VSCode')));

// 8 provenance sorusu
provenance('WebSocket karari hangi checkpointten geldi', wsDecision.id,
  (prov) => prov.source.checkpoint?.id === chk1.id);
provenance('WebSocket karari hangi oturumdan geldi', wsDecision.id,
  (prov) => prov.source.session?.id === ses.session.id);
provenance('WebSocket kararini hangi ajan yazdi', wsDecision.id,
  (prov) => prov.source.agent === 'codex');
provenance('CI gorevi neden acik degil (kim kapatti)', ciAcik.current?.id || ciAcik.versions[ciAcik.versions.length - 1].id,
  (prov) => prov.source.checkpoint?.id === chk2.id && prov.fact.object === 'tamamlandi');
provenance('CI gorevinin onceki versiyonu acik miydi', ciAcik.current?.id || ciAcik.versions[ciAcik.versions.length - 1].id,
  (prov) => prov.history.previous.some((item) => item.object === 'acik' && item.status === 'superseded'));
provenance('Zed bilgisinin onceki versiyonu Neovim mi', editorV3.id,
  (prov) => prov.history.previous.some((item) => item.object === 'Neovim'));
provenance('Neovim bilgisinin yerine gecen bilgi Zed mi', editorV2.id,
  (prov) => store.factProvenance(editorV2.id).history.next.some((item) => item.object === 'Zed'));
provenance('provenance aciklamasi insan-okur mu', wsDecision.id,
  (prov) => /oturum/.test(prov.explanation) && /checkpoint/.test(prov.explanation));

// --- calistir ve raporla ---
const results = { current: [], historical: [], provenance: [] };
for (const question of questions) {
  let pass = false;
  let detail = '';
  try {
    const output = question.run();
    if (question.type === 'current') {
      pass = hasText(output, question.expectText) && (!question.forbidText || !hasText(output, question.forbidText));
      if (!pass) detail = `ilk ${TOP_K} fact: ${output.map((item) => item.text).join(' | ') || '(bos)'}`;
    } else {
      pass = !!question.check(output);
    }
  } catch (error) { detail = String(error.message || error); }
  results[question.type].push({ q: question.q, pass, detail });
}

function metric(name, list) {
  const passed = list.filter((item) => item.pass).length;
  const pct = list.length ? Math.round((passed / list.length) * 100) : 0;
  console.log(`${name}: ${passed}/${list.length} (%${pct})`);
  for (const item of list.filter((entry) => !entry.pass)) console.log(`  ✗ ${item.q}${item.detail ? ` — ${item.detail}` : ''}`);
  return pct;
}

console.log(`Temporal hafiza degerlendirmesi — ${questions.length} soru\n`);
const currentPct = metric('current recall   ', results.current);
const historicalPct = metric('historical recall', results.historical);
const provenancePct = metric('provenance accuracy', results.provenance);
console.log(`\nozet: current %${currentPct} · historical %${historicalPct} · provenance %${provenancePct}`);

fs.rmSync(dataDir, { recursive: true, force: true });
const THRESHOLD = 80;
if (currentPct < THRESHOLD || historicalPct < THRESHOLD || provenancePct < THRESHOLD) {
  console.error(`\nesik %${THRESHOLD} altinda kalan metrik var`);
  process.exitCode = 1;
}
