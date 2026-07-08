// AI zihni katmani: oneri kuyrugu + kabul/ret dongusu + URL'den not.
// Felsefe: tek gercek kaynak NOTLARDIR. AI (Ollama ya da disaridan bir ajan,
// or. Claude) grafi DEGISTIREMEZ - sadece ONERIR. Oneriler zihin.json
// kuyrugunda bekler, kullanici haritada kabul edince [[link]] notun icine
// yazilir, reddedince ayni cift bir daha ONERILEMEZ (ret hafizasi).
// Her karar AI-Hafiza-Zihin-Gunlugu notuna islenir (senkron + geri izlenebilir).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normName } = require('./graph');

const DOSYA = 'zihin.json';
// AI-Hafiza oneki bilincli: gunluk, haritadaki 🧠 anahtariyla birlikte gizlenir
const GUNLUK_NOTU = 'AI-Hafiza-Zihin-Gunlugu';

function load(dataDir) {
  try {
    const st = JSON.parse(fs.readFileSync(path.join(dataDir, DOSYA), 'utf8'));
    return { oneriler: st.oneriler || [], reddedilen: st.reddedilen || [] };
  } catch { return { oneriler: [], reddedilen: [] }; }
}

function save(dataDir, st) {
  fs.writeFileSync(path.join(dataDir, DOSYA), JSON.stringify(st, null, 1));
}

const pairKey = (a, b) => [a, b].sort().join('|');

function simdi() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// gecerliligini yitiren onerileri dusur: dugumu silinmis ya da kullanici
// linki elle zaten eklemis. Kuyruk hep guncel gercege gore sunulur.
function prune(dataDir, graph) {
  const st = load(dataDir);
  const var_ = new Set(graph.nodes.filter((n) => !n.ghost).map((n) => n.id));
  const kenar = new Set(graph.edges.map((e) => pairKey(e.source, e.target)));
  const kalan = st.oneriler.filter((o) =>
    var_.has(o.source) && var_.has(o.target) && !kenar.has(pairKey(o.source, o.target)));
  if (kalan.length !== st.oneriler.length) { st.oneriler = kalan; save(dataDir, st); }
  return st;
}

// oneri ekle (Ollama'dan ya da dis AI ajandan). items: [{a,b,neden}] - a/b
// not adi ya da normalize id olabilir. Uydurma isim, mevcut kenar, kuyrukta
// bekleyen ve daha once REDDEDILMIS ciftler elenir. Donen: gercekten eklenenler.
function addSuggestions(dataDir, graph, items, kaynak) {
  const st = load(dataDir);
  const red = new Set(st.reddedilen);
  const kenar = new Set(graph.edges.map((e) => pairKey(e.source, e.target)));
  const kuyrukta = new Set(st.oneriler.map((o) => pairKey(o.source, o.target)));
  const byId = new Map(graph.nodes.filter((n) => !n.ghost).map((n) => [n.id, n]));
  const eklenen = [];
  for (const it of Array.isArray(items) ? items : []) {
    const a = byId.get(normName(String(it.a || it.source || '')));
    const b = byId.get(normName(String(it.b || it.target || '')));
    if (!a || !b || a.id === b.id) continue;
    const k = pairKey(a.id, b.id);
    if (red.has(k) || kenar.has(k) || kuyrukta.has(k)) continue;
    kuyrukta.add(k);
    const o = {
      id: crypto.randomBytes(5).toString('hex'),
      source: a.id, target: b.id, sourceLabel: a.label, targetLabel: b.label,
      neden: String(it.neden || '').slice(0, 120),
      kaynak: kaynak || 'ollama', tarih: simdi(),
    };
    st.oneriler.push(o);
    eklenen.push(o);
  }
  if (eklenen.length) save(dataDir, st);
  return eklenen;
}

// kabul: oneriyi kuyruktan cikarir ve geri verir; [[link]]'i notun icine
// yazmak cagiranin isi (not yazma yolu server'da tek: saveNote + broadcast)
function kabul(dataDir, id) {
  const st = load(dataDir);
  const i = st.oneriler.findIndex((o) => o.id === id);
  if (i === -1) return null;
  const [o] = st.oneriler.splice(i, 1);
  save(dataDir, st);
  return o;
}

