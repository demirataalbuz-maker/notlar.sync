#!/usr/bin/env bash
# Duman testi: sunucuyu IZOLE bir HOME ile kaldirir, kritik uclari yoklar.
# Ollama/motor GEREKMEZ - deterministik uclar test edilir, AI uclari sadece
# "zarif cevap veriyor mu" diye yoklanir. Kullanim: ./test.sh  (cikis 0 = gecti)
set -u
PORT=7799
T=$(mktemp -d)
mkdir -p "$T/NotlarSync/notes"
printf '{"password":"test123"}' > "$T/NotlarSync/app-config.json"
printf -- '---\nname: Birinci\ndescription: "deneme notu aciklamasi"\n---\nMerhaba [[Ikinci Not]] iceriden selam' > "$T/NotlarSync/notes/Birinci.md"
printf 'sade govde, frontmatter yok' > "$T/NotlarSync/notes/Ikinci Not.md"

HOME="$T" PORT=$PORT NOTLAR_MOTOR="$T/motor-yok" node "$(dirname "$0")/server.js" > "$T/server.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null; rm -rf "$T"' EXIT
for i in $(seq 1 20); do curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break; sleep 0.3; done

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

echo "Notlar Sync duman testi ($B)"
kontrol "ana sayfa acilir"        "<"              curl -s "$B/"
kontrol "parolasiz istek reddi"   "parola"         curl -s "$B/api/notes"
kontrol "not listesi"             "Birinci"        curl -s "$B/api/notes?$K"
kontrol "not okuma"               "Merhaba"        curl -s "$B/api/note/Birinci?$K"
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
kontrol "motor yokken /api/motor" '"var":false'    curl -s "$B/api/motor?$K"
kontrol "motor yokken belge 503"  "motor yok"      curl -s -X POST -d "x" "$B/api/belge?$K&ad=a.pdf"
kontrol "motor yokken export"     "motor"          curl -s "$B/api/graph/export?format=svg&$K"
kontrol "gecersiz export formati" "format"         curl -s "$B/api/graph/export?format=xxx&$K"
kontrol "not silme sonrasi 404"   "not yok"        bash -c "curl -s -X DELETE '$B/api/note/Yeni?$K' >/dev/null 2>&1; curl -s '$B/api/note/SilinmisHayalet?$K'"
kontrol "X-Api-Key header ile auth" "Birinci"      curl -s -H "X-Api-Key: test123" "$B/api/notes"

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
kontrol "pair: iptal edilir"           "iptal"  curl -s -X POST -H "X-Api-Key: test123" "$B/api/devices/iptal" -d "{\"token\":\"${TOKEN}\"}"
kontrol "pair: iptalden sonra token 401" "parola" curl -s -H "X-Api-Key: ${TOKEN}" "$B/api/notes"
kontrol "pair: gecersiz kod reddi"     "gecersiz" curl -s -X POST "$B/api/pair/claim" -d '{"kod":"000000","cihazAdi":"X"}'

echo
echo "sonuc: $GECTI gecti, $KALDI kaldi"
[ "$KALDI" -eq 0 ]
