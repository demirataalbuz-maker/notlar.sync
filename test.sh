#!/usr/bin/env bash
# Duman testi: sunucuyu IZOLE bir HOME ile kaldirir, kritik uclari yoklar.
# Ollama/motor GEREKMEZ - deterministik uclar test edilir, AI uclari sadece
# "zarif cevap veriyor mu" diye yoklanir. Kullanim: ./test.sh  (cikis 0 = gecti)
set -u
PORT=7799
T=$(mktemp -d)
mkdir -p "$T/NotlarSync/notes"
mkdir -p "$T/tmp"
mkdir -p "$T/Documents/Test Vault/.obsidian" "$T/Documents/Test Vault/Dersler" "$T/Documents/Test Vault/Assets"
printf '{"password":"test123"}' > "$T/NotlarSync/app-config.json"
printf -- '---\nname: Birinci\ndescription: "deneme notu aciklamasi"\n---\nMerhaba [[Ikinci Not]] iceriden selam' > "$T/NotlarSync/notes/Birinci.md"
printf 'sade govde, frontmatter yok' > "$T/NotlarSync/notes/Ikinci Not.md"
printf '# Obsidian Kok\nAna not' > "$T/Documents/Test Vault/Kok.md"
printf '# Ders\nGorsel: ![[Assets/test.png]]' > "$T/Documents/Test Vault/Dersler/Konu.md"
printf 'PNG-test' > "$T/Documents/Test Vault/Assets/test.png"

HOME="$T" TMPDIR="$T/tmp" PORT=$PORT NOTLAR_MOTOR="$T/motor-yok" NOTLAR_CLAUDE_BIN="$T/claude-yok" NOTLAR_CODEX_BIN="$T/codex-yok" NOTLAR_NO_RUNTIME_START=1 node "$(dirname "$0")/server.js" > "$T/server.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null; rm -rf "$T"' EXIT
for i in $(seq 1 20); do curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break; sleep 0.3; done
if ! curl -s -o /dev/null "http://127.0.0.1:$PORT/"; then
  echo "Test sunucusu baslatilamadi:" >&2
  sed -n '1,120p' "$T/server.log" >&2
  exit 1
fi

B="http://127.0.0.1:$PORT"
K="key=test123"
GECTI=0; KALDI=0
kontrol() { # kontrol "ad" "beklenen-parca" komut...
  local ad=$1 beklenen=$2; shift 2
  local sonuc; sonuc=$("$@" 2>/dev/null)
  if [[ "$sonuc" == *"$beklenen"* ]]; then
    GECTI=$((GECTI + 1)); echo "  ✓ $ad"
  else
    KALDI=$((KALDI + 1)); echo "  ✗ $ad — beklenen: '$beklenen', gelen: ${sonuc:0:100}"
  fi
}

mcp_istek() {
  local request=$1
  printf '%s\n' \
    '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"notlar-sync-test","version":"1.0.0"}}}' \
    '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}' \
    "$request" |
    HOME="$T" NOTLAR_PORT="$PORT" node "$(dirname "$0")/mcp.js"
}

markdown_guvenlik() {
  node - "$(dirname "$0")/public/index.html" <<'NODE'
const fs = require('fs');
const source = fs.readFileSync(process.argv[2], 'utf8');
const start = source.indexOf('function esc(s)');
const end = source.indexOf('function renderMd(text)');
if (start < 0 || end <= start) throw new Error('Markdown renderer bulunamadi');
const renderer = new Function('resolveNote', `${source.slice(start, end)}; return { inlineMd, safeMdUrl };`)(() => false);
const hostileImage = renderer.inlineMd('![x" onerror="globalThis.pwned=1](https://invalid.invalid/x)');
const hostileLink = renderer.inlineMd('[site](https://example.test/a"onclick="globalThis.pwned=2)');
const normal = renderer.inlineMd('![Logo](https://example.test/logo.png) [Site](https://example.test/docs?q=1&x=2) ![Yerel](files/test.png)');
const rawHtml = renderer.inlineMd('<img src=x onerror="globalThis.pwned=3">');
const failures = [];
if (/alt="x"\s+onerror=/i.test(hostileImage) || !hostileImage.includes('alt="x&quot; onerror=&quot;globalThis.pwned=1"')) failures.push('image-alt');
if (/href="[^"]*"onclick=/i.test(hostileLink) || !hostileLink.includes('&quot;onclick=&quot;globalThis.pwned=2')) failures.push('link-href');
if (!normal.includes('<img src="https://example.test/logo.png"')
  || !normal.includes('<a href="https://example.test/docs?q=1&amp;x=2"')
  || !normal.includes('<img src="/files/test.png"')) failures.push('normal-markdown');
if (rawHtml.includes('<img ') || !rawHtml.includes('&lt;img')) failures.push('raw-html');
if (renderer.safeMdUrl('javascript:alert(1)') || renderer.safeMdUrl('data:text/html,x')) failures.push('scheme');
process.stdout.write(failures.length ? `hata:${failures.join(',')}` : 'guvenli');
NODE
}