// ret: cift kalici ret listesine girer, bir daha onerilemez
function reddet(dataDir, id) {
  const st = load(dataDir);
  const i = st.oneriler.findIndex((o) => o.id === id);
  if (i === -1) return null;
  const [o] = st.oneriler.splice(i, 1);
  if (!st.reddedilen.includes(pairKey(o.source, o.target)))
    st.reddedilen.push(pairKey(o.source, o.target));
  save(dataDir, st);
  return o;
}

// --- URL'den not: sayfayi indir, metne cevir (Graphify'in `add <url>`u) ---

function fetchPage(url, cb, depth = 0) {
  let u;
  try { u = new URL(url); } catch { return cb('gecersiz URL'); }
  if (!/^https?:$/.test(u.protocol)) return cb('sadece http/https desteklenir');
  const mod = u.protocol === 'https:' ? require('https') : require('http');
  const req = mod.get(u, {
    headers: { 'User-Agent': 'Mozilla/5.0 (NotlarSync)', 'Accept': 'text/html,*/*' },
    timeout: 15000,
  }, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && depth < 3) {
      res.resume();
      return fetchPage(new URL(res.headers.location, u).href, cb, depth + 1);
    }
    if (res.statusCode !== 200) { res.resume(); return cb('HTTP ' + res.statusCode); }
    const chunks = [];
    let size = 0;
    res.on('data', (c) => { chunks.push(c); size += c.length; if (size > 3e6) req.destroy(); });
    res.on('end', () => cb(null, Buffer.concat(chunks).toString('utf8')));
  });
  req.on('error', (e) => cb(e.message));
  req.on('timeout', () => { req.destroy(); cb('zaman asimi (15sn)'); });
}

function decodeEntities(s) {
  const map = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, e) => map[e.toLowerCase()] || m);
}

// kaba ama bagimliliksiz HTML->metin: script/style/nav atilir, blok kapanis
// etiketleri satir sonuna cevrilir, kalan etiketler sokulur
function htmlToText(html) {
  const title = decodeEntities(
    (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ''])[1]).replace(/\s+/g, ' ').trim();
  let t = html
    .replace(/<script[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<(nav|footer|aside)[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|h[1-6]|li|tr|section|article)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  t = decodeEntities(t)
    .replace(/[ \t]+/g, ' ')
    .split('\n').map((l) => l.trim()).filter(Boolean).join('\n')
    .replace(/\n{3,}/g, '\n\n');
  return { title, text: t };
}

// --- embedding katmani: anlam benzerligi ile oneri (nomic-embed vb.) ---
// Kisa etiket dersi (zihin-haritasi'nda olculdu): kisa metinlerde model
// benzerligi sisiriyor (alakasiz iki isim 0.96 cikti) -> sadece >=15
// karakter aciklamali dugumler embed edilir. Vektorler onbelleklenir.
const http = require('http');
const MIN_DESC = 15;
const ESIK = 0.85;
const DUGUM_BASI_MAX = 3;
const EMBED_IPUCLARI = ['embed', 'bge', 'minilm', 'mxbai', 'arctic', 'nomic'];

function ollamaJson(pathname, payload, cb) {
  const body = payload ? JSON.stringify(payload) : null;
  const req = http.request({
    host: '127.0.0.1', port: 11434, path: pathname,
    method: body ? 'POST' : 'GET', timeout: 120000,
    headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {},
  }, (res) => {
    let d = '';
    res.on('data', (c) => d += c);
    res.on('end', () => { try { cb(null, JSON.parse(d)); } catch { cb('cozulemedi'); } });
  });
  req.on('error', (e) => cb(e.message));
  req.on('timeout', () => { req.destroy(); cb('zaman asimi'); });
  req.end(body);
}

function findEmbedModel(cb) {
  ollamaJson('/api/tags', null, (err, d) => {
    if (err) return cb(null);
    const m = (d.models || []).find((x) => EMBED_IPUCLARI.some((h) => x.name.toLowerCase().includes(h)));
    cb(m ? m.name : null);
  });
}

const kosinus = (a, b) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
};

// dugumun anlam metni: etiket + aciklama + NOT GOVDESI (ilk ~500 karakter,
// frontmatter atilir). Boylece frontmatter'siz notlar da anlam katmanina
// gorunur - sadece description'a bakmak korluk yaratiyordu.
function nodeMetin(n, readNote) {
  const ham = n.file && readNote ? (readNote(n.file.replace(/\.md$/, '')) || '') : '';
  const govde = ham.replace(/^---[\s\S]*?---\s*/, '').replace(/\s+/g, ' ').trim();
  return (n.label + ': ' + (n.description || '') + ' ' + govde).slice(0, 500);
}

