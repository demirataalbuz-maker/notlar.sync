# 🗒️ Notlar Sync

İki (veya daha fazla) bilgisayar arasında **anlık ve çevrimdışı çalışabilen senkron** sunan, yerel öncelikli masaüstü not ve kişisel bilgi alanı. Her eşleşmiş bilgisayar notların tam yerel kopyasını tutar. Bir cihaz kapalıyken ötekinde yazmaya devam edebilir, iki cihaz yeniden çevrimiçi olduğunda değişiklikleri otomatik birleştirebilirsin.

- Electron masaüstü uygulaması ve telefona kurulabilen PWA
- Genel Bakış, Notlar, AI Beyni, Şifre Kasası, Kodlama Araçları, Yerel AI, Belge, Kurulum, Senkron ve Ayarlar için ayrı tam sayfa menüler
- Notlar gerçek alt klasörleri korunarak düz `.md` dosyaları halinde saklanır (`notes/` klasörü)
- Bilgisayarlar arasında vector-clock tabanlı kalıcı peer replikasyonu; aynı sunucuya bağlı tarayıcılarda WebSocket ile canlı güncelleme
- Bağlantı kesilince yerel `.md` dosyalarına yazma, dönüşte otomatik yakalama; eşzamanlı iki sürümde veri kaybetmeyen çakışma kopyası
- Çöp kutusu, geri yükleme, sabitleme ve bağlantıları da güncelleyen güvenli yeniden adlandırma
- Ana parola ile host yönetimi, her eşleşmiş cihaz için ayrı iptal edilebilir erişim anahtarı

## Kurulum (kolay yol)

[Releases](../../releases) sayfasından işletim sistemine uygun dosyayı indir:

