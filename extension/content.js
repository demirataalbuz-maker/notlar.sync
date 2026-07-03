// Notlar Sync icerik script'i.
// Bir login formu gonderilince (sifre alani + submit), kucuk bir banner gosterir:
// "Bu sifreyi Notlar Sync kasasina kaydet?" — kullanici onaylarsa arka plana yollar.
// Sessiz gonderim YOK: her zaman once kullaniciya sorar.
(function () {
  let lastCapture = null;

  function findCredential(form) {
    const pass = form.querySelector('input[type="password"]');
    if (!pass || !pass.value) return null;
    // sifreye en yakin metin/email/tel alani = kullanici adi
    const fields = [...form.querySelectorAll('input')];
    let user = '';
    const idx = fields.indexOf(pass);
    for (let i = idx - 1; i >= 0; i--) {
      const t = (fields[i].type || '').toLowerCase();
      if (['text', 'email', 'tel', ''].includes(t) && fields[i].value) { user = fields[i].value; break; }
    }
    if (!user) {
      const e = document.querySelector('input[type="email"]');
      if (e && e.value) user = e.value;
    }
    return { url: location.origin, username: user, password: pass.value };
  }

  // form submit'i yakala (capture asamasinda, sayfa yonlenmeden once)
  document.addEventListener('submit', (ev) => {
    try {
      const cred = findCredential(ev.target);
      if (cred) { lastCapture = cred; showBanner(cred); }
    } catch {}
  }, true);

  // bazi siteler submit yerine buton click + JS kullanir: son sifre alanini da yakala
  document.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button, input[type="submit"], [role="button"]');
    if (!btn) return;
    const form = btn.closest('form') || document;
    setTimeout(() => { try { const c = findCredential(form.querySelector ? form : document); } catch {} }, 0);
  }, true);

  function showBanner(cred) {
    if (document.getElementById('ntlr-banner')) return;
    const bar = document.createElement('div');
    bar.id = 'ntlr-banner';
    bar.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483647;background:#262626;color:#dadada;border:1px solid #7f6df2;border-radius:10px;padding:14px 16px;font-family:system-ui,sans-serif;font-size:14px;box-shadow:0 6px 24px rgba(0,0,0,.5);max-width:320px';
    const site = cred.url.replace(/^https?:\/\//, '');
    bar.innerHTML = '<div style="margin-bottom:10px">🔐 <b>' + site + '</b> şifresini Notlar Sync kasasına kaydet?</div>';
    const yes = document.createElement('button');
    yes.textContent = 'Kaydet';
    yes.style.cssText = 'background:#7f6df2;color:#fff;border:none;border-radius:6px;padding:7px 14px;cursor:pointer;font-weight:600;margin-right:8px';
    const no = document.createElement('button');
    no.textContent = 'Hayır';
    no.style.cssText = 'background:none;color:#999;border:1px solid #3f3f3f;border-radius:6px;padding:7px 12px;cursor:pointer';
    yes.onclick = () => { chrome.runtime.sendMessage({ type: 'save', cred }); bar.remove(); };
    no.onclick = () => bar.remove();
    bar.append(yes, no);
    document.body.appendChild(bar);
    setTimeout(() => bar.remove(), 15000);
  }
})();
