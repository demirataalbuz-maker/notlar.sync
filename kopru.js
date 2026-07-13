// Belge ve graf köprüsü. Çekirdek motor uygulamayla gelir; ağır bileşenler
// Kurulum Merkezi tarafından ~/NotlarSync/runtime altına veya sisteme kurulur.
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const installer = require('./installer');

const MOTOR_DIR = installer.RUNTIME_DIR;

function python() {
  const candidate = process.platform === 'win32'
    ? path.join(installer.VENV_DIR, 'Scripts', 'python.exe')
    : path.join(installer.VENV_DIR, 'bin', 'python3');
  return fs.existsSync(candidate) ? candidate : null;
}

function durum(cb) {
  installer.status({}).then((state) => {
    const byId = new Map(state.components.map((component) => [component.id, component]));
    cb(null, {
      var: true,
      builtin: true,
      pdf: !!byId.get('pdf')?.ready,
      whisper: !!byId.get('speech')?.ready,
      vision: !!byId.get('ocr')?.ready || !!byId.get('vision-model')?.ready,
      ollama: !!byId.get('ollama-service')?.ready,
      eksik: state.components.filter((component) => !component.ready).map((component) => component.id),
    });
  }).catch((error) => cb(null, { var: true, builtin: true, hata: String(error.message || error) }));
}

function execJson(file, args, options, cb) {
  execFile(file, args, {
    timeout: options.timeout || 240000,
    maxBuffer: options.maxBuffer || 50e6,
    cwd: options.cwd || MOTOR_DIR,
    env: { ...process.env, ...(options.env || {}) },
  }, (error, stdout, stderr) => {
    if (error) return cb(String(stderr || error.message || 'işlem hatası').slice(-500));
    try { cb(null, options.raw ? { text: stdout, concepts: [] } : JSON.parse(stdout)); }
    catch { cb('motor çıktısı çözülemedi: ' + String(stdout).slice(0, 200)); }
  });
}

function ollamaVision(filePath, cb) {
  let image;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > 30e6) return cb('görsel vision modeli için 30 MB sınırını aşıyor');
    image = fs.readFileSync(filePath).toString('base64');
  } catch (error) { return cb(error.message); }
  const body = JSON.stringify({
    model: installer.VISION_MODEL,
    prompt: 'Bu görseldeki metni ve önemli bilgileri Türkçe, düz metin olarak çıkar.',
    images: [image],
    stream: false,
  });
  const req = http.request({
    host: '127.0.0.1', port: 11434, path: '/api/generate', method: 'POST', timeout: 180000,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, (res) => {
    let out = '';
    res.on('data', (chunk) => { out += chunk; if (out.length > 5e6) req.destroy(); });
    res.on('end', () => {
      try {
        const parsed = JSON.parse(out);
        if (res.statusCode !== 200) return cb(parsed.error || `Ollama HTTP ${res.statusCode}`);
        cb(null, { text: String(parsed.response || '').trim(), concepts: [] });
      } catch { cb('görsel modeli geçersiz yanıt verdi'); }
    });
  });
  req.on('timeout', () => req.destroy(new Error('görsel modeli zaman aşımı')));
  req.on('error', (error) => cb(error.message));
  req.end(body);
}

function belge(filePath, kind, cb) {
  if (kind === 'pdf') {
    const command = installer.bin('pdftotext');
    if (!command) return cb('PDF bileşeni eksik; Kurulum Merkezi üzerinden yükle');
    return execJson(command, [filePath, '-'], { raw: true }, cb);
  }
  if (kind === 'gorsel') {
    const command = installer.bin('tesseract');
    if (!command) return ollamaVision(filePath, cb);
    return execJson(command, [filePath, 'stdout', '-l', 'tur+eng'], { raw: true }, (error, result) => {
      if (!error && result.text.trim()) return cb(null, result);
      ollamaVision(filePath, (visionError, visionResult) => cb(visionError || error, visionResult));
    });
  }
  if (kind === 'ses' || kind === 'video') {
    const py = python();
    if (!py) return cb('Konuşma bileşeni eksik; Kurulum Merkezi üzerinden Faster Whisper yükle');
    const script = [
      'import json, sys',
      'from faster_whisper import WhisperModel',
      'model = WhisperModel("base", device="cpu", compute_type="int8", download_root=' + JSON.stringify(installer.MODEL_DIR) + ')',
      'segments, info = model.transcribe(sys.argv[1], vad_filter=True)',
      'text = " ".join(s.text.strip() for s in segments if s.text.strip())',
      'print(json.dumps({"text": text, "concepts": [], "language": info.language}, ensure_ascii=False))',
    ].join('\n');
    return execJson(py, ['-c', script, filePath], { timeout: 1800000, env: { HF_HOME: installer.MODEL_DIR } }, cb);
  }
  cb('desteklenmeyen belge türü');
}

function xml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function safeFile(value) {
  return String(value || 'Not').replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'Not';
}

function writeExport(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
}