// dugum vektorlerini getir: SHA256 onbellekli (metin degisince anahtar da
// degisir, eski vektor kullanilmaz), eksikler tek istekte Ollama'ya.
// Hem semantik oneri hem GraphRAG tohum bulma ayni onbellegi paylasir.
function vektorler(dataDir, model, adaylar, readNote, cb) {
  const metin = (n) => nodeMetin(n, readNote);
  const anahtar = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 24);
  const cachePath = path.join(dataDir, 'embed-cache.json');
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch {}
  const eksik = adaylar.filter((n) => !cache[anahtar(metin(n))]);
  const bitir = () => {
    try { fs.writeFileSync(cachePath, JSON.stringify(cache)); } catch {}
    cb(new Map(adaylar.map((n) => [n.id, cache[anahtar(metin(n))]])
      .filter(([, v]) => v)));
  };
  if (!eksik.length) return bitir();
  ollamaJson('/api/embed', { model, input: eksik.map(metin) }, (err, d) => {
    if (!err && Array.isArray(d.embeddings))
      eksik.forEach((n, i) => { cache[anahtar(metin(n))] = d.embeddings[i]; });
    bitir();
  });
}

// grafin anlamsal ikizlerini bul, oneri OGESI listesi dondur (kuyruga
// yazmayi cagiran yapar). Model yoksa bos liste - zarif atlama.
function semanticSuggest(dataDir, graph, readNote, cb) {
  findEmbedModel((model) => {
    if (!model) return cb([]);
    // kisa-etiket sisme dersi: anlam metni (aciklama+govde) MIN_DESC'ten
    // kisa dugumler embed edilmez - cirili iki isim 0.96 cikabiliyor
    const adaylar = graph.nodes.filter((n) => !n.ghost
      && nodeMetin(n, readNote).length >= n.label.length + 2 + MIN_DESC);
    if (adaylar.length < 2) return cb([]);
    vektorler(dataDir, model, adaylar, readNote, (vec) => {
      const ids = [...vec.keys()].sort();
      const ciftler = [];
      for (let i = 0; i < ids.length; i++)
        for (let j = i + 1; j < ids.length; j++) {
          const sim = kosinus(vec.get(ids[i]), vec.get(ids[j]));
          if (sim >= ESIK) ciftler.push([sim, ids[i], ids[j]]);
        }
      ciftler.sort((a, b) => b[0] - a[0]);
      const sayac = {};
      const items = [];
      for (const [sim, a, b] of ciftler) {
        if ((sayac[a] || 0) >= DUGUM_BASI_MAX || (sayac[b] || 0) >= DUGUM_BASI_MAX) continue;
        sayac[a] = (sayac[a] || 0) + 1;
        sayac[b] = (sayac[b] || 0) + 1;
        items.push({ a, b, neden: 'anlam benzerliği ' + sim.toFixed(2) });
      }
      cb(items);
    });
  });
}

// --- GraphRAG: soruyu grafta gez, ilgili notlarin icerigini topla, cevapla ---
// zihin-haritasi sorgu.py'nin JS portu. askOllama ve readNote disaridan gelir
// (not okuma yolu tek: server'in RAM'li readNote'u).
// Tohum bulma IKI katmanli: (1) kelime eslesme (hizli, model gerektirmez)
// (2) embedding benzerligi (Turkce ek/es-anlam sorununu cozer: "guvenlik"
// sorusu "guvenliginin" yazan notu da bulur). Model yoksa 1 tek basina calisir.
const TOHUM_ESIK = 0.55; // soru<->not benzerligi; ciftlerdeki 0.85'ten dusuk
                         // cunku soru kisa, not uzun - tam ikizlik beklenmez

