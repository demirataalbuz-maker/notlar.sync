// Tek kullanimlik eslestirme + cihaz token'lari.
// Felsefe: kalici parola ASLA cihazdan cihaza tasinmaz. Onun yerine:
//   1) Ana cihaz 6 haneli, 3 dk gecerli TEK KULLANIMLIK kod uretir (parola YOK)
//   2) Yeni cihaz kodu girer -> iki cihaza da "X baglanmak istiyor" bildirimi
//   3) HER IKI taraf da onaylar (host bilir, yeni cihaz kodu bilir)
//   4) Sunucu yeni cihaza OZEL bir token uretir, kodu imha eder
//   5) O cihaz bundan sonra token'iyla baglanir; token tek tek IPTAL edilebilir
// Boylece parola sizmaz, her cihaz adiyla gorunur, biri kaybolursa yalniz o atilir.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KOD_SURESI = 3 * 60 * 1000; // kod 3 dk sonra oluru
const rnd = (n) => crypto.randomBytes(n).toString('hex');
const guvenliEsit = (a, b) => {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
};
const cihazId = (token) => 'device_' + crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);

// --- kalici cihaz kayitlari: devices.json (token'lar = kimlik, git'e girmez) ---
function cihazDosya(dataDir) { return path.join(dataDir, 'devices.json'); }

function cihazlariOku(dataDir) {
  try {
    const list = JSON.parse(fs.readFileSync(cihazDosya(dataDir), 'utf8'));
    return (Array.isArray(list) ? list : []).filter((c) => c && c.token).map((c) => ({
      ...c,
      id: c.id || cihazId(c.token),
    }));
  }
  catch { return []; }
}
function cihazlariYaz(dataDir, list) {
  const fp = cihazDosya(dataDir);
  const tmp = fp + '.tmp-' + process.pid + '-' + rnd(3);
  fs.writeFileSync(tmp, JSON.stringify(list, null, 1), { mode: 0o600 });
  try {
    fs.renameSync(tmp, fp);
  } catch (e) {
    try { fs.unlinkSync(fp); } catch {}
    fs.renameSync(tmp, fp);
  }
  try { fs.chmodSync(fp, 0o600); } catch {}
}

// bir token gecerli bir cihaza mi ait? (auth bu tokeni parolaya ES kabul eder)
function cihazBul(dataDir, token) {
  if (!token) return null;
  return cihazlariOku(dataDir).find((c) => guvenliEsit(c.token, token)) || null;
}
function tokenGecerli(dataDir, token) {
  return !!cihazBul(dataDir, token);
}

// token'in "son gorulme"sini tazele (cihaz listesinde kimin aktif oldugu belli olsun)
function tokenGoruldu(dataDir, token, simdi) {
  const list = cihazlariOku(dataDir);
  const c = list.find((x) => guvenliEsit(x.token, token));
  if (c && c.sonGorulme !== simdi) { c.sonGorulme = simdi; cihazlariYaz(dataDir, list); }
}

// UI ve API ham bearer token'i hic gormez; iptal islemi guvenli cihaz kimligiyle yapilir.
function cihazlariPublic(dataDir) {
  return cihazlariOku(dataDir).map(({ token, ...c }) => c);
}

function cihazSil(dataDir, id) {
  const list = cihazlariOku(dataDir);
  // Eski istemciler icin token kabul edilir, fakat liste ucundan artik token donmez.
  const kalan = list.filter((c) => c.id !== id && !guvenliEsit(c.token, id));
  if (kalan.length !== list.length) { cihazlariYaz(dataDir, kalan); return true; }
  return false;
}

// --- eslestirme oturumlari: SADECE RAM (kisa omurlu, diske yazilmaz) ---
// kod -> { kod, olusma, claimId, cihazAdi, hostOnay, cihazOnay, token, bitti }
const oturumlar = new Map();

function suresiGecmisleriTemizle(simdi) {
  for (const [kod, o] of oturumlar)
    if (simdi - o.olusma > KOD_SURESI) oturumlar.delete(kod);
}