echo "Notlar Sync duman testi ($B)"
kontrol "ana sayfa acilir"        "<"              curl -s "$B/"
kontrol "markdown attribute XSS engeli" "guvenli"  markdown_guvenlik
kontrol "AI Beyni sayfasi sunulur" "brain.js"       curl -s "$B/brain.html"
kontrol "AI Beyni canli kodu sunulur" "loadBrainData" curl -s "$B/brain.js"
kontrol "health parolasiz acilir" '"ok":true'      curl -s "$B/api/health"
kontrol "port doluyken Electron sunucusu istemciye doner" "embedded-alive" env HOME="$T" PORT="$PORT" node -e "require('./server.js'); setTimeout(() => console.log('embedded-alive'), 100)"
kontrol "parolasiz istek reddi"   "kimlik"         curl -s "$B/api/notes"
kontrol "peer veri ucu token ister" "peer kimligi" curl -s "$B/api/sync/replica/changes"
kontrol "not listesi"             "Birinci"        curl -s "$B/api/notes?$K"
kontrol "peer sync durumu sunulur" '"device"'       curl -s -H "X-Api-Key: test123" "$B/api/sync/status"
kontrol "Saldiri Avcisi durumu zarif" '"online"'   curl -s -H "X-Api-Key: test123" "$B/api/avci/status"
kontrol "AI Konsey gecersiz ajani reddeder" "gecersiz ajan" curl -s -X POST -H "X-Api-Key: test123" -H "Content-Type: application/json" -d '{"agent":"root","message":"test"}' "$B/api/konsey"
kontrol "AI Konsey model izin listesi" "modeli desteklenmiyor" curl -s -X POST -H "X-Api-Key: test123" -H "Content-Type: application/json" -d '{"agent":"claude","message":"test","claudeModel":"tehlikeli-model"}' "$B/api/konsey"
kontrol "AI Konsey CLI yokken zarif cevap" "cevap veremedi" curl -s -X POST -H "X-Api-Key: test123" -H "Content-Type: application/json" -d '{"agent":"claude","message":"test"}' "$B/api/konsey"
kontrol "AI Konsey gecici klasoru temizler" "temiz" bash -c "compgen -G '$T/tmp/notlar-konsey-*' >/dev/null || echo temiz"
kontrol "not okuma"               "Merhaba"        curl -s "$B/api/note/Birinci?$K"
kontrol "bozuk URL kodlamasi 400"  "gecersiz isim"  curl -s --path-as-is -H "X-Api-Key: test123" "$B/api/note/%"
kontrol "not yazma"               "kaydedildi"     curl -s -X POST -d "yeni icerik" "$B/api/note/Yeni?$K"
kontrol "yazilan geri okunur"     "yeni icerik"    curl -s "$B/api/note/Yeni?$K"
kontrol "append modu"             "kaydedildi"     curl -s -X POST -d " + ek" "$B/api/note/Yeni?$K&append=1"
kontrol "icerik aramasi"          "Birinci"        curl -s "$B/api/search?q=merhaba&$K"
kontrol "graf dugumleri"          "Ikinci Not"     curl -s "$B/api/graph?$K"
kontrol "graf explain"            "Birinci"        curl -s --get "$B/api/graph/explain" --data-urlencode "node=Birinci" --data-urlencode "key=test123"
kontrol "graf path"               "adim"           curl -s --get "$B/api/graph/path" --data-urlencode "from=Birinci" --data-urlencode "to=Ikinci Not" --data-urlencode "key=test123"
kontrol "oneri: uydurma dugum reddi" "eklenmedi"   curl -s -X POST -d '{"a":"Yok Boyle Not","b":"Birinci","neden":"test"}' "$B/api/graph/oner?$K"
kontrol "oneri: gecerli cift kuyruga" "Birinci"    curl -s -X POST -d '{"a":"Yeni","b":"Birinci","neden":"duman testi"}' "$B/api/graph/oner?$K"
kontrol "oneri kuyrugu gorunur"   "duman testi"    curl -s "$B/api/graph/oneriler?$K"
kontrol "upload: kotu uzanti 415" "desteklenmeyen" curl -s -X POST -d "x" "$B/api/upload?$K&ext=exe"
kontrol "gomulu belge motoru hazir" '"builtin":true' curl -s "$B/api/motor?$K"
kontrol "belge turu dogrulanir"    "desteklenmeyen" curl -s -X POST -d "x" "$B/api/belge?$K&ad=a.xyz"
kontrol "gomulu SVG export calisir" "<svg"          curl -s "$B/api/graph/export?format=svg&$K"
kontrol "gecersiz export formati" "format"         curl -s "$B/api/graph/export?format=xxx&$K"
kontrol "URL import localhost SSRF engeli" "yerel/ozel" curl -s -X POST -H "X-Api-Key: test123" -H "Content-Type: application/json" -d "{\"url\":\"http://127.0.0.1:$PORT/api/health\"}" "$B/api/ekle-url"
kontrol "MCP config port + header auth" "Birinci" mcp_istek '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"notlari_listele","arguments":{}}}'
MEM_START=$(curl -s -X POST -H "X-Api-Key: test123" -H "Content-Type: application/json" -d '{"sessionId":"test-memory-session","agent":"codex","client":"test","workspace":"/tmp/notlar-sync","project":"Notlar Sync","goal":"Graf tasarimini bitir password=asla-kaydetme"}' "$B/api/memory/session/start")
MEM_ID=$(printf '%s' "$MEM_START" | sed -n 's/.*"session":{"id":"\([^"]*\)".*/\1/p' | head -n1)
kontrol "hafiza: oturum baslar" "test-memory-session" echo "$MEM_START"
kontrol "hafiza: baslangic baglami gelir" '"context"' echo "$MEM_START"
kontrol "hafiza: gizli deger redakte edilir" "REDACTED" echo "$MEM_START"
kontrol "hafiza: heartbeat" "test-memory-session" curl -s -X POST -H "X-Api-Key: test123" -H "Content-Type: application/json" -d "{\"sessionId\":\"$MEM_ID\",\"activity\":\"test suruyor\"}" "$B/api/memory/session/heartbeat"
kontrol "hafiza: karar olayi" "Graf ana ekran" curl -s -X POST -H "X-Api-Key: test123" -H "Content-Type: application/json" -d "{\"sessionId\":\"$MEM_ID\",\"type\":\"decision\",\"content\":\"Graf ana ekran olacak\",\"importance\":5}" "$B/api/memory/event"
kontrol "hafiza: checkpoint" "MCP ortak kapi" curl -s -X POST -H "X-Api-Key: test123" -H "Content-Type: application/json" -d "{\"sessionId\":\"$MEM_ID\",\"summary\":\"Graf konsepti hazir\",\"completed\":[\"Konsept\"],\"decisions\":[\"MCP ortak kapi\"],\"openTasks\":[\"Canli veriyi bagla\"],\"nextStep\":\"API testleri\"}" "$B/api/memory/checkpoint"
ROLLING_ONE=$(curl -s -X POST -H "X-Api-Key: test123" -H "Content-Type: application/json" -d "{\"sessionId\":\"$MEM_ID\",\"summary\":\"Ilk otomatik tur\",\"rollingKey\":\"turn-auto\"}" "$B/api/memory/checkpoint")
ROLLING_TWO=$(curl -s -X POST -H "X-Api-Key: test123" -H "Content-Type: application/json" -d "{\"sessionId\":\"$MEM_ID\",\"summary\":\"Guncel otomatik tur\",\"rollingKey\":\"turn-auto\"}" "$B/api/memory/checkpoint")
ROLLING_ONE_ID=$(printf '%s' "$ROLLING_ONE" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -n1)
kontrol "hafiza: otomatik checkpoint yuvarlanir" "\"id\":\"$ROLLING_ONE_ID\"" echo "$ROLLING_TWO"
kontrol "hafiza: hibrit recall" "MCP ortak kapi" curl -s -X POST -H "X-Api-Key: test123" -H "Content-Type: application/json" -d '{"workspace":"/tmp/notlar-sync","project":"Notlar Sync","query":"ortak kapi","limit":5}' "$B/api/memory/recall"
kontrol "hafiza: olay gunlugu" "Graf ana ekran" curl -s -H "X-Api-Key: test123" "$B/api/memory/events?sessionId=$MEM_ID"
kontrol "hafiza: overview" '"openTasks":1' curl -s -H "X-Api-Key: test123" "$B/api/memory/overview?workspace=%2Ftmp%2Fnotlar-sync&project=Notlar%20Sync"
MEM_OTHER=$(curl -s -X POST -H "X-Api-Key: test123" -H "Content-Type: application/json" -d '{"sessionId":"test-other-session","agent":"claude","workspace":"/tmp/diger-proje","project":"Diger Proje","goal":"Coklu proje grafigi"}' "$B/api/memory/session/start")
kontrol "hafiza: coklu proje grafigi" "Diger Proje" curl -s -H "X-Api-Key: test123" "$B/api/memory/graph"
curl -s -X POST -H "X-Api-Key: test123" -H "Content-Type: application/json" -d '{"workspace":"/tmp/diger-proje","project":"Diger Proje","kind":"decision","key":"Diger proje karari","content":"Yalniz diger projede bulunan benzersiz karar"}' "$B/api/memory/remember" >/dev/null
kontrol "hafiza: tum beyin recall projeleri asar" "Diger proje karari" curl -s -X POST -H "X-Api-Key: test123" -H "Content-Type: application/json" -d '{"allProjects":true,"query":"benzersiz karar","limit":10}' "$B/api/memory/recall"
curl -s -X POST -H "X-Api-Key: test123" -H "Content-Type: application/json" -d '{"scope":"global","kind":"preference","key":"Global tercih","content":"Tum projelerde gorunur"}' "$B/api/memory/remember" >/dev/null
curl -s -X POST -H "X-Api-Key: test123" -H "Content-Type: application/json" -d '{"workspace":"/tmp/notlar-sync","project":"Notlar Sync","kind":"project","key":"Proje bilgisi","content":"Yapisal proje dugumuyle cakismamali"}' "$B/api/memory/remember" >/dev/null
kontrol "hafiza: global dugum global isaretlidir" '"global":true' curl -s -H "X-Api-Key: test123" "$B/api/memory/graph"
kontrol "hafiza: proje hafizasi yapisal dugum degildir" '"type":"project-memory"' curl -s -H "X-Api-Key: test123" "$B/api/memory/graph"
kontrol "hafiza: ayarlar okunur" '"contextTokenBudget":2400' curl -s -H "X-Api-Key: test123" "$B/api/memory/settings"
kontrol "hafiza: ayarlar degisir" '"contextTokenBudget":3200' curl -s -X POST -H "X-Api-Key: test123" -H "Content-Type: application/json" -d '{"contextTokenBudget":3200,"transcriptMode":"summaries","autoCapture":true}' "$B/api/memory/settings"
MEM_FORGET=$(curl -s -X POST -H "X-Api-Key: test123" -H "Content-Type: application/json" -d '{"workspace":"/tmp/notlar-sync","project":"Notlar Sync","kind":"fact","key":"Gecici test","content":"Bu kayit unutulacak"}' "$B/api/memory/remember")
MEM_FORGET_ID=$(printf '%s' "$MEM_FORGET" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -n1)
kontrol "hafiza: kullanici kaydi unutur" '"ok":true' curl -s -X POST -H "X-Api-Key: test123" -H "Content-Type: application/json" -d "{\"id\":\"$MEM_FORGET_ID\",\"reason\":\"test\"}" "$B/api/memory/forget"