function graphQuery(dataDir, graph, soru, readNote, askOllama, cb) {
  const kelime = (s) => s.toLowerCase()
    .replace(/ı/g, 'i').replace(/ğ/g, 'g').replace(/ü/g, 'u')
    .replace(/ş/g, 's').replace(/ö/g, 'o').replace(/ç/g, 'c')
    .split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  const sorular = new Set(kelime(soru));
  if (!sorular.size) return cb('soru cok kisa');

  // tohum dugumler: etiket/aciklamasinda soru kelimesi gecenler
  const skor = new Map();
  for (const n of graph.nodes) {
    if (n.ghost) continue;
    const metin = kelime(n.label + ' ' + (n.description || ''));
    let s = 0;
    for (const w of metin) if (sorular.has(w)) s++;
    if (s) skor.set(n.id, s);
  }
  const kelimeTohum = [...skor.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => id);

  // embedding tohumlari: soru vektorune en yakin 3 not (model yoksa atla)
  findEmbedModel((model) => {
    const adaylar = graph.nodes.filter((n) => !n.ghost
      && nodeMetin(n, readNote).length >= n.label.length + 2 + MIN_DESC);
    if (!model || !adaylar.length) return devam(kelimeTohum);
    ollamaJson('/api/embed', { model, input: [soru] }, (err, d) => {
      const soruVec = !err && Array.isArray(d.embeddings) ? d.embeddings[0] : null;
      if (!soruVec) return devam(kelimeTohum);
      vektorler(dataDir, model, adaylar, readNote, (vec) => {
        const yakin = [...vec.entries()]
          .map(([id, v]) => [kosinus(soruVec, v), id])
          .filter(([sim]) => sim >= TOHUM_ESIK)
          .sort((a, b) => b[0] - a[0]).slice(0, 3).map(([, id]) => id);
        devam([...new Set([...kelimeTohum, ...yakin])]);
      });
    });
  });

  function devam(tohumlar) {
  if (!tohumlar.length) return cb(null, { cevap: null, kullanilan: [], not: 'grafta eslesen dugum yok' });

  // BFS: tohumlardan 2 adim, en fazla 10 dugum (tohum iki katmandan gelebilir)
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const neigh = new Map(graph.nodes.map((n) => [n.id, []]));
  for (const e of graph.edges) {
    neigh.get(e.source).push(e.target);
    neigh.get(e.target).push(e.source);
  }
  const gezilen = new Set(tohumlar);
  let sinir = [...tohumlar];
  for (let derinlik = 0; derinlik < 2 && gezilen.size < 10; derinlik++) {
    const yeni = [];
    for (const id of sinir)
      for (const m of neigh.get(id) || [])
        if (!gezilen.has(m) && gezilen.size < 10 && !byId.get(m).ghost) { gezilen.add(m); yeni.push(m); }
    sinir = yeni;
  }

  // baglam: dugumlerin NOT ICERIKLERI (700'er karakter) + iliskiler
  const parcalar = [];
  const kullanilan = [];
  for (const id of gezilen) {
    const n = byId.get(id);
    kullanilan.push(n.label);
    const govde = n.file ? (readNote(n.file.replace(/\.md$/, '')) || '') : '';
    parcalar.push(`## ${n.label}\n${govde.slice(0, 700) || n.description || ''}`);
    if (parcalar.join('').length > 6000) break;
  }
  const iliskiler = graph.edges
    .filter((e) => gezilen.has(e.source) && gezilen.has(e.target))
    .map((e) => `${byId.get(e.source).label} -> ${byId.get(e.target).label}${e.relation ? ' (' + e.relation + ')' : ''}`)
    .slice(0, 20).join('\n');

  const prompt = `Kisinin kisisel notlarindan soruyla ilgili parcalar ve aralarindaki baglar asagida. SADECE bu bilgiye dayanarak soruyu Turkce, 2-5 cumleyle cevapla; hangi notlara dayandigini belirt. Bilgi yetmiyorsa "notlarda yok" de, uydurma.\n\nSORU: ${soru}\n\nBAGLAR:\n${iliskiler}\n\nNOTLAR:\n${parcalar.join('\n\n')}`;
  askOllama('qwen3:8b', prompt, (err, out) => {
    if (err) return cb(null, { cevap: null, kullanilan, hata: 'AI yok/kapali: ' + err });
    cb(null, { cevap: out, kullanilan });
  });
  } // devam
}

module.exports = {
  GUNLUK_NOTU, load, prune, addSuggestions, kabul, reddet, simdi,
  fetchPage, htmlToText, pairKey, semanticSuggest, graphQuery, findEmbedModel,
};
