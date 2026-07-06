// Zihin haritasi: notes/*.md dosyalarini (frontmatter + [[wikilink]]) tarayip
// dugum/kenar grafi cikarir. Uygulamanin "zihni": AI'lar hook ile notlara yazar,
// buradan otomatik harita olusur, hem /api/graph (AI icin) hem 🕸 sekmesi (insan icin).
// Bagimliliksiz saf JS - ~/zihin-haritasi'ndaki Python md-mode'un Node karsiligi.
'use strict';
const fs = require('fs');
const path = require('path');

const LINK_RE = /\[\[([^\]|#]+)/g;

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

function collectLinks(body) {
  const out = new Set();
  let m;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(body))) out.add(m[1].trim());
  return [...out];
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

// notes dizinini tarayip {nodes, edges} grafi dondurur
function buildGraph(notesDir, { hideHidden = false } = {}) {
  let files = [];
  try {
    files = fs.readdirSync(notesDir).filter((f) => f.endsWith('.md')).sort();
  } catch { return { nodes: [], edges: [] }; }

  const nodes = new Map();
  const rawEdges = [];

  for (const f of files) {
    const stem = f.slice(0, -3);
    if (hideHidden && /^AI-Hafiza/i.test(stem)) continue; // ayarlar'daki gizleme ile ayni mantik
    let text = '';
    try { text = fs.readFileSync(path.join(notesDir, f), 'utf8'); } catch { continue; }
    const { meta, body } = parseFrontmatter(text);
    const id = meta.name || stem;
    nodes.set(id, {
      id, label: id, type: meta.type || 'not',
      description: meta.description || firstLine(body),
      file: f, ghost: false,
    });
    for (const t of collectLinks(body)) rawEdges.push([id, t]);
  }

  // gizli modda AI-Hafiza'ya isaret eden kenarlar da atilir (hayalet olarak sizmasin)
  const visEdges = hideHidden ? rawEdges.filter(([, t]) => !/^AI-Hafiza/i.test(t)) : rawEdges;

  // linki verilen ama dosyasi olmayan hedef -> hayalet dugum
  for (const [, t] of visEdges) {
    if (!nodes.has(t)) nodes.set(t, {
      id: t, label: t, type: 'ghost',
      description: 'Henuz yazilmamis / bulunamadi.', file: null, ghost: true,
    });
  }

  // oz-dongu ve tekrari at
  const seen = new Set();
  const edges = [];
  for (const [a, b] of visEdges) {
    if (a === b || seen.has(a + '\0' + b)) continue;
    seen.add(a + '\0' + b);
    edges.push([a, b]);
  }

  const degree = new Map([...nodes.keys()].map((n) => [n, 0]));
  for (const [a, b] of edges) { degree.set(a, degree.get(a) + 1); degree.set(b, degree.get(b) + 1); }
  const comm = detectCommunities(nodes.keys(), edges);

  const nodeList = [...nodes.values()].map((n) => ({
    ...n, degree: degree.get(n.id), community: comm.get(n.id),
  }));
  const edgeList = edges.map(([a, b]) => ({ source: a, target: b, ambiguous: false }));
  return { nodes: nodeList, edges: edgeList };
}

function firstLine(body) {
  const line = (body || '').split('\n').find((l) => l.trim());
  return line ? line.replace(/^#+\s*/, '').trim().slice(0, 160) : '';
}

module.exports = { buildGraph, parseFrontmatter, collectLinks, detectCommunities };