# --- temporal fact katmani: supersede, asOf, dispute, provenance, migration ---
FACT_ONE=$(curl -s -X POST -H "X-Api-Key: test123" -H "Content-Type: application/json" -d '{"subject":"kullanici","predicate":"kullanir","object":"React","project":"Notlar Sync","workspace":"/tmp/notlar-sync","confidence":0.8,"validFrom":"2026-03-01T00:00:00.000Z"}' "$B/api/memory/facts")
FACT_ONE_ID=$(printf '%s' "$FACT_ONE" | sed -n 's/.*"id":"\(fact_[^"]*\)".*/\1/p' | head -n1)
kontrol "fact: ilk kayit aktif" '"status":"active"' echo "$FACT_ONE"
kontrol "fact: manuel API girdisi kullanici assertion olur" '"assertionType":"user"' echo "$FACT_ONE"
FACT_TWO=$(curl -s -X POST -H "X-Api-Key: test123" -H "Content-Type: application/json" -d '{"subject":"kullanici","predicate":"kullanir","object":"Vue","project":"Notlar Sync","workspace":"/tmp/notlar-sync","confidence":0.9,"validFrom":"2026-06-01T00:00:00.000Z"}' "$B/api/memory/facts")
FACT_TWO_ID=$(printf '%s' "$FACT_TWO" | sed -n 's/.*"id":"\(fact_[^"]*\)".*/\1/p' | head -n1)
kontrol "fact: yeni deger supersede zinciri kurar" "\"supersedes\":[\"$FACT_ONE_ID\"]" echo "$FACT_TWO"
kontrol "fact: provenance POST mutasyon yapmaz" "guvenli-tamam" bash -c "curl -s -X POST -H 'X-Api-Key: test123' -H 'Content-Type: application/json' -d '{}' '$B/api/memory/facts/$FACT_TWO_ID/provenance' >/dev/null; R=\$(curl -s -H 'X-Api-Key: test123' '$B/api/memory/facts?project=Notlar%20Sync&workspace=%2Ftmp%2Fnotlar-sync&subject=kullanici'); [[ \"\$R\" == *'\"status\":\"active\"'* && \"\$R\" == *Vue* ]] && echo guvenli-tamam"
kontrol "fact: eski kayit validTo alir" '"validTo":"2026-06-01T00:00:00.000Z"' curl -s -H "X-Api-Key: test123" "$B/api/memory/facts?project=Notlar%20Sync&workspace=%2Ftmp%2Fnotlar-sync&includeHistorical=1&subject=kullanici"
kontrol "fact: varsayilan listede superseded gizli" "gizli-tamam" bash -c "R=\$(curl -s -H 'X-Api-Key: test123' '$B/api/memory/facts?project=Notlar%20Sync&workspace=%2Ftmp%2Fnotlar-sync&subject=kullanici'); [[ \"\$R\" == *Vue* && \"\$R\" != *React* ]] && echo gizli-tamam"
kontrol "fact: asOf gecmisteki dogru degeri getirir" "asof-tamam" bash -c "R=\$(curl -s -X POST -H 'X-Api-Key: test123' -H 'Content-Type: application/json' -d '{\"query\":\"kullanici ne kullaniyor\",\"project\":\"Notlar Sync\",\"workspace\":\"/tmp/notlar-sync\",\"asOf\":\"2026-04-15T00:00:00.000Z\"}' '$B/api/memory/recall'); [[ \"\$R\" == *React* && \"\$R\" != *Vue* ]] && echo asof-tamam"
kontrol "fact: varsayilan recall guncel degeri verir" "guncel-tamam" bash -c "R=\$(curl -s -X POST -H 'X-Api-Key: test123' -H 'Content-Type: application/json' -d '{\"query\":\"kullanici ne kullaniyor\",\"project\":\"Notlar Sync\",\"workspace\":\"/tmp/notlar-sync\"}' '$B/api/memory/recall'); [[ \"\$R\" == *Vue* && \"\$R\" != *React* ]] && echo guncel-tamam"
kontrol "fact: recall explain whyMatched doner" '"whyMatched"' curl -s -X POST -H "X-Api-Key: test123" -H "Content-Type: application/json" -d '{"query":"kullanici ne kullaniyor","project":"Notlar Sync","workspace":"/tmp/notlar-sync","explain":true}' "$B/api/memory/recall"
FACT_UNVERIFIED=$(curl -s -X POST -H "X-Api-Key: test123" -H "Content-Type: application/json" -d '{"assertionType":"agent","agent":"codex","subject":"ajan","predicate":"sahip","object":"kaynaksiz-api-iddiasi","confidence":0.99,"project":"Notlar Sync","workspace":"/tmp/notlar-sync"}' "$B/api/memory/facts")
kontrol "fact: kaynaksiz ajan iddiasi kesin gercek olmaz" "unverified-tamam" bash -c "R='$FACT_UNVERIFIED'; [[ \"\$R\" == *'\"evidenceLevel\":\"unverified\"'* && \"\$R\" == *'\"status\":\"disputed\"'* && \"\$R\" == *'\"confidence\":0.35'* ]] && echo unverified-tamam"
kontrol "fact: evidence cezasi explain ciktisinda" '"evidencePenalty":-18' curl -s -X POST -H "X-Api-Key: test123" -H "Content-Type: application/json" -d '{"query":"kaynaksiz api iddiasi","project":"Notlar Sync","workspace":"/tmp/notlar-sync","includeDisputed":true,"explain":true}' "$B/api/memory/recall"
FACT_DISP=$(curl -s -X POST -H "X-Api-Key: test123" -H "Content-Type: application/json" -d '{"subject":"kullanici","predicate":"kullanir","object":"Svelte","project":"Notlar Sync","workspace":"/tmp/notlar-sync","confidence":0.3}' "$B/api/memory/facts")
FACT_DISP_ID=$(printf '%s' "$FACT_DISP" | sed -n 's/.*"id":"\(fact_[^"]*\)".*/\1/p' | head -n1)
kontrol "fact: dusuk guvenli celiski disputed olur" '"status":"disputed"' echo "$FACT_DISP"
kontrol "fact: disputed varsayilan recall'da geride" "sira-tamam" bash -c "R=\$(curl -s -X POST -H 'X-Api-Key: test123' -H 'Content-Type: application/json' -d '{\"query\":\"kullanici ne kullaniyor\",\"project\":\"Notlar Sync\",\"workspace\":\"/tmp/notlar-sync\",\"limit\":30}' '$B/api/memory/recall'); V=\${R%%Vue*}; S=\${R%%Svelte*}; [[ \${#V} -lt \${#R} && \${#S} -lt \${#R} && \${#V} -lt \${#S} ]] && echo sira-tamam"
kontrol "fact: timeline versiyonlari dondurur" "timeline-tamam" bash -c "R=\$(curl -s -H 'X-Api-Key: test123' '$B/api/memory/timeline?subject=kullanici&predicate=kullanir&project=Notlar%20Sync&workspace=%2Ftmp%2Fnotlar-sync'); [[ \"\$R\" == *React* && \"\$R\" == *Vue* && \"\$R\" == *superseded* ]] && echo timeline-tamam"
FACT_DEC_ID=$(curl -s -H "X-Api-Key: test123" "$B/api/memory/facts?project=Notlar%20Sync&workspace=%2Ftmp%2Fnotlar-sync&q=ortak%20kapi" | sed -n 's/.*"id":"\(fact_[^"]*\)".*/\1/p' | head -n1)
kontrol "fact: checkpoint karari fact olur" "fact_" echo "$FACT_DEC_ID"
kontrol "fact: provenance oturum+checkpoint zinciri" "$MEM_ID" curl -s -H "X-Api-Key: test123" "$B/api/memory/facts/$FACT_DEC_ID/provenance"
kontrol "fact: provenance checkpoint kaydini cozer" '"checkpoint":{"id":"chk_' curl -s -H "X-Api-Key: test123" "$B/api/memory/facts/$FACT_DEC_ID/provenance"
kontrol "fact: provenance evidence zinciri makine-okur" '"evidenceChain":[{"type":"session"' curl -s -H "X-Api-Key: test123" "$B/api/memory/facts/$FACT_DEC_ID/provenance"
kontrol "fact: checkpoint fact turetilmis evidence tasir" '"evidenceLevel":"derived"' curl -s -H "X-Api-Key: test123" "$B/api/memory/facts/$FACT_DEC_ID/provenance"
FACT_RED=$(curl -s -X POST -H "X-Api-Key: test123" -H "Content-Type: application/json" -d '{"subject":"sunucu","predicate":"sahip","object":"giris bilgisi","value":"parola=asla-gorunmesin-1","project":"Notlar Sync","workspace":"/tmp/notlar-sync"}' "$B/api/memory/facts")
FACT_RED_ID=$(printf '%s' "$FACT_RED" | sed -n 's/.*"id":"\(fact_[^"]*\)".*/\1/p' | head -n1)
kontrol "fact: redaksiyon temporal kayitta calisir" "REDACTED" echo "$FACT_RED"
kontrol "fact: invalidate gecersiz kilar" '"status":"invalidated"' curl -s -X POST -H "X-Api-Key: test123" -H "Content-Type: application/json" -d '{"reason":"test"}' "$B/api/memory/facts/$FACT_RED_ID/invalidate"
kontrol "fact: forget temporal veride guvenli" '"fact":true' curl -s -X POST -H "X-Api-Key: test123" -H "Content-Type: application/json" -d "{\"id\":\"$FACT_DISP_ID\",\"reason\":\"test\"}" "$B/api/memory/forget"
kontrol "fact: unutulan deger maskelenir" "unut-tamam" bash -c "R=\$(curl -s -H 'X-Api-Key: test123' '$B/api/memory/facts?project=Notlar%20Sync&workspace=%2Ftmp%2Fnotlar-sync&includeHistorical=1&includeForgotten=1'); [[ \"\$R\" == *UNUTULDU* && \"\$R\" != *Svelte* ]] && echo unut-tamam"
kontrol "fact: eski hafiza migration calisir" "mig-tamam" bash -c "R=\$(curl -s -X POST -H 'X-Api-Key: test123' -H 'Content-Type: application/json' -d '{}' '$B/api/memory/facts/migrate'); [[ \"\$R\" =~ \\\"migrated\\\":[1-9] ]] && echo mig-tamam"
kontrol "fact: migration idempotent" '"migrated":0' curl -s -X POST -H "X-Api-Key: test123" -H "Content-Type: application/json" -d '{}' "$B/api/memory/facts/migrate"
curl -s -X POST -H "X-Api-Key: test123" -H "Content-Type: application/json" -d '{"subject":"takim","predicate":"sahip","object":"izole-bilgi-x","project":"Diger Proje","workspace":"/tmp/diger-proje"}' "$B/api/memory/facts" >/dev/null
kontrol "fact: coklu proje izolasyonu" "izolasyon-tamam" bash -c "A=\$(curl -s -H 'X-Api-Key: test123' '$B/api/memory/facts?project=Notlar%20Sync&workspace=%2Ftmp%2Fnotlar-sync'); D=\$(curl -s -H 'X-Api-Key: test123' '$B/api/memory/facts?project=Diger%20Proje&workspace=%2Ftmp%2Fdiger-proje'); [[ \"\$A\" != *izole-bilgi-x* && \"\$D\" == *izole-bilgi-x* ]] && echo izolasyon-tamam"
HARD_OLD=$(curl -s -X POST -H "X-Api-Key: test123" -H "Content-Type: application/json" -d '{"subject":"hard-api-zincir","predicate":"kullanir","object":"eski-api","validFrom":"2026-01-01T00:00:00.000Z","project":"Notlar Sync","workspace":"/tmp/notlar-sync"}' "$B/api/memory/facts")
HARD_OLD_ID=$(printf '%s' "$HARD_OLD" | sed -n 's/.*"id":"\(fact_[^"]*\)".*/\1/p' | head -n1)
HARD_NEW=$(curl -s -X POST -H "X-Api-Key: test123" -H "Content-Type: application/json" -d '{"subject":"hard-api-zincir","predicate":"kullanir","object":"yeni-api","validFrom":"2026-02-01T00:00:00.000Z","project":"Notlar Sync","workspace":"/tmp/notlar-sync"}' "$B/api/memory/facts")
HARD_NEW_ID=$(printf '%s' "$HARD_NEW" | sed -n 's/.*"id":"\(fact_[^"]*\)".*/\1/p' | head -n1)
kontrol "fact: hard forget acik onay ister" "KALICI OLARAK UNUT" curl -s -X POST -H "X-Api-Key: test123" -H "Content-Type: application/json" -d '{}' "$B/api/memory/facts/$HARD_OLD_ID/forget-hard"
kontrol "fact: hard forget fact+index+iliski temizler" "hard-api-tamam" bash -c "R=\$(curl -s -X POST -H 'X-Api-Key: test123' -H 'Content-Type: application/json' -d '{\"confirm\":\"KALICI OLARAK UNUT\"}' '$B/api/memory/facts/$HARD_OLD_ID/forget-hard'); [[ \"\$R\" == *'\"factsRemoved\":1'* && \"\$R\" == *'\"indexRecordsRemoved\":1'* && \"\$R\" == *'\"relationsCleaned\":1'* ]] && echo hard-api-tamam"
kontrol "fact: hard forget kirik supersede ID birakmaz" "hard-ref-tamam" bash -c "R=\$(curl -s -H 'X-Api-Key: test123' '$B/api/memory/facts?project=Notlar%20Sync&workspace=%2Ftmp%2Fnotlar-sync&includeHistorical=1'); [[ \"\$R\" == *'$HARD_NEW_ID'* && \"\$R\" != *'$HARD_OLD_ID'* ]] && echo hard-ref-tamam"
curl -s -X POST -H "X-Api-Key: test123" -H "Content-Type: application/json" -d '{"subject":"gelistirme takimi","predicate":"tercih-eder","topic":"kod editoru","object":"VS Code koyu tema","project":"Notlar Sync","workspace":"/tmp/notlar-sync"}' "$B/api/memory/facts" >/dev/null
FACT_SUGGEST=$(curl -s -X POST -H "X-Api-Key: test123" -H "Content-Type: application/json" -d '{"subject":"gelistirme takimi","predicate":"tercih-eder","topic":"editor tercihi","object":"VS Code acik tema","project":"Notlar Sync","workspace":"/tmp/notlar-sync"}' "$B/api/memory/facts")
kontrol "fact: muhtemel celiski otomatik supersede olmaz" "suggest-tamam" bash -c "R='$FACT_SUGGEST'; [[ \"\$R\" == *'\"conflictSuggestions\":['* && \"\$R\" == *'\"suggestedAction\"'* && \"\$R\" == *'\"supersedes\":[]'* ]] && echo suggest-tamam"
kontrol "fact: recall yerel indeksi raporlar" '"engine":"sqlite-fts5"' curl -s -X POST -H "X-Api-Key: test123" -H "Content-Type: application/json" -d '{"query":"gelistirme takimi editor","project":"Notlar Sync","workspace":"/tmp/notlar-sync","explain":true}' "$B/api/memory/recall"
kontrol "fact: MCP temporal araclari yayinlanir" "hafiza_gercek_yaz" mcp_istek '{"jsonrpc":"2.0","id":3,"method":"tools/list","params":{}}'

