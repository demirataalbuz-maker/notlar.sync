#!/usr/bin/env bash
# Retrieval olcum seti: "bu soruya SU not gelmeli" ciftleriyle isabet olcumu.
# Zeka iddiasi hisle degil sayiyla: skor = beklenen notun `kullanilan`
# listesinde cikma orani. Cevap modeli BILEREK kapali (cevapModeli=olcum-kapali)
# ki metrik saf retrieval olsun, LLM'in laf ebeligi karismasin.
#
# Kullanim:  ./olcum/olcum.sh              # temiz kasa (17 not, 25 soru)
#            ./olcum/olcum.sh --gurultu 300  # kirli kasa: +300 alakasiz not
# Gereksinim: Ollama + embedding modeli (ollama pull nomic-embed-text)
set -u
cd "$(dirname "$0")"
GURULTU=0
[ "${1:-}" = "--gurultu" ] && GURULTU=${2:-300}

curl -s http://127.0.0.1:11434/api/tags | grep -qiE "embed|nomic|bge|minilm|mxbai" \
  || { echo "embedding modeli yok (ollama pull nomic-embed-text)"; exit 1; }

T=$(mktemp -d)
mkdir -p "$T/NotlarSync/notes"
cp kasa/*.md "$T/NotlarSync/notes/"
printf '{"password":"olcum","cevapModeli":"olcum-kapali","otoZihin":false}' > "$T/NotlarSync/app-config.json"

if [ "$GURULTU" -gt 0 ]; then
  python3 - "$T" "$GURULTU" <<'PYEOF'
import sys
T, n = sys.argv[1], int(sys.argv[2])
konu = ["toplanti notu", "alisveris listesi", "rastgele fikir", "film izlenimi", "ruya kaydi", "telefon gorusmesi"]
for i in range(n):
    with open(f"{T}/NotlarSync/notes/Gurultu {i:03}.md", "w") as f:
        f.write(f"{konu[i % len(konu)]} numara {i}: bugun ozel bir sey olmadi, siradan gunluk detaylar ve onemsiz ayrintilar not edildi.\n")
PYEOF
  echo "kirli kasa modu: +$GURULTU gurultu notu"
fi

HOME="$T" PORT=7787 NOTLAR_MOTOR="$T/yok" node ../server.js > "$T/log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null; rm -rf "$T"' EXIT
for i in $(seq 1 30); do curl -s -o /dev/null "http://127.0.0.1:7787/" && break; sleep 0.3; done

python3 - <<'PYEOF'
import json, time, urllib.request, urllib.parse, sys
sorular = json.load(open("sorular.json"))
hit = 0
t0 = time.time()
for s in sorular:
    q = urllib.parse.urlencode({"q": s["soru"], "key": "olcum"})
    try:
        d = json.load(urllib.request.urlopen(f"http://127.0.0.1:7787/api/graph/query?{q}", timeout=300))
    except Exception as e:
        print("  ✗", s["soru"], "-> HATA:", e)
        continue
    ok = s["beklenen"] in d.get("kullanilan", [])
    hit += ok
    ek = "" if ok else f"  (gelen: {', '.join(d.get('kullanilan', [])[:4]) or 'bos'})"
    print(("  ✓" if ok else "  ✗"), f"{s['soru']}  ->  {s['beklenen']}{ek}")
n = len(sorular)
print(f"\nisabet: {hit}/{n}  (%{100 * hit // n})  sure: {time.time() - t0:.0f}sn")
sys.exit(0 if hit >= n * 0.8 else 1)
PYEOF