function svgGraph(graph, title) {
  const width = 1200, height = 800;
  const real = graph.nodes || [];
  const positions = new Map();
  real.forEach((node, index) => {
    const angle = (Math.PI * 2 * index / Math.max(1, real.length)) - Math.PI / 2;
    const radius = Math.min(width, height) * (real.length > 1 ? .37 : 0);
    positions.set(node.id, { x: width / 2 + Math.cos(angle) * radius, y: height / 2 + Math.sin(angle) * radius });
  });
  const edges = (graph.edges || []).map((edge) => {
    const a = positions.get(edge.source), b = positions.get(edge.target);
    return a && b ? `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}"/>` : '';
  }).join('');
  const nodes = real.map((node) => {
    const p = positions.get(node.id);
    const r = Math.max(7, Math.min(19, 7 + Number(node.degree || 0) * 1.5));
    return `<g><circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r}"/><text x="${p.x.toFixed(1)}" y="${(p.y + r + 16).toFixed(1)}">${xml(node.label)}</text></g>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#101014"/><style>line{stroke:#555064;stroke-width:1.3}circle{fill:#9d83f7;stroke:#d7ccff;stroke-width:1.5}text{fill:#e8e5ef;font:12px sans-serif;text-anchor:middle}</style><text x="24" y="32" text-anchor="start" style="font-size:18px;font-weight:700">${xml(title)}</text>${edges}${nodes}</svg>`;
}

function graphml(graph) {
  const nodes = (graph.nodes || []).map((node) => `<node id="${xml(node.id)}"><data key="label">${xml(node.label)}</data><data key="type">${xml(node.type)}</data></node>`).join('');
  const edges = (graph.edges || []).map((edge, index) => `<edge id="e${index}" source="${xml(edge.source)}" target="${xml(edge.target)}"><data key="relation">${xml(edge.relation || '')}</data></edge>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><graphml xmlns="http://graphml.graphdrawing.org/xmlns"><key id="label" for="node" attr.name="label" attr.type="string"/><key id="type" for="node" attr.name="type" attr.type="string"/><key id="relation" for="edge" attr.name="relation" attr.type="string"/><graph id="notlar-sync" edgedefault="directed">${nodes}${edges}</graph></graphml>`;
}

function cypher(graph) {
  const quote = (value) => String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const lines = ['CREATE CONSTRAINT note_id IF NOT EXISTS FOR (n:Note) REQUIRE n.id IS UNIQUE;'];
  for (const node of graph.nodes || []) lines.push(`MERGE (n:Note {id:'${quote(node.id)}'}) SET n.label='${quote(node.label)}', n.type='${quote(node.type)}';`);
  for (const edge of graph.edges || []) lines.push(`MATCH (a:Note {id:'${quote(edge.source)}'}),(b:Note {id:'${quote(edge.target)}'}) MERGE (a)-[:LINKS_TO {relation:'${quote(edge.relation || '')}'}]->(b);`);
  return lines.join('\n');
}

function exportGraf(graph, kinds, outDir, title, cb) {
  try {
    fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
    for (const kind of kinds) {
      if (kind === 'svg') writeExport(path.join(outDir, 'graph.svg'), svgGraph(graph, title));
      else if (kind === 'graphml') writeExport(path.join(outDir, 'graph.graphml'), graphml(graph));
      else if (kind === 'neo4j') writeExport(path.join(outDir, 'cypher.txt'), cypher(graph));
      else if (kind === 'obsidian') {
        const dir = path.join(outDir, 'vault');
        const outgoing = new Map();
        for (const edge of graph.edges || []) {
          if (!outgoing.has(edge.source)) outgoing.set(edge.source, []);
          outgoing.get(edge.source).push(edge.target);
        }
        const byId = new Map((graph.nodes || []).map((node) => [node.id, node]));
        for (const node of graph.nodes || []) {
          if (node.ghost) continue;
          const links = (outgoing.get(node.id) || []).map((id) => byId.get(id)).filter(Boolean).map((target) => `[[${target.label}]]`);
          writeExport(path.join(dir, safeFile(node.label) + '.md'), `# ${node.label}\n\n${node.description || ''}\n\n${links.join(' · ')}\n`);
        }
      } else if (kind === 'wiki') {
        const dir = path.join(outDir, 'wiki');
        const pages = [];
        for (const node of graph.nodes || []) {
          if (node.ghost) continue;
          const file = safeFile(node.label) + '.html';
          pages.push(`<li><a href="${encodeURIComponent(file)}">${xml(node.label)}</a></li>`);
          writeExport(path.join(dir, file), `<!doctype html><meta charset="utf-8"><title>${xml(node.label)}</title><h1>${xml(node.label)}</h1><p>${xml(node.description || '')}</p><p><a href="index.html">Dizin</a></p>`);
        }
        writeExport(path.join(dir, 'index.html'), `<!doctype html><meta charset="utf-8"><title>${xml(title)}</title><h1>${xml(title)}</h1><ul>${pages.join('')}</ul>`);
      } else throw new Error('desteklenmeyen export türü');
    }
    cb(null, { ok: true });
  } catch (error) { cb(error.message); }
}

const TURLER = {
  pdf: 'pdf',
  png: 'gorsel', jpg: 'gorsel', jpeg: 'gorsel', webp: 'gorsel', gif: 'gorsel',
  mp3: 'ses', wav: 'ses', m4a: 'ses', ogg: 'ses', flac: 'ses',
  mp4: 'video', mkv: 'video', webm: 'video', mov: 'video', avi: 'video',
};

module.exports = { MOTOR_DIR, python, durum, belge, exportGraf, TURLER };
