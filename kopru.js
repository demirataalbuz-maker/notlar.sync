// Kopru: standalone ~/zihin-haritasi motorunu (Python .venv: pdftotext,
// faster-whisper, vision, export) uygulamaya baglar. Motor SART DEGIL -
// bulunamazsa /api/motor {var:false} doner, UI bu ozellikleri hic gostermez;
// uygulamanin kendisi bagimliliksiz kalir ("indir-calissin" bozulmaz).
// Konum degisikse NOTLAR_MOTOR ortam degiskeniyle gosterilir.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const MOTOR_DIR = process.env.NOTLAR_MOTOR || path.join(os.homedir(), 'zihin-haritasi');

function python() {
  const py = path.join(MOTOR_DIR, '.venv', 'bin', 'python3');
  return fs.existsSync(py) && fs.existsSync(path.join(MOTOR_DIR, 'ingest.py')) ? py : null;
}

// whisper gibi kutuphaneler stdout'a kendi mesajlarini basar; JSON kirlenmesin
// diye script icinde stdout stderr'e cevrilir, sonuc `gercek` kanalindan doner.
const BASLIK = `
import sys, json
gercek = sys.stdout
sys.stdout = sys.stderr
sys.path.insert(0, ${JSON.stringify(MOTOR_DIR)})
`;

function calistir(script, args, stdinVeri, timeoutMs, cb) {
  const py = python();
  if (!py) return cb('motor yok: ~/zihin-haritasi kurulu degil (python3 kur.py)');
  const p = execFile(py, ['-c', BASLIK + script, ...args],
    { timeout: timeoutMs, maxBuffer: 50e6, cwd: MOTOR_DIR },
    (err, stdout, stderr) => {
      if (err) return cb(String(stderr || err.message || 'motor hatasi').slice(-400));
      try { cb(null, JSON.parse(stdout)); }
      catch { cb('motor ciktisi cozulemedi: ' + String(stdout).slice(0, 200)); }
    });
  if (stdinVeri !== undefined) p.stdin.end(JSON.stringify(stdinVeri));
}

// --- yetenek sorgusu: hangi belge turleri islenebilir? (basari onbelleklenir,
// Ollama'ya yeni model kurulursa uygulamayi yeniden baslatmak yeter)
let durumCache = null;
function durum(cb) {
  if (!python()) return cb(null, { var: false });
  if (durumCache) return cb(null, durumCache);
  calistir(`
import shutil, importlib.util
import ingest
try:
    import hardware
    models = hardware.list_ollama_models()
except Exception:
    models = []
print(json.dumps({
    "var": True,
    "pdf": bool(shutil.which("pdftotext")),
    "whisper": importlib.util.find_spec("faster_whisper") is not None or bool(shutil.which("whisper")),
    "vision": ingest.find_vision_model(models),
    "ollama": bool(models),
}), file=gercek)
`, [], undefined, 20000, (err, d) => {
    if (err) return cb(null, { var: false, hata: err });
    durumCache = d;
    cb(null, d);
  });
}

// --- belge isleme: dosya -> {text, concepts}. kind: pdf | gorsel | ses | video
// Ses/video whisper'la dakikalar surebilir; cagiran async isler, cevabi beklemez.
function belge(filePath, kind, cb) {
  const sure = (kind === 'ses' || kind === 'video') ? 1800e3 : 240e3;
  calistir(`
from pathlib import Path
import ingest
try:
    import hardware
    models = hardware.list_ollama_models()
except Exception:
    models = []
p, kind = sys.argv[1], sys.argv[2]
out = {"kind": kind, "text": None, "concepts": []}
if kind == "pdf":
    out["text"] = ingest.pdf_text(p)
    if not out["text"]:
        out["hata"] = "pdftotext yok ya da PDF metinsiz"
elif kind in ("ses", "video"):
    out["text"] = ingest.transcribe(p)
    if not out["text"]:
        out["hata"] = "whisper kurulu degil (python3 kur.py) ya da ses cozulemedi"
elif kind == "gorsel":
    vm = ingest.find_vision_model(models)
    if vm:
        try:
            out["concepts"] = ingest._ask_image(hardware, vm, Path(p))
        except Exception as e:
            out["hata"] = "vision hatasi: " + str(e)[:120]
    else:
        out["hata"] = "Ollama'da vision modeli yok (or. ollama pull llava)"
if out["text"] and models and not out["concepts"]:
    model = hardware.pick_model(models=models)
    if model:
        try:
            out["concepts"] = ingest._ask_concepts(hardware, model, out["text"][:4000], kind)
        except Exception:
            pass  # kavramsiz da olur, metin yeter
print(json.dumps(out), file=gercek)
`, [filePath, kind], undefined, sure, cb);
}

// --- export: uygulama grafi (id/label/degree/community/ghost semasi
// standalone'la birebir) -> svg / graphml / neo4j / obsidian / wiki
function exportGraf(graph, kinds, outDir, title, cb) {
  calistir(`
import export
data = json.load(sys.stdin)
from pathlib import Path
Path(data["out"]).mkdir(parents=True, exist_ok=True)
export.run(set(data["kinds"]), data["nodes"], data["edges"], data["out"], data["title"], quiet=True)
print(json.dumps({"ok": True}), file=gercek)
`, [], { nodes: graph.nodes, edges: graph.edges, kinds, out: outDir, title }, 120e3, cb);
}

// dosya uzantisi -> islenebilir belge turu (bilinmeyen uzanti = null)
const TURLER = {
  pdf: 'pdf',
  png: 'gorsel', jpg: 'gorsel', jpeg: 'gorsel', webp: 'gorsel', gif: 'gorsel',
  mp3: 'ses', wav: 'ses', m4a: 'ses', ogg: 'ses', flac: 'ses',
  mp4: 'video', mkv: 'video', webm: 'video', mov: 'video', avi: 'video',
};

module.exports = { MOTOR_DIR, python, durum, belge, exportGraf, TURLER };