- **Windows:** `.exe` — çift tıkla, kurulur
- **Linux:** `.deb` (önerilen) veya `.AppImage` (Ubuntu 22.04+/Debian 12+'da `sudo apt install libfuse2` gerekebilir)
- **macOS:** `.dmg` — imzasız olduğu için ilk açılışta sağ tık → Aç gerekir

İlk açılışta temel uygulama otomatik hazırlanır: notların ve ayar dosyan `~/NotlarSync` altında oluşturulur. İlk parola rastgele üretilir ve Electron uygulaması güvenli biçimde otomatik giriş yapar; sonrasında **Ayarlar → Güvenlik** bölümünden değiştirebilirsin. PDF, OCR, Whisper ve yerel AI gibi ağır çalışma bileşenleri **Kurulum Merkezi → Eksiklerin tümünü kur** ile uygulama içinden kurulabilir.

## Kurulum (kaynak koddan)

```bash
git clone https://github.com/demirataalbuz-maker/notlar.sync.git notlar-sync && cd notlar-sync
npm install
npm start
```

Ayar dosyası ilk açılışta `~/NotlarSync/app-config.json` olarak oluşur.

## İki PC'yi bağlama

İki bilgisayara da Notlar Sync'i kurup normal **yerel kopya** modunda aç. Eşleştirme yalnız bir kere yapılır:

1. İki bilgisayarı da aç ve **Senkron ve Cihazlar** sayfasına gir.
2. İlk bilgisayarda **6 haneli kod üret** düğmesine bas; ekrandaki adresi ve kodu al.
3. İkinci bilgisayarda adresi, bu cihazın adını ve kodu girip **Bağlantı isteği gönder** düğmesine bas.
4. İlk bilgisayarda beliren cihaz adını/adresini kontrol edip **Onayla**.
5. İlk kopyalama otomatik başlar. Bundan sonra uygulamalar açık ve birbirine erişebilir olduğunda beş saniye içinde otomatik eşitlenir; **Şimdi eşitle** yalnız isteğe bağlı elle yoklamadır.

Her iki taraf bağımsız yazabilir. A kapalıyken B'de, B kapalıyken A'da yapılan not değişiklikleri diskte bekler ve yeniden buluşunca iki yönde taşınır. Aynı not iki tarafta ortak tabandan sonra farklı düzenlenmişse sistem bir sürümü ana not, diğerini `- çakışma <cihaz>-<özet>` adlı ayrı not yapar; hiçbir içerik sessizce ezilmez. Nedensel silmeler tombstone olarak yayılır ve eski cihaz notu yanlışlıkla diriltmez.

Peer anahtarları 256 bittir; API durumunda veya arayüzde gösterilmez. `~/NotlarSync/sync/` dizini `0700`, durum/cihaz dosyaları ve içerik sürüm blobları `0600` izinleriyle, atomik yazılır. **Kaldır** yalnız otomatik bağlantıyı siler; iki bilgisayardaki yerel notları silmez.

Eski **ana cihaz / istemci** modu ve tarayıcı erişim kodları geriye uyumluluk için durur; gerçek çevrimdışı iki-PC kullanımı için iki masaüstünde de yerel kopya eşleştirmesini kullan.

## Farklı ağlardan erişim

En kolay ve güvenli yol [Tailscale](https://tailscale.com): iki PC'ye de kur, aynı hesapla gir ve eşleştirme ekranında ana cihazın Tailscale IP'sini (`100.x.x.x`) kullan. Port açmak, internete servis ifşa etmek yok; trafik uçtan uca şifreli.

> ⚠️ Sunucuyu doğrudan internete (port yönlendirme vs.) açmayın: trafik TLS'siz, parola tek koruma katmanı. Tailscale/VPN kullanın.

## Bilinen kısıtlar

- Bu bir ortak-yazım CRDT editörü değildir. Aynı not iki cihazda eşzamanlı değiştirilirse sürümler sessizce ezilmez; yerel sürüm zaman damgalı bir çakışma notuna alınır.
- Peer replikasyonunun bu sürümü Markdown notlarını ve not yolu içindeki klasör yapısını taşır. Boş klasörler, `files/` ekleri, Şifre Kasası, yapılandırılmış AI hafızası ve Saldırı Avcısı'nın kendi verisi henüz peer'ler arasında kopyalanmaz.
- Telefon/PWA ana bilgisayara canlı bağlanabilir ve çevrimdışı tarayıcı taslağı tutar; telefon bu sürümde bağımsız peer sunucusu değildir. Tam çevrimdışı iki yönlü replikasyon masaüstü uygulamaları arasındadır.
- Şifre kasasının ana parolası kurtarılamaz. Sunucu bu parolayı veya çözülmüş kasa içeriğini bilmez.

## Otomatik GitHub yedeği

Notlar klasörünü özel (private) bir GitHub reposuna otomatik yedekletebilirsin. Bir kere kur:

```bash
cd ~/NotlarSync
git init -b main
git remote add origin git@github.com:KULLANICI/notlarim.git   # OZEL repo olsun!
```

sonra Ayarlar'dan **GitHub otomatik yedek** seçeneğini aç. Her değişiklikten yaklaşık 30 saniye sonra sessizce commit/push yapılır. `app-config.json`, cihaz tokenları, kasa blobları ve geçici AI dosyaları otomatik `.gitignore`'a alınır.

## AI Beyni: Codex, Claude ve diğer ajanlar

Notlar Sync farklı AI istemcileri için ortak, kalıcı ve yerel bir beyin görevi görür. Tek bir büyüyen `AI-Hafiza.md` yerine proje kapsamlı yapılandırılmış kayıtlar kullanır:

- kullanıcı tercihleri ve kalıcı olgular
- proje kararları ve açık görevler
- AI oturumları, olaylar ve heartbeat durumu
- tamamlanan işler, değişen dosyalar ve sıradaki adımı içeren checkpointler
- isteğe bağlı konuşma özetleri; tam arşiv varsayılan olarak kapalıdır

Veri `~/NotlarSync/memory/` altında `0700/0600` izinleriyle tutulur ve otomatik Git yedeğine dahil edilmez. Parola, token, özel anahtar ve yaygın API anahtarı biçimleri kayıt öncesinde redakte edilir. Bir ajan çökerse 30 dakika sonra oturum `interrupted` olur ve son checkpoint kurtarma bağlamı olarak kalır.

### Temporal fact katmanı (zaman + provenance)

Hafıza yalnız "ne kaydedildi" değil, **bir bilginin ne zaman doğru olduğunu, kimin yazdığını ve neyle değiştiğini** de tutar. Her fact `özne + yüklem + değer` üçlüsüdür ve `active / superseded / invalidated / disputed / forgotten` durumları, `confidence`, `validFrom → validTo` geçerlilik aralığı ve kaynak zinciri (ajan → oturum → checkpoint/olay/not) taşır:

- Aynı özne+yüklem için yeni değer eskisini **silmez**: eski kayıt `superseded` olur, `validTo` alır ve iki kayıt `supersedes / supersededBy` ile bağlanır.
- Düşük güvenli veya çelişkili bilgi otomatik ezilmez; `disputed` olarak görünür kalır ve varsayılan recall'da geriye düşer.
- Checkpoint yazıldığında kararlar, açık görevler, tamamlananlar ve riskler otomatik fact'e dönüşür; provenance zinciri `oturum → checkpoint → fact` olarak izlenebilir.
- Her fact bir `assertionType` (`user / agent / imported / inferred / system`) ve `evidenceLevel` (`direct / derived / unverified`) taşır. Kullanıcının manuel girdisi doğrudan kanıt sayılır; ajan/import/system girdisinde en az bir session/checkpoint/event/note/file kaynağı gerekir. Kaynaksız AI iddiası kesin gerçek sayılmaz: `unverified + disputed`, en çok `0.35` güven ve recall evidence cezası alır.
- Provenance cevabı insan-okur `explanation` yanında çözümlenmiş/çözümlenememiş session, checkpoint, event, note ve file adımlarından oluşan makine-okur `evidenceChain` döndürür. Yeni source, topic ve tag alanları da kayıt öncesi hassas veri redaksiyonundan geçer.
- `hatirla`/recall `asOf` ("X mart ayında ne kullanıyordu?"), `includeHistorical`, `includeDisputed` ve `explain` (skor kırılımı + `whyMatched` açıklaması) parametrelerini destekler.
- Eski yapılandırılmış hafızalar `POST /api/memory/facts/migrate` ile idempotent biçimde fact'e dönüştürülebilir.
- Kesin aynı slot mevcut supersede kuralını kullanır. Yakın ama aynı olmayan bilgiler `conflictSuggestions` olarak döner ve kullanıcı/ajan `supersede`, `dispute` veya `keep-separate` kararı vermeden otomatik hüküm kurulmaz.

`soft` ve `hard` unutma farklı güvenlik işlemleridir:

- `soft`: zaman/supersede zincirini anonim tombstone olarak korur; subject, object, value, topic, tags, workspace ve kaynak file/note alanlarını `[UNUTULDU]` ile değiştirir. Eski metin recall, provenance, graph, UI, yerel indeks ve fact'e ait embedding önbellek girdisinden çıkmaz.
- `hard`: fact'i tamamen siler, ters supersede referanslarını, indeks kaydını ve fact'e ait embedding önbellek girdisini temizler. Yalnız ana cihazda, ayrı `POST /api/memory/facts/:id/forget-hard` ucunda `{"confirm":"KALICI OLARAK UNUT"}` açık onayıyla çalışır. Geriye uyumlu `/api/memory/forget` ucu `mode: "soft" | "hard"` kabul eder; varsayılan daima `soft`tur. Cevap fact, ilişki, indeks ve embedding temizleme sayaçlarını ayrı verir.

Canonical kayıt yine atomik `state.json`'dır. Recall adayları Node çalışma zamanı destekliyorsa yerel SQLite FTS5'ten, aksi halde bağımlılıksız atomik inverted-index'ten gelir. İndeks türetilmiş veridir: bozuk, eksik veya yeniden kuruluyor olduğunda sorgu otomatik olarak canonical JSON taramasına düşer. `GET /api/memory/index` durum verir; ana cihaz `POST /api/memory/index/rebuild` ile yeniden kurabilir.

REST uçları: `GET/POST /api/memory/facts`, `POST /api/memory/facts/conflicts`, `GET /api/memory/facts/:id/provenance`, `POST /api/memory/facts/:id/invalidate|dispute|conflict`, `GET /api/memory/timeline?subject=...`. Temporal değerlendirme `npm run eval:temporal` ile current/historical/provenance metriklerini raporlar.

### Oturum yaşam döngüsü

1. `oturum_baslat`: proje ve çalışma klasörüne göre son checkpoint, kararlar, görevler ve ilgili anıları token bütçeli bağlam olarak getirir.
2. `hatirla`: metin skoru, güncellik, proje kapsamı, bilgi grafı ve kuruluysa `nomic-embed-text` benzerliğini birlikte kullanır.
3. `olay_kaydet`: yalnız gelecekte gerekli karar, sonuç, hata, tercih ve görevleri yapılandırılmış kaydeder.
4. `checkpoint_yaz`: tamamlananlar, dosyalar, kararlar, riskler, açık işler ve kesin sıradaki adımı saklar.
5. `oturum_nabiz`: uzun çalışmanın canlı olduğunu bildirir.
6. `oturum_kapat`: final checkpointi yazar ve oturumu kapatır.

**AI Beyni → Ayarlar → Bağlantıları kur / onar** işlemi kurulu Codex ve Claude Code istemcilerini kullanıcı seviyesinde yapılandırır. MCP kaydı ve yaşam döngüsü hookları birlikte kurulur. Codex güvenlik gereği hookları ilk kullanımda `/hooks` ekranından bir kez onaylatabilir. Claude Code başlangıç, prompt, araç kullanımı, sıkıştırma, durdurma ve oturum kapanışı olaylarını otomatik bağlar.

MCP sunucusu 19 araç yayınlar: 8 not/graf aracı ve 11 oturum/hafıza aracı (`hafiza_gercek_yaz` ile zaman farkındalıklı fact yazımı, `hafiza_gecmisini_sor` ile timeline/provenance sorgusu dahil). Yerel sunucu kapalıysa paketli entegrasyon onu arka planda başlatmayı dener. Manuel kurulum gerekirse:

```bash
codex mcp add notlar-sync -- node /NOTLAR-SYNC-YOLU/mcp.js
claude mcp add --scope user notlar-sync -- node /NOTLAR-SYNC-YOLU/mcp.js
```

Farklı adres için `NOTLAR_URL`, farklı yerel port için `NOTLAR_PORT` kullanılabilir. Uzak istemciler aynı yaşam döngüsünü kimlik doğrulamalı `/api/memory/*` REST uçlarıyla da çağırabilir.

```bash
curl -X POST -H "X-Api-Key: ANAHTAR" -H "Content-Type: application/json" \
  -d '{"agent":"özel-ajan","workspace":"/proje","project":"Proje"}' \
  "http://HOST:7777/api/memory/session/start"

curl -X POST -H "X-Api-Key: ANAHTAR" -H "Content-Type: application/json" \
  -d '{"query":"en son nerede kaldık?","workspace":"/proje","project":"Proje"}' \
  "http://HOST:7777/api/memory/recall"
```

## AI Beyni ve not grafı

**AI Beyni** ekranı projeleri, oturumları, checkpointleri, kararları, görevleri ve Markdown not grafını tek canlı yüzeyde gösterir. Aktif bağlam son checkpointi öne çıkarır; Zaman ve Kümeler görünümleri aynı kayıtları farklı düzenler. “Zihnine sor” alanı ilgili hafıza ve not kaynaklarını yerel karma aramayla getirir.

Not grafı, notlar arası `[[link]]` bağlantılarından otomatik oluşur. Notların
düğüm, `[[link]]`ler kenar olarak çizilir. En çok bağlantılı notlar büyür
(god node), birbirine sıkı bağlı notlar öbeklere ayrılır (topluluk tespiti),
henüz yazılmamış `[[link]]` hedefleri "hayalet" düğüm olur. Bir not
eklenince/değişince graf **anında** kendini günceller. Eski `AI-Hafiza` notları
geriye dönük uyumluluk için not arşivinde kalabilir; yeni oturum sistemi bunlara bağlı değildir.

Notlarında bağlantı kurmak için Obsidian gibi `[[Not Adı]]` yaz — o nota giden
bir kenar oluşur. AI ajanları da not yazarken `[[link]]` kullanırsa harita
kendiliğinden zenginleşir. İncelikler:

- **Yazım toleransı**: `[[Köpek Bakımı]]`, `[[kopek-bakimi]]` ve `[[KOPEK BAKIMI]]`
  aynı düğümde birleşir (küçük/büyük harf, Türkçe aksan, boşluk/tire farkları önemsiz).
- **İlişki tipi** (istersen): `esinlendi:: [[Gandalf]]` yazarsan kenar "esinlendi"
  etiketini taşır; düz `[[link]]` etiketsiz kalır.
- **Yol bulma**: haritada **shift+tık** ile iki düğüm seç — aralarındaki en kısa
  bağlantı zinciri beyazla vurgulanır.
- **🤖 AI önerisi** (opsiyonel, [Ollama](https://ollama.com) varsa): local model
  not içeriklerine bakıp "bunlar ilişkili olabilir" der. Öneriler **kesikli pembe**
  çizilir ve **sen "✚ nota yaz" demeden hiçbir yere yazılmaz** — kabul edersen
  notun sonuna gerçek bir `[[link]]` satırı eklenir. Ollama yoksa buton kibarca
  "AI yok/kapalı" der, harita aynen çalışır.

**AI'lar için** — grafı ham dosya okumadan JSON olarak sorgula:

```bash
curl -H "X-Api-Key: ANAHTAR" "http://HOST:7777/api/graph"
curl -H "X-Api-Key: ANAHTAR" "http://HOST:7777/api/graph?gizli=1"
curl -H "X-Api-Key: ANAHTAR" --get "http://HOST:7777/api/graph/explain" --data-urlencode "node=Not Adı"
curl -H "X-Api-Key: ANAHTAR" --get "http://HOST:7777/api/graph/path" --data-urlencode "from=A" --data-urlencode "to=B"
curl -H "X-Api-Key: ANAHTAR" "http://HOST:7777/api/graph/suggest"
```

### Klasörler ve Obsidian aktarımı

Notlar ekranı disk üzerindeki gerçek iç içe klasörleri gösterir. Klasör oluşturma,
yeniden adlandırma, boş klasör silme ve notu sürükleyerek klasöre taşıma desteklenir.
**Notlar → İçe aktar** veya **Kurulum Merkezi → Obsidian kasalarını içe aktar**
bilgisayardaki kasaları algılar; notları ve klasörleri kopyalar, kaynak kasaya
dokunmaz, çakışan dosyaları ayrı kopyada korur ve ek bağlantılarını yeni konuma çevirir.

### Belge motoru, Kurulum Merkezi ve dışa aktarma

Belge ve graf motorunun çekirdeği uygulamaya gömülüdür. **Kurulum Merkezi** eksik
bileşenleri algılar ve yalnız sabit, izinli paketleri kurar:

- PDF metni: `pdftotext`
- Görsel metni: Türkçe/İngilizce Tesseract OCR veya yerel vision modeli
- Ses/video: uygulamaya özel sanal ortamda Faster Whisper
- Yerel AI: Ollama, ayarlı metin modeli, `qwen2.5vl:3b` görsel modeli ve `nomic-embed-text` hafıza modeli
- Dışa aktarma: gömülü SVG, GraphML, Neo4j Cypher, Obsidian ve wiki üreticileri

Linux'ta sistem paketleri kurulurken standart yönetici onay penceresi açılır.
Kurulum komutları API'den değiştirilemez ve yalnız ana bilgisayardaki masaüstü
uygulamasından başlatılabilir. Ollama kuruluysa uygulama açılışında servisi otomatik başlatır.

```bash
curl -H "X-Api-Key: ANAHTAR" "http://HOST:7777/api/motor"
curl -X POST -H "X-Api-Key: ANAHTAR" --data-binary @rapor.pdf "http://HOST:7777/api/belge?ad=rapor.pdf"
curl -H "X-Api-Key: ANAHTAR" "http://HOST:7777/api/graph/export?format=svg" -o harita.svg
```

## 🔐 Şifre Kasası

Kenar çubuğundaki 🔐 düğmesi: ana parolayla açılan sıfır-bilgi şifre kasası.
Şifreleme/çözme tamamen cihazında yapılır (Web Crypto, PBKDF2-SHA256 600 bin tur + AES-256-GCM) —
sunucu yalnızca şifreli blob'u saklar, **içini asla açamaz**. Tarayıcıdan CSV
import (Chrome/Bitwarden dışa aktarımı) ve güçlü parola üretici içerir.
Kasa hareketsizlikte otomatik kilitlenir; iki cihazdaki eski kopyalar ETag
kontrolü sayesinde birbirini sessizce ezemez. Kayıtlar sonradan düzenlenebilir ve
kasa ana parolası açık kasadan değiştirilebilir. Ana parolayı unutursan içerik
kurtarılamaz; ana cihazdaki sıfırlama işlemi eski şifreli blob'u yerel yedeğe alır
ve yeni, boş bir kasa oluşturmayı sağlar.

## 🧰 Kodlama Araçları ve 🤖 Local AI

- **🧰 Araçlar**: Base64/32, Hex, Morse, ROT13/Caesar/Vigenère, JWT çözücü,
  SHA özetleri + "sihirli çöz" (kodlamayı tahmin eder). Tamamen offline.
- **🤖 AI**: makinede [Ollama](https://ollama.com) kuruluysa EN→TR çeviri ve
  "AI'a sor" panelini açar. Model gömülü değildir; mevcut Ollama'n kullanılır,
  hiçbir veri internete çıkmaz. Ollama kurulu/açık değilse panel "AI yok/kapalı"
  hatası gösterir; uygulamanın geri kalanı etkilenmez.

### AI Konsey ve Saldırı Avcısı

**AI Konsey**, bu bilgisayarda giriş yapılmış Claude ve Codex CLI'larını `/claude`,
`/codex` veya `/all` komutuyla çağırır. Her çağrı boş bir geçici çalışma dizininde;
Claude araçları kapalı, Codex salt-okunur sandbox'ta, 120 saniye ve 1 MiB çıktı
sınırıyla çalışır. CLI hesabına göre metin bulut sağlayıcıya gönderilebilir; parola,
token veya özel sır yapıştırma. Konsey yalnız ana masaüstündeki yerel isteklerden
çalıştırılabilir ve sohbet istenirse normal Markdown nota kaydedilebilir; kaydedilen
not peer senkronuna dahildir.

**AI Saldırı Avcısı** ayrı bir yerel uygulamadır. Motor varsayılan olarak Claude'un
araştırdığı, Codex'in denetlediği ve Python'un kaynak metnini doğruladığı zinciri kullanır;
senaryo metni AI tarafından uydurulmaz. Notlar Sync yalnız servis durumunu
yoklar ve hazırsa arayüzünü çerçeveler; notları veya eşleştirme anahtarlarını ona
aktarmaz. Varsayılan adres `http://127.0.0.1:7788/` olup Ayarlar'dan başka bir yerel
http/https adresine değiştirilebilir. Servis kapalıysa boş ekran yerine durum ve
yeniden deneme düğmesi görünür.

## Tarayıcı eklentisi (web şifrelerini yakala)

`extension/` klasöründeki eklenti, web sitelerine girdiğin şifreleri Google gibi "kaydedeyim mi?" diye sorup kasaya ekler. **Sistem-geneli dinleme (keylogger) yoktur** — sadece tarayıcı formlarına takılır ve her zaman önce sana sorar.

Kurulum (Chrome/Edge/Brave):
1. `chrome://extensions` → sağ üstten **Geliştirici modu**'nu aç
2. **Paketlenmemiş öğe yükle** → kaynak kodda `extension/`, paketli uygulamada `resources/extension` klasörünü seç
3. Eklenti simgesine tıkla → kasa adresini (`http://localhost:7777` veya ana cihazın Tailscale adresi) ve ana parola/cihaz anahtarını gir

Bir siteye giriş yapınca "Kaydet?" banner'ı çıkar. Kabul edersen şifre, **uygulama açık ve kasa kilidi açıkken** onayınla kasaya eklenir. Yakalanan şifre yalnızca sunucunun RAM'inde geçici durur; diske/git'e asla yazılmaz.

## Tarayıcıdan kullanım

Electron şart değil — host çalışırken herhangi bir cihazdan `http://HOST_ADRESI:7777` açman yeterli. Sunucuyu tek başına çalıştırmak için: `npm run server`

## Doğrulama

```bash
npm test       # API, WebSocket, çakışma, cihaz yetkisi, kasa ve dosya izinleri
npm run check  # Node/renderer/eklenti sözdizimi
npm run eval:temporal # current, historical ve provenance doğruluğu
npm run eval:scale    # 10.000 fact: p50/p95, top-3, as-of, forget ve izolasyon
npm run eval:scale -- --large # isteğe bağlı 100.000 fact ölçümü
```

## Lisans

[ISC](LICENSE)
