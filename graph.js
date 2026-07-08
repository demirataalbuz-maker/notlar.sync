// Zihin haritasi: notes/*.md dosyalarini (frontmatter + [[wikilink]]) tarayip
// dugum/kenar grafi cikarir. Uygulamanin "zihni": AI'lar hook ile notlara yazar,
// buradan otomatik harita olusur, hem /api/graph (AI icin) hem 🕸 sekmesi (insan icin).
// Bagimliliksiz saf JS - ~/zihin-haritasi'ndaki Python md-mode'un Node karsiligi.
'use strict';
const fs = require('fs');
const path = require('path');

// Obsidian gibi: kapanmamis "[[ ..." ya da satir atlayan aday SAYILMAZ
// (duz metinde "[[ autocomplete" diye soz etmek sahte dugum uretmesin)
const LINK_RE = /\[\[([^\]|#\n]+)[^\]\n]*\]\]/g;
// tipli baglanti (Dataview uslubu): `iliski:: [[hedef]]` -> kenara iliski adi yazilir
const TYPED_RE = /([\p{L}][\p{L}\d _-]{0,30})::[ \t]*\[\[([^\]|#\n]+)[^\]\n]*\]\]/gu;

// isim normalizasyonu: "Köpek Bakımı" == "kopek-bakimi" == "KOPEK BAKIMI".
// Kucuk harf + turkce aksan katlama + bosluk/tire/altcizgi esitleme; boylece
// yazim farklari sahte hayalet dugum uretmez. Gosterilen ad ilk gorulen halidir.
function normName(s) {
  return s.trim().toLowerCase()
    .replace(/ı/g, 'i').replace(/ğ/g, 'g').replace(/ü/g, 'u')
    .replace(/ş/g, 's').replace(/ö/g, 'o').replace(/ç/g, 'c')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[\s_-]+/g, ' ');
}

function parseFrontmatter(text) {
  const meta = { name: null, description: '', type: 'not' };
  if (!text.startsWith('---')) return { meta, body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { meta, body: text };
  const fm = text.slice(3, end);
  const body = text.slice(end + 4).replace(/^\n+/, '');
  let section = null;
  for (const line of fm.split('\n')) {
    if (!line.trim()) continue;
    const indented = /^[ \t]/.test(line);
    const i = line.indexOf(':');
    if (i === -1) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if (val.length >= 2 && val[0] === val[val.length - 1] && (val[0] === '"' || val[0] === "'"))
      val = val.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'");
    if (!indented) { section = key; if (val) meta[key] = val; }
    else if (section === 'metadata' && key === 'type') meta.type = val;
  }
  return { meta, body };
}

// [{ t: hedef, rel: iliski|null }] - once tipli linkler bulunur, ayni hedefin
// tipsiz tekrari elenir (tip bilgisi kaybolmasin).
// Kod bloklari (```) ve satir ici kod (`...`) taranmaz - Obsidian da saymaz;
// boylece "[[ornek]]" diye SOZ EDEN kilavuz metinleri sahte kenar uretmez.
function collectLinks(body) {
  body = body.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  const out = new Map(); // normHedef -> {t, rel}
  let m;
  TYPED_RE.lastIndex = 0;
  while ((m = TYPED_RE.exec(body))) {
    const t = m[2].trim();
    out.set(normName(t), { t, rel: m[1].trim().toLowerCase() });
  }
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(body))) {
    const t = m[1].trim();
    if (!out.has(normName(t))) out.set(normName(t), { t, rel: null });
  }
  return [...out.values()];
}

// label propagation ile topluluk (obek) tespiti - deterministik
function detectCommunities(ids, edges) {
  const sorted = [...ids].sort();
  const label = new Map(sorted.map((n, i) => [n, i]));
  const neigh = new Map(sorted.map((n) => [n, new Set()]));
  for (const [a, b] of edges) { neigh.get(a).add(b); neigh.get(b).add(a); }
  for (let iter = 0; iter < 30; iter++) {
    let changed = false;
    for (const n of sorted) {
      const ns = neigh.get(n);
      if (!ns.size) continue;
      const counts = new Map();
      for (const m of ns) counts.set(label.get(m), (counts.get(label.get(m)) || 0) + 1);
      let top = -1, best = Infinity;
      for (const [l, c] of counts) if (c > top || (c === top && l < best)) { top = c; best = l; }
      if (best !== label.get(n)) { label.set(n, best); changed = true; }
    }
    if (!changed) break;
  }
  // buyuk obek kucuk numara alsin
  const freq = new Map();
  for (const l of label.values()) freq.set(l, (freq.get(l) || 0) + 1);
  const order = [...freq.entries()].sort((a, b) => b[1] - a[1]);
  const renum = new Map(order.map(([l], i) => [l, i]));
  const out = new Map();
  for (const [n, l] of label) out.set(n, renum.get(l));
  return out;
}

// notes dizinini tarayip {nodes, edges, communities} grafi dondurur.
// Dugum anahtari normalize isimdir; ayni ada cikan yazim farklari birlesir.
function buildGraph(notesDir, { hideHidden = false } = {}) {
  let files = [];
  try {
    files = fs.readdirSync(notesDir).filter((f) => f.endsWith('.md')).sort();
  } catch { return { nodes: [], edges: [], communities: [] }; }

  const nodes = new Map(); // normId -> dugum
  const rawEdges = [];     // [normKaynak, {t, rel}]

  for (const f of files) {
    const stem = f.slice(0, -3);
    if (hideHidden && /^AI-Hafiza/i.test(stem)) continue; // ayarlar'daki gizleme ile ayni mantik
    let text = '';
    try { text = fs.readFileSync(path.join(notesDir, f), 'utf8'); } catch { continue; }
    const { meta, body } = parseFrontmatter(text);
    const label = meta.name || stem;
    const id = normName(label);
    nodes.set(id, {
      id, label, type: meta.type || 'not',
      description: meta.description || firstLine(body),
      file: f, ghost: false,
    });
    for (const link of collectLinks(body)) rawEdges.push([id, link]);
  }

  // gizli modda AI-Hafiza'ya isaret eden kenarlar da atilir (hayalet olarak sizmasin)
  const visEdges = hideHidden ? rawEdges.filter(([, l]) => !/^AI-Hafiza/i.test(l.t)) : rawEdges;

  // linki verilen ama dosyasi olmayan hedef -> hayalet dugum (normalize anahtarla,
  // "Kopek Bakimi" ve "köpek bakımı" tek hayalette birlesir)
  for (const [, l] of visEdges) {
    const tid = normName(l.t);
    if (!nodes.has(tid)) nodes.set(tid, {
      id: tid, label: l.t, type: 'ghost',
      description: 'Henuz yazilmamis / bulunamadi.', file: null, ghost: true,
    });
  }

  // oz-dongu ve tekrari at (tipli kenar tipsiz kopyasini ezer) - atilanlar
  // SAYILIR ve rapora yazilir: sessizce hicbir sey yutulmaz (saglik kontrolu)
  const seen = new Map();
  let ozdongu = 0, cift = 0;
  for (const [a, l] of visEdges) {
    const b = normName(l.t);
    if (a === b) { ozdongu++; continue; }
    const k = a + '\0' + b;
    if (seen.has(k)) {
      cift++;
      if (l.rel && !seen.get(k).relation) seen.set(k, { source: a, target: b, relation: l.rel });
      continue;
    }
    seen.set(k, { source: a, target: b, relation: l.rel || null });
  }
  const edges = [...seen.values()];
  const pairList = edges.map((e) => [e.source, e.target]);

  const degree = new Map([...nodes.keys()].map((n) => [n, 0]));
  for (const [a, b] of pairList) { degree.set(a, degree.get(a) + 1); degree.set(b, degree.get(b) + 1); }
  const comm = detectCommunities(nodes.keys(), pairList);

  const nodeList = [...nodes.values()].map((n) => ({
    ...n, degree: degree.get(n.id), community: comm.get(n.id),
  }));

  // obek isimlendirme: en yuksek dereceli (esitse alfabetik ilk) uyenin adi.
  // LLM'siz, deterministik - "indir calissin" kuralina uyar.
  const byComm = new Map();
  for (const n of nodeList) {
    if (!byComm.has(n.community)) byComm.set(n.community, []);
    byComm.get(n.community).push(n);
  }
  const communities = [...byComm.entries()].sort((a, b) => a[0] - b[0]).map(([id, ns]) => {
    const rep = ns.slice().sort((a, b) => b.degree - a.degree || a.label.localeCompare(b.label, 'tr'))[0];
    return { id, name: rep.label + ' çevresi', size: ns.length };
  });

  return { nodes: nodeList, edges, communities, saglik: { ozdongu, cift } };
}

// --- rapor zekasi: grafi "kesfedilir" yapan analizler (LLM'siz, deterministik) ---
// Graphify'in GRAPH_REPORT.md'sindeki uc fikrin karsiligi: obek butunlugu
// (cohesion), sasirtici baglantilar (iki obek arasindaki TEK kopru) ve
// haritanin kendisinden uretilen "sorulmaya deger" sorular.
function buildReport(g) {
  const real = g.nodes.filter((n) => !n.ghost);
  const god = [...g.nodes].sort((a, b) => b.degree - a.degree)
    .filter((n) => n.degree >= 3 && !n.ghost).slice(0, 8)
    .map((n) => ({ label: n.label, degree: n.degree, type: n.type }));
  const orphans = real.filter((n) => n.degree === 0).map((n) => n.label);
  const ghosts = g.nodes.filter((n) => n.ghost).map((n) => n.label);

  // obek butunlugu: ic kenar / (ic + disa acilan kenar). 1.0 = tamamen icine
  // donuk obek, dusuk deger = zorlama gruplama ya da kopru-agirlikli obek.
  const comm = new Map(g.nodes.map((n) => [n.id, n.community]));
  const ic = new Map(), dis = new Map();
  for (const e of g.edges) {
    const ca = comm.get(e.source), cb = comm.get(e.target);
    if (ca === cb) ic.set(ca, (ic.get(ca) || 0) + 1);
    else { dis.set(ca, (dis.get(ca) || 0) + 1); dis.set(cb, (dis.get(cb) || 0) + 1); }
  }
  const topluluklar = g.communities.filter((c) => c.size >= 3).map((c) => {
    const i = ic.get(c.id) || 0, d = dis.get(c.id) || 0;
    return { ...c, butunluk: i + d ? +(i / (i + d)).toFixed(2) : 0 };
  });

  // sasirtici baglantilar: iki obegi birbirine baglayan TEK kenar. Kendi
  // basina bakarken fark edilmez - haritanin en degerli kesif cikttisi.
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const nameOf = new Map(g.communities.map((c) => [c.id, c.name]));
  const sizeOf = new Map(g.communities.map((c) => [c.id, c.size]));
  const koprular = new Map(); // "obekA|obekB" -> [kenarlar]
  for (const e of g.edges) {
    const ca = comm.get(e.source), cb = comm.get(e.target);
    if (ca === cb) continue;
    const k = Math.min(ca, cb) + '|' + Math.max(ca, cb);
    if (!koprular.has(k)) koprular.set(k, []);
    koprular.get(k).push(e);
  }
  const sasirtici = [];
  for (const [k, es] of koprular) {
    if (es.length !== 1) continue;
    const [ca, cb] = k.split('|').map(Number);
    if ((sizeOf.get(ca) || 0) < 3 || (sizeOf.get(cb) || 0) < 3) continue;
    const e = es[0], a = byId.get(e.source), b = byId.get(e.target);
    sasirtici.push({
      a: a.label, b: b.label, relation: e.relation,
      obekA: nameOf.get(ca), obekB: nameOf.get(cb),
      agirlik: a.degree + b.degree,
    });
  }
  sasirtici.sort((x, y) => y.agirlik - x.agirlik);
  const sasirticiTop = sasirtici.slice(0, 5).map(({ agirlik, ...s }) => s);

  // onerilen sorular: graf yapisindan uretilir, sablon + gercek veriler
  const sorular = [];
  for (const s of sasirticiTop.slice(0, 2))
    sorular.push(`"${s.a}" ile "${s.b}" iki ayrı öbeğin (${s.obekA} / ${s.obekB}) TEK köprüsü — bu bağ derinleştirilmeli mi?`);
  if (god[0])
    sorular.push(`"${god[0].label}" haritanın en merkezi düğümü (${god[0].degree} bağlantı) — alt konulara bölünse daha mı okunur olur?`);
  for (const o of orphans.slice(0, 2))
    sorular.push(`"${o}" hiçbir şeye bağlı değil — hangi nota [[${o}]] diye bağlanmalı?`);
  // hic koprusu olmayan iki buyuk obek: belki olmasi gereken bir iliski eksik
  const buyukler = topluluklar.slice(0, 4);
  dis_dongu:
  for (let i = 0; i < buyukler.length; i++)
    for (let j = i + 1; j < buyukler.length; j++) {
      const k = Math.min(buyukler[i].id, buyukler[j].id) + '|' + Math.max(buyukler[i].id, buyukler[j].id);
      if (!koprular.has(k)) {
        sorular.push(`"${buyukler[i].name}" ile "${buyukler[j].name}" öbekleri arasında hiç bağlantı yok — olması gereken bir ilişki var mı?`);
        break dis_dongu;
      }
    }

  return {
    dugum: g.nodes.length, kenar: g.edges.length,
    saglik: {
      ...(g.saglik || { ozdongu: 0, cift: 0 }),
      kirikLink: ghosts.length,
      durum: (g.saglik && (g.saglik.ozdongu || g.saglik.cift)) || ghosts.length
        ? 'uyari' : 'temiz',
    },
    godNodes: god, yetimler: orphans, kirikLinkler: ghosts,
    topluluklar, sasirtici: sasirticiTop, sorular: sorular.slice(0, 5),
  };
}

// bir dugumu komsulariyla anlat (graphify'in `explain` komutunun karsiligi)
function explainNode(graph, name) {
  const id = normName(name);
  const node = graph.nodes.find((n) => n.id === id);
  if (!node) return null;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const out = [], into = [];
  for (const e of graph.edges) {
    if (e.source === id) out.push({ node: byId.get(e.target).label, relation: e.relation });
    if (e.target === id) into.push({ node: byId.get(e.source).label, relation: e.relation });
  }
  const comm = graph.communities.find((c) => c.id === node.community);
  return { ...node, communityName: comm ? comm.name : null, out, in: into };
}

// iki dugum arasi en kisa yol (BFS, yon gozetmez); yoksa null
function shortestPath(graph, from, to) {
  const a = normName(from), b = normName(to);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  if (!byId.has(a) || !byId.has(b)) return null;
  const neigh = new Map(graph.nodes.map((n) => [n.id, []]));
  for (const e of graph.edges) { neigh.get(e.source).push(e.target); neigh.get(e.target).push(e.source); }
  const prev = new Map([[a, null]]);
  const q = [a];
  while (q.length) {
    const cur = q.shift();
    if (cur === b) {
      const path = [];
      for (let n = b; n !== null; n = prev.get(n)) path.unshift(byId.get(n).label);
      return path;
    }
    for (const m of neigh.get(cur)) if (!prev.has(m)) { prev.set(m, cur); q.push(m); }
  }
  return null;
}

function firstLine(body) {
  const line = (body || '').split('\n').find((l) => l.trim());
  return line ? line.replace(/^#+\s*/, '').trim().slice(0, 160) : '';
}

module.exports = { buildGraph, buildReport, parseFrontmatter, collectLinks, detectCommunities, normName, explainNode, shortestPath };