// 1) ana cihaz kod uretir (authed cagirir). 6 hane, tahmini zor degil ama
//    3 dk + tek kullanim + cift onay oldugu icin kaba kuvvet penceresi cok dar.
function kodUret(simdiMs) {
  suresiGecmisleriTemizle(simdiMs);
  let kod;
  do { kod = String(crypto.randomInt(0, 1e6)).padStart(6, '0'); } while (oturumlar.has(kod));
  oturumlar.set(kod, {
    kod, olusma: simdiMs, claimId: null, cihazAdi: null,
    hostOnay: false, cihazOnay: false, token: null, bitti: false,
  });
  return kod;
}

// 2) yeni cihaz kodu girer (auth YOK - henuz kimligi yok). Oturuma sahiplenir,
//    host tarafina "biri baglanmak istiyor" diye haber verilmesi cagirana kalir.
function talep(kod, cihazAdi, simdiMs) {
  suresiGecmisleriTemizle(simdiMs);
  const o = oturumlar.get(String(kod || '').trim());
  if (!o) return { hata: 'kod gecersiz ya da suresi gecmis' };
  if (o.claimId) return { hata: 'bu kod zaten baska cihaz tarafindan kullanildi' };
  o.claimId = rnd(16);
  o.cihazAdi = String(cihazAdi || 'isimsiz cihaz').slice(0, 40);
  return { claimId: o.claimId, cihazAdi: o.cihazAdi };
}

// 3) onay. taraf='host' (authed, zaten bagli cihaz) ya da 'cihaz' (claimId ile
//    kanitli yeni cihaz). Iki taraf da onaylayinca token uretilir, kod imha.
//    zamanEt = okunabilir zaman damgasi (cihaz listesinde gosterilir).
function onayla(kod, taraf, claimId, dataDir, zamanEt) {
  const o = oturumlar.get(String(kod || '').trim());
  if (!o || !o.claimId) return { hata: 'eslestirme bulunamadi' };
  if (taraf === 'host') o.hostOnay = true;
  else if (taraf === 'cihaz') {
    if (claimId !== o.claimId) return { hata: 'yetkisiz (claimId uyusmuyor)' };
    o.cihazOnay = true;
  } else return { hata: 'gecersiz taraf' };

  if (o.hostOnay && o.cihazOnay && !o.token) {
    o.token = 'dev_' + rnd(24);
    const list = cihazlariOku(dataDir);
    list.push({ id: cihazId(o.token), token: o.token, ad: o.cihazAdi, eklendi: zamanEt, sonGorulme: zamanEt });
    cihazlariYaz(dataDir, list);
    o.bitti = true;
  }
  return { hostOnay: o.hostOnay, cihazOnay: o.cihazOnay, bitti: o.bitti };
}

// 4) yeni cihaz durumu yoklar (claimId ile). Token hazirsa BIR KEZ verir ve
//    oturumu siler (kod imha) - token bir daha agdan gecmez.
function durum(kod, claimId, simdiMs) {
  suresiGecmisleriTemizle(simdiMs);
  const o = oturumlar.get(String(kod || '').trim());
  if (!o) return { durum: 'yok' };
  if (o.claimId && claimId !== o.claimId) return { hata: 'yetkisiz' };
  if (o.bitti && o.token) {
    const token = o.token;
    oturumlar.delete(o.kod); // kod imha: token teslim edildi
    return { durum: 'onaylandi', token };
  }
  return {
    durum: 'bekliyor',
    cihazAdi: o.cihazAdi,
    hostOnay: o.hostOnay, cihazOnay: o.cihazOnay,
  };
}

// host bir talebi reddeder: oturum tamamen dusulur (kod da olur)
function reddet(kod) {
  return oturumlar.delete(String(kod || '').trim());
}

// host tarafinin gosterecegi bekleyen talepler (authed uc)
function bekleyenTalepler() {
  const out = [];
  for (const o of oturumlar.values())
    if (o.claimId && !o.bitti)
      out.push({ kod: o.kod, cihazAdi: o.cihazAdi, hostOnay: o.hostOnay, cihazOnay: o.cihazOnay });
  return out;
}

module.exports = {
  KOD_SURESI, cihazlariOku, cihazlariPublic, cihazBul, tokenGecerli, tokenGoruldu, cihazSil,
  kodUret, talep, onayla, durum, reddet, bekleyenTalepler,
};