kontrol "AI entegrasyon durumu" '"providers"' curl -s -H "X-Api-Key: test123" "$B/api/integrations"
kontrol "paketli Electron Node calisma zamani olur" "electron" env NOTLAR_FORCE_APP_RUNTIME=1 NOTLAR_APP_EXECUTABLE=/bin/sh node -e "console.log(require('./integrations').resolveNodeRuntime().source)"
kontrol "hafiza: MCP araclari yayinlanir" "oturum_baslat" mcp_istek '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
kontrol "hafiza: oturum kapanir" '"status":"ended"' curl -s -X POST -H "X-Api-Key: test123" -H "Content-Type: application/json" -d "{\"sessionId\":\"$MEM_ID\",\"summary\":\"Test tamamlandi\",\"nextStep\":\"Yok\"}" "$B/api/memory/session/end"
kontrol "X-Api-Key header ile auth" "Birinci"      curl -s -H "X-Api-Key: test123" "$B/api/notes"
kontrol "session rolu host"        '"role":"master"' curl -s -c "$T/cookies" -H "X-Api-Key: test123" "$B/api/session"
kontrol "HttpOnly session cookie"  "Birinci"       curl -s -b "$T/cookies" "$B/api/notes"
kontrol "overview istatistikleri"  '"stats"'        curl -s -H "X-Api-Key: test123" "$B/api/overview"
kontrol "ayarlar hostta okunur"    '"dataDir"'      curl -s -H "X-Api-Key: test123" "$B/api/settings"
kontrol "kurulum merkezi durum verir" '"components"' curl -s -H "X-Api-Key: test123" "$B/api/runtime"
kontrol "kurulum merkezi keyfi komut reddeder" "geçersiz" curl -s -X POST -H "X-Api-Key: test123" -H "Content-Type: application/json" -d '{"action":"rm"}' "$B/api/runtime/install"
kontrol "not sabitleme"            '"pinned":true'  curl -s -X POST -H "X-Api-Key: test123" -H "Content-Type: application/json" -d '{"name":"Birinci","pinned":true}' "$B/api/pins"
VAULT1='{"v":1,"kdf":"PBKDF2-SHA256","iter":600000,"salt":"AA==","iv":"AA==","ct":"AA=="}'
VAULT2='{"v":1,"kdf":"PBKDF2-SHA256","iter":600000,"salt":"AQ==","iv":"AQ==","ct":"AQ=="}'
kontrol "kasa ilk kez kosullu yazilir" "kaydedildi" curl -s -X POST -H "X-Api-Key: test123" -H "If-None-Match: *" -d "$VAULT1" "$B/api/vault"
VAULT_ETAG=$(curl -s -D - -o /dev/null -H "X-Api-Key: test123" "$B/api/vault" | sed -n 's/^[Ee][Tt][Aa][Gg]:[[:space:]]*\(.*\)\r$/\1/p')
kontrol "kasa ETag ile guncellenir" "kaydedildi" curl -s -X POST -H "X-Api-Key: test123" -H "If-Match: $VAULT_ETAG" -d "$VAULT2" "$B/api/vault"
kontrol "kasa eski ETag ile ezilemez" "baska cihazda degisti" curl -s -X POST -H "X-Api-Key: test123" -H "If-Match: $VAULT_ETAG" -d "$VAULT1" "$B/api/vault"
kontrol "kasa bozuk zarfi reddeder" "gecersiz kasa" curl -s -X POST -H "X-Api-Key: test123" -d '{}' "$B/api/vault"

