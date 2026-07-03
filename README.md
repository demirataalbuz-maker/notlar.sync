# 🗒️ Notlar Sync

İki (veya daha fazla) bilgisayar arasında **anlık senkron** çalışan, Obsidian görünümlü masaüstü not uygulaması. Bir PC'de yazdığın her harf, aynı notu açık tutan diğer PC'de anında belirir.

- Electron masaüstü uygulaması, koyu tema
- Notlar düz `.md` dosyası olarak saklanır (`notes/` klasörü)
- WebSocket ile canlı senkron, kopunca otomatik yeniden bağlanır
- Parola korumalı

## Kurulum

```bash
git clone <repo-url> && cd notlar-sync
npm install
cp app-config.example.json app-config.json   # parolayı değiştir!
npm start
```

## İki PC'yi bağlama

Bir PC **host** olur (sunucu onun içinde çalışır), diğerleri **client** olarak bağlanır.

**Host PC** — `app-config.json`:
```json
{ "mode": "host", "password": "guclu-bir-parola" }
```

**Client PC** — `app-config.json`:
```json
{ "mode": "client", "server": "http://HOST_ADRESI:7777" }
```

Client ilk açılışta ekranda parola sorar; host'taki parolayı gir.

## Farklı ağlardan erişim

En kolay ve güvenli yol [Tailscale](https://tailscale.com): iki PC'ye de kur, aynı hesapla gir, client config'inde host'un Tailscale IP'sini (`100.x.x.x`) kullan. Port açmak, internete servis ifşa etmek yok; trafik uçtan uca şifreli.

> ⚠️ Sunucuyu doğrudan internete (port yönlendirme vs.) açmayın: trafik TLS'siz, parola tek koruma katmanı. Tailscale/VPN kullanın.

## Tarayıcıdan kullanım

Electron şart değil — host çalışırken herhangi bir cihazdan `http://HOST_ADRESI:7777` açman yeterli. Sunucuyu tek başına çalıştırmak için: `npm run server`
