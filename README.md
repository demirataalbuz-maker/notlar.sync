# 🗒️ Notlar Sync

İki (veya daha fazla) bilgisayar arasında **anlık senkron** çalışan, Obsidian görünümlü masaüstü not uygulaması. Bir PC'de yazdığın her harf, aynı notu açık tutan diğer PC'de anında belirir.

- Electron masaüstü uygulaması, koyu tema
- Notlar düz `.md` dosyası olarak saklanır (`notes/` klasörü)
- WebSocket ile canlı senkron, kopunca otomatik yeniden bağlanır
- Parola korumalı (istersen kapatılabilir: config'de `"password": ""`)

## Kurulum (kolay yol)

[Releases](../../releases) sayfasından işletim sistemine uygun dosyayı indir:

- **Windows:** `.exe` — çift tıkla, kurulur
- **Linux:** `.deb` (önerilen) veya `.AppImage` (Ubuntu 22.04+/Debian 12+'da `sudo apt install libfuse2` gerekebilir)
- **macOS:** `.dmg` — imzasız olduğu için ilk açılışta sağ tık → Aç gerekir

İlk açılışta her şey otomatik hazırlanır: notların ve ayar dosyan ev dizininde `~/NotlarSync` klasörüne oluşturulur. Parolayı `~/NotlarSync/app-config.json` içinden değiştirmeyi unutma!

## Kurulum (kaynak koddan)

```bash
git clone https://github.com/demirataalbuz-maker/notlar-sync.git && cd notlar-sync
npm install
npm start
```

Ayar dosyası ilk açılışta `~/NotlarSync/app-config.json` olarak oluşur.

## İki PC'yi bağlama

Bir PC **host** olur (sunucu onun içinde çalışır), diğerleri **client** olarak bağlanır.

**Host PC** — `~/NotlarSync/app-config.json`:
```json
{ "mode": "host", "password": "guclu-bir-parola" }
```

**Client PC** — `~/NotlarSync/app-config.json`:
```json
{ "mode": "client", "server": "http://HOST_ADRESI:7777" }
```

Client ilk açılışta ekranda parola sorar; host'taki parolayı gir.

## Farklı ağlardan erişim

En kolay ve güvenli yol [Tailscale](https://tailscale.com): iki PC'ye de kur, aynı hesapla gir, client config'inde host'un Tailscale IP'sini (`100.x.x.x`) kullan. Port açmak, internete servis ifşa etmek yok; trafik uçtan uca şifreli.

> ⚠️ Sunucuyu doğrudan internete (port yönlendirme vs.) açmayın: trafik TLS'siz, parola tek koruma katmanı. Tailscale/VPN kullanın.

## Bilinen kısıtlar

- Çakışma modeli **son yazan kazanır**: iki kişi aynı anda aynı nota yazarsa imleç zıplayabilir, tuş vuruşu kaybolabilir. Bu bir ortak-yazım (CRDT) editörü değil, kişisel senkron not defteridir.
- İlk kurulumda parola otomatik rastgele üretilir (`~/NotlarSync/app-config.json`); client'lara bunu girmen gerekir.

## Otomatik GitHub yedeği

Notlar klasörünü özel (private) bir GitHub reposuna otomatik yedekletebilirsin. Bir kere kur:

```bash
cd ~/NotlarSync
git init -b main
git remote add origin git@github.com:KULLANICI/notlarim.git   # OZEL repo olsun!
```

sonra config'de `"gitAutoPush": true` yap. Artık her değişiklikten ~30sn sonra arkada sessizce commit + push atılır. Parolalı `app-config.json` otomatik `.gitignore`'a alınır, repoya asla girmez.

## AI entegrasyonu (Claude Code, Codex, ...)

Notlar düz `.md` dosyası olduğu için AI ajanları doğrudan okuyup yazabilir. Uzak cihazdaki AI'lar için REST API:

```bash
curl "http://HOST:7777/api/notes?key=PAROLA"                      # not listesi
curl "http://HOST:7777/api/note/AI-Hafiza?key=PAROLA"             # notu oku
curl -X POST "http://HOST:7777/api/note/AI-Hafiza?key=PAROLA" -d "içerik"        # yaz
curl -X POST "http://HOST:7777/api/note/AI-Hafiza?key=PAROLA&append=1" -d "satır" # sona ekle
```

API'den yazılanlar, notu açık tutan tüm editörlerde **anında** belirir. Ajanlarının her oturumda "yaptığın işi `AI-Hafiza` notuna logla" talimatını alması için global talimat dosyasına (Claude Code: `~/.claude/CLAUDE.md`, Codex: `~/.codex/AGENTS.md`) şuna benzer kısa bir protokol bloğu ekle:

```markdown
# Ortak AI hafızası
`~/NotlarSync/notes/AI-Hafiza.md` tüm cihazlara ve AI'lara senkron ortak hafızadır.
- Oturum başında son ~30 satırını oku — önceki oturumlarda ne yapıldığını görürsün.
- Önemli her işten sonra sonuna tek satır log ekle:
  `- YYYY-MM-DD HH:MM [ajan-adi] yapılan işin bir cümlelik özeti`
- Hassas bilgi (şifre, token) YAZMA.
```

## 🕸️ Zihin Haritası

Uygulamanın "zihni": notlar arası `[[link]]` bağlantılarından otomatik oluşan
interaktif bir bilgi grafiği. Kenar çubuğundaki 🕸️ düğmesine bas — notların
düğüm, `[[link]]`ler kenar olarak çizilir. En çok bağlantılı notlar büyür
(god node), birbirine sıkı bağlı notlar öbeklere ayrılır (topluluk tespiti),
henüz yazılmamış `[[link]]` hedefleri kesikli "hayalet" düğüm olur. Bir not
eklenince/değişince harita **anında** kendini günceller. AI ajanlarının tuttuğu
`AI-Hafiza` notları varsayılan olarak haritada gizlidir; harita üstündeki 🧠
anahtarıyla dahil edebilirsin.

Notlarında bağlantı kurmak için Obsidian gibi `[[Not Adı]]` yaz — o nota giden
bir kenar oluşur. AI ajanları da not yazarken `[[link]]` kullanırsa harita
kendiliğinden zenginleşir.

**AI'lar için** — grafı ham dosya okumadan JSON olarak sorgula:

```bash
curl "http://HOST:7777/api/graph?key=PAROLA"          # tüm graf (dugum + kenar + obek)
curl "http://HOST:7777/api/graph?key=PAROLA&gizli=1"  # AI-Hafiza notlarını da dahil et
```

## 🔐 Şifre Kasası

Kenar çubuğundaki 🔐 düğmesi: ana parolayla açılan sıfır-bilgi şifre kasası.
Şifreleme/çözme tamamen cihazında yapılır (Web Crypto, PBKDF2 + AES-GCM) —
sunucu yalnızca şifreli blob'u saklar, **içini asla açamaz**. Tarayıcıdan CSV
import (Chrome/Bitwarden dışa aktarımı) ve güçlü parola üretici içerir.
Ana parolayı unutursan kurtarma yoktur; kasa açılamaz.

## 🧰 Kodlama Araçları ve 🤖 Local AI

- **🧰 Araçlar**: Base64/32, Hex, Morse, ROT13/Caesar/Vigenère, JWT çözücü,
  SHA özetleri + "sihirli çöz" (kodlamayı tahmin eder). Tamamen offline.
- **🤖 AI**: makinede [Ollama](https://ollama.com) kuruluysa EN→TR çeviri ve
  "AI'a sor" panelini açar. Model gömülü değildir; mevcut Ollama'n kullanılır,
  hiçbir veri internete çıkmaz. Ollama kurulu/açık değilse panel "AI yok/kapalı"
  hatası gösterir; uygulamanın geri kalanı etkilenmez.

## Tarayıcı eklentisi (web şifrelerini yakala)

`extension/` klasöründeki eklenti, web sitelerine girdiğin şifreleri Google gibi "kaydedeyim mi?" diye sorup kasaya ekler. **Sistem-geneli dinleme (keylogger) yoktur** — sadece tarayıcı formlarına takılır ve her zaman önce sana sorar.

Kurulum (Chrome/Edge/Brave):
1. `chrome://extensions` → sağ üstten **Geliştirici modu**'nu aç
2. **Paketlenmemiş öğe yükle** → `notlar-sync/extension` klasörünü seç
3. Eklenti simgesine tıkla → kasa adresini (`http://localhost:7777` veya host'un Tailscale adresi) ve parolanı gir

Bir siteye giriş yapınca "Kaydet?" banner'ı çıkar. Kabul edersen şifre, **uygulama açık ve kasa kilidi açıkken** onayınla kasaya eklenir. Yakalanan şifre yalnızca sunucunun RAM'inde geçici durur; diske/git'e asla yazılmaz.

## Tarayıcıdan kullanım

Electron şart değil — host çalışırken herhangi bir cihazdan `http://HOST_ADRESI:7777` açman yeterli. Sunucuyu tek başına çalıştırmak için: `npm run server`

## Lisans

[ISC](LICENSE)