# gercek klasorler + Obsidian aktarimi
kontrol "klasor olusturulur" '"name":"Projeler"' curl -s -X POST -H "X-Api-Key: test123" -H "Content-Type: application/json" -d '{"path":"Projeler"}' "$B/api/folders"
kontrol "ic ice klasor olusturulur" '"name":"Projeler/Alt"' curl -s -X POST -H "X-Api-Key: test123" -H "Content-Type: application/json" -d '{"path":"Projeler/Alt"}' "$B/api/folders"
kontrol "klasorde not yazilir" "kaydedildi" curl -s -X POST -H "X-Api-Key: test123" -d 'klasorlu icerik' "$B/api/note/Projeler%2FAlt%2FKlasorlu"
kontrol "klasorlu not listelenir" "Projeler/Alt/Klasorlu" curl -s -H "X-Api-Key: test123" "$B/api/notes"
kontrol "klasor listesi gercek dizinleri verir" "Projeler/Alt" curl -s -H "X-Api-Key: test123" "$B/api/folders"
kontrol "klasor yeniden adlandirilir" '"name":"Arsiv"' curl -s -X PATCH -H "X-Api-Key: test123" -H "Content-Type: application/json" -d '{"path":"Projeler","newPath":"Arsiv"}' "$B/api/folders"
kontrol "klasor tasininca not korunur" "klasorlu icerik" curl -s -H "X-Api-Key: test123" "$B/api/note/Arsiv%2FAlt%2FKlasorlu"
kontrol "dolu klasor silinmez" "bos degil" curl -s -X DELETE -H "X-Api-Key: test123" -H "Content-Type: application/json" -d '{"path":"Arsiv"}' "$B/api/folders"
curl -s -X POST -H "X-Api-Key: test123" -H "Content-Type: application/json" -d '{"path":"Bos"}' "$B/api/folders" >/dev/null
curl -s -X POST -H "X-Api-Key: test123" -d 'gecici' "$B/api/note/Bos%2FGecici" >/dev/null
curl -s -X DELETE -H "X-Api-Key: test123" "$B/api/note/Bos%2FGecici" >/dev/null
kontrol "son not silinince klasor korunur" '"Bos"' curl -s -H "X-Api-Key: test123" "$B/api/folders"
BOS_ID=$(curl -s -H "X-Api-Key: test123" "$B/api/trash" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
curl -s -X POST -H "X-Api-Key: test123" -H "Content-Type: application/json" -d "{\"id\":\"$BOS_ID\"}" "$B/api/trash/delete" >/dev/null
kontrol "bos klasor acik komutla silinir" '"ok":true' curl -s -X DELETE -H "X-Api-Key: test123" -H "Content-Type: application/json" -d '{"path":"Bos"}' "$B/api/folders"
kontrol "Obsidian kasasi algilanir" "Test Vault" curl -s -H "X-Api-Key: test123" "$B/api/import/obsidian"
kontrol "Obsidian notlari aktarilir" '"imported":2' curl -s -X POST -H "X-Api-Key: test123" -H "Content-Type: application/json" -d "{\"path\":\"$T/Documents/Test Vault\"}" "$B/api/import/obsidian"
kontrol "Obsidian klasoru korunur" "Obsidian Kok" curl -s -H "X-Api-Key: test123" "$B/api/note/Kok"
kontrol "Obsidian ic ice notu okunur" "files/obsidian/Test%20Vault/Assets/test.png" curl -s -H "X-Api-Key: test123" "$B/api/note/Dersler%2FKonu"
kontrol "Obsidian eki guvenli yoldan sunulur" "PNG-test" curl -s -H "X-Api-Key: test123" "$B/files/obsidian/Test%20Vault/Assets/test.png"
kontrol "Obsidian tekrar aktarimi kopya uretmez" '"imported":0' curl -s -X POST -H "X-Api-Key: test123" -H "Content-Type: application/json" -d "{\"path\":\"$T/Documents/Test Vault\"}" "$B/api/import/obsidian"

# gercek silme yasam dongusu: not -> cop -> 404 -> geri yukle -> yeniden adlandir
kontrol "not cope tasinir"          "cop kutusuna"   curl -s -X DELETE -H "X-Api-Key: test123" "$B/api/note/Yeni"
kontrol "silinen not gercekten 404" "not yok"        curl -s -H "X-Api-Key: test123" "$B/api/note/Yeni"
kontrol "cop listesinde gorunur"    "Yeni"           curl -s -H "X-Api-Key: test123" "$B/api/trash"
TRASH_ID=$(curl -s -H "X-Api-Key: test123" "$B/api/trash" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
kontrol "copten geri yuklenir"      '"name":"Yeni"' curl -s -X POST -H "X-Api-Key: test123" -H "Content-Type: application/json" -d "{\"id\":\"$TRASH_ID\"}" "$B/api/trash/restore"
kontrol "geri yuklenen icerik saglam" "yeni icerik"   curl -s -H "X-Api-Key: test123" "$B/api/note/Yeni"
kontrol "not yeniden adlandirilir"  '"name":"Yeni Ad"' curl -s -X PATCH -H "X-Api-Key: test123" -H "Content-Type: application/json" -d '{"name":"Yeni Ad"}' "$B/api/note/Yeni"
kontrol "eski ad artik yok"         "not yok"        curl -s -H "X-Api-Key: test123" "$B/api/note/Yeni"
kontrol "yeni ad icerigi korur"     "yeni icerik"    curl -s -H "X-Api-Key: test123" "$B/api/note/Yeni%20Ad"
kontrol "rename wikilinkleri gunceller" '"linksUpdated":1' curl -s -X PATCH -H "X-Api-Key: test123" -H "Content-Type: application/json" -d '{"name":"Ikinci Yenilendi"}' "$B/api/note/Ikinci%20Not"
kontrol "guncellenen wikilink okunur" "[[Ikinci Yenilendi]]" curl -s -H "X-Api-Key: test123" "$B/api/note/Birinci"
kontrol "wikilink rename geri alinir" '"linksUpdated":1' curl -s -X PATCH -H "X-Api-Key: test123" -H "Content-Type: application/json" -d '{"name":"Ikinci Not"}' "$B/api/note/Ikinci%20Yenilendi"
kontrol "WS auth + offline/dis editor guvenligi" "ws-offline-tamam" env WS_URL="ws://127.0.0.1:$PORT/" WS_KEY="test123" WS_NOTES_DIR="$T/NotlarSync/notes" node "$(dirname "$0")/scripts/ws-smoke.js"

# --- eslestirme: tek kullanimlik kod + cift onay + token yasam dongusu ---
KOD=$(curl -s -X POST -H "X-Api-Key: test123" "$B/api/pair/new" | sed -n 's/.*"kod":"\([0-9]*\)".*/\1/p')
kontrol "pair: kod uretildi (6 hane)" "6" bash -c "echo -n '${KOD}' | wc -c"
CLAIMID=$(curl -s -X POST "$B/api/pair/claim" -d "{\"kod\":\"$KOD\",\"cihazAdi\":\"TestCihaz\"}" | sed -n 's/.*"claimId":"\([a-f0-9]*\)".*/\1/p')
kontrol "pair: cihaz claim aldi"     "3"       bash -c "echo -n '${CLAIMID}' | wc -c | awk '{print (\$1>0)?3:0}'"
kontrol "pair: host talebi isimle gorur" "TestCihaz" curl -s -H "X-Api-Key: test123" "$B/api/pair/talepler"
kontrol "pair: tek onayda token YOK" "bekliyor" bash -c "curl -s -X POST '$B/api/pair/cihaz-onay' -d '{\"kod\":\"$KOD\",\"claimId\":\"$CLAIMID\"}' >/dev/null; curl -s '$B/api/pair/durum?kod=$KOD&claimId=$CLAIMID'"
curl -s -X POST -H "X-Api-Key: test123" "$B/api/pair/host-onay" -d "{\"kod\":\"$KOD\"}" >/dev/null
TOKEN=$(curl -s "$B/api/pair/durum?kod=$KOD&claimId=$CLAIMID" | sed -n 's/.*"token":"\([a-z0-9_]*\)".*/\1/p')
kontrol "pair: cift onayda token uretildi" "dev_" bash -c "echo '${TOKEN}'"
kontrol "pair: token ile erisim (parolasiz)" "Birinci" curl -s -H "X-Api-Key: ${TOKEN}" "$B/api/notes"
kontrol "pair: kod imha (tekrar yok)"  "yok"    curl -s "$B/api/pair/durum?kod=$KOD&claimId=$CLAIMID"
kontrol "pair: cihaz listede isimle"   "TestCihaz" curl -s -H "X-Api-Key: test123" "$B/api/devices"
kontrol "pair: public listede token yok" "token-gizli" bash -c "R=\$(curl -s -H 'X-Api-Key: test123' '$B/api/devices'); [[ \"\$R\" != *dev_* && \"\$R\" != *token* ]] && echo token-gizli"
kontrol "pair: cihaz rolu gorunur"      '"role":"device"' curl -s -H "X-Api-Key: ${TOKEN}" "$B/api/session"
kontrol "pair: cihaz yeni kod uretemez" "yalniz ana cihaz" curl -s -X POST -H "X-Api-Key: ${TOKEN}" "$B/api/pair/new"
kontrol "pair: cihaz liste yonetemez"   "yalniz ana cihaz" curl -s -H "X-Api-Key: ${TOKEN}" "$B/api/devices"
kontrol "pair: cihaz graphify calistiramaz" "yalniz ana cihaz" curl -s -X POST -H "X-Api-Key: ${TOKEN}" "$B/api/graphify/build"
kontrol "pair: cihaz sistem kurulumu yapamaz" "yalniz ana cihaz" curl -s -H "X-Api-Key: ${TOKEN}" "$B/api/runtime"
kontrol "pair: cihaz yerel kasa tarayamaz" "yalniz ana cihaz" curl -s -H "X-Api-Key: ${TOKEN}" "$B/api/import/obsidian"
kontrol "pair: cihaz fact gecersiz kilamaz" "yalniz ana cihaz" curl -s -X POST -H "X-Api-Key: ${TOKEN}" -H "Content-Type: application/json" -d '{}' "$B/api/memory/facts/$FACT_TWO_ID/invalidate"
kontrol "pair: cihaz hard forget yapamaz" "yalniz ana cihaz" curl -s -X POST -H "X-Api-Key: ${TOKEN}" -H "Content-Type: application/json" -d '{"confirm":"KALICI OLARAK UNUT"}' "$B/api/memory/facts/$FACT_TWO_ID/forget-hard"
kontrol "pair: cihaz host CLI Konseyini calistiramaz" "yalniz ana cihaz" curl -s -X POST -H "X-Api-Key: ${TOKEN}" -H "Content-Type: application/json" -d '{"agent":"claude","message":"test"}' "$B/api/konsey"
kontrol "pair: cihaz peer topolojisini goremez" "yalniz ana cihaz" curl -s -H "X-Api-Key: ${TOKEN}" "$B/api/sync/status"
kontrol "kasa: cihaz sifirlayamaz"      "yalniz ana cihaz" curl -s -X POST -H "X-Api-Key: ${TOKEN}" -H "Content-Type: application/json" -d '{"confirm":"SIFIRLA"}' "$B/api/vault/reset"
kontrol "kasa: sifirlama acik onay ister" "SIFIRLA yaz" curl -s -X POST -H "X-Api-Key: test123" -H "Content-Type: application/json" -d '{}' "$B/api/vault/reset"
kontrol "kasa: sifreli yedekle sifirlanir" '"ok":true' curl -s -X POST -H "X-Api-Key: test123" -H "Content-Type: application/json" -d '{"confirm":"SIFIRLA"}' "$B/api/vault/reset"
kontrol "kasa: sifirlama sonrasi aktif kasa yok" "404" curl -s -o /dev/null -w '%{http_code}' -H "X-Api-Key: test123" "$B/api/vault"
DEVICE_ID=$(curl -s -H "X-Api-Key: test123" "$B/api/devices" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
kontrol "pair: id ile iptal edilir"     "iptal"  curl -s -X POST -H "X-Api-Key: test123" -H "Content-Type: application/json" "$B/api/devices/iptal" -d "{\"id\":\"${DEVICE_ID}\"}"
kontrol "pair: iptalden sonra token 401" "kimlik" curl -s -H "X-Api-Key: ${TOKEN}" "$B/api/notes"
kontrol "pair: gecersiz kod reddi"     "gecersiz" curl -s -X POST "$B/api/pair/claim" -d '{"kod":"000000","cihazAdi":"X"}'
# kaba kuvvet kalkani: ayni IP'den arka arkaya claim -> 429 (bu test EN SONDA
# olmali, oncesindeki mesru claim'leri bogmasin)
kontrol "pair: claim hiz siniri (429)" "cok fazla" bash -c "R=''; for i in 1 2 3 4 5 6; do R=\$(curl -s -X POST '$B/api/pair/claim' -d '{\"kod\":\"111111\",\"cihazAdi\":\"BruteBot\"}'); done; echo \"\$R\""

# oto-zihin: not yazilinca bekleyen tarama DISKE dusmus olmali (kapaninca kaybolmaz)
kontrol "oto-zihin bekleyen tarama diskte" "zaman" cat "$T/NotlarSync/oto-bekleyen.json"
kontrol "veri klasoru izni 700" "700" stat -c %a "$T/NotlarSync"
kontrol "not dosyasi izni 600" "600" stat -c %a "$T/NotlarSync/notes/Birinci.md"
kontrol "ic ice klasor izni 700" "700" stat -c %a "$T/NotlarSync/notes/Arsiv/Alt"
kontrol "ic ice not izni 600" "600" stat -c %a "$T/NotlarSync/notes/Arsiv/Alt/Klasorlu.md"
kontrol "config dosyasi izni 600" "600" stat -c %a "$T/NotlarSync/app-config.json"
kontrol "cihaz dosyasi izni 600" "600" stat -c %a "$T/NotlarSync/devices.json"
kontrol "kasa yedegi izni 600" "600" stat -c %a "$T/NotlarSync/vault.enc.bak"
kontrol "kasa sifirlama yedegi izni 600" "600" stat -c %a "$T/NotlarSync/vault.enc.reset.bak"
kontrol "hafiza klasoru izni 700" "700" stat -c %a "$T/NotlarSync/memory"
kontrol "hafiza durum dosyasi izni 600" "600" stat -c %a "$T/NotlarSync/memory/state.json"
kontrol "paket eslestirme modulunu icerir" "paket-tamam" node -e "const p=require('./package.json'); const f=p.build.files||[]; if(f.includes('eslestirme.js')) console.log('paket-tamam')"
kontrol "paket kurulum ve import modullerini icerir" "paket-tamam" node -e "const p=require('./package.json'); const f=p.build.files||[]; if(f.includes('installer.js') && f.includes('obsidian.js')) console.log('paket-tamam')"
kontrol "paket hafiza ve hook modullerini icerir" "paket-tamam" node -e "const p=require('./package.json'); const f=p.build.files||[]; if(f.includes('memory.js') && f.includes('temporal.js') && f.includes('integrations.js') && f.includes('agent-bridge.js')) console.log('paket-tamam')"
kontrol "paket peer sync modulunu icerir" "paket-tamam" node -e "const p=require('./package.json'); const f=p.build.files||[]; if(f.includes('peer-sync.js')) console.log('paket-tamam')"
kontrol "memory reliability cekirdek testleri" "memory-reliability: ok" node tests/memory-reliability.test.js
kontrol "10k fact indeks dogrulugu" "scale-eval: ok" node olcum/memory-scale-eval.js --ci
kontrol "peer sync cekirdek birlestirme" "peer-sync: ok" node tests/peer-sync.test.js
kontrol "peer sync iki sunucu entegrasyonu" "peer-sync-integration: ok" node tests/peer-sync-integration.test.js

echo
echo "sonuc: $GECTI gecti, $KALDI kaldi"
[ "$KALDI" -eq 0 ]
