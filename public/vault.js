// Sifreli kasa — TÜM sifreleme/cozme burada, istemcide (Web Crypto).
// Sunucu sadece sifreli blob'u saklar, ana parolayi ve icerigi ASLA gormez.
// KDF: PBKDF2-SHA256 600k tur -> AES-256-GCM. Yanlis parola = GCM dogrulama patlar.
(function () {
  const g = typeof window !== 'undefined' ? window : globalThis;
  const te = new TextEncoder(), td = new TextDecoder();
  const ITER = 600000;

  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  async function deriveKey(password, salt, iter) {
    const base = await crypto.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    );
  }

  async function encrypt(entries, password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(password, salt, ITER);
    const pt = te.encode(JSON.stringify(entries));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, pt);
    return JSON.stringify({ v: 1, kdf: 'PBKDF2-SHA256', iter: ITER, salt: b64(salt), iv: b64(iv), ct: b64(ct) });
  }

  async function decrypt(blobStr, password) {
    const b = typeof blobStr === 'string' ? JSON.parse(blobStr) : blobStr;
    const key = await deriveKey(password, unb64(b.salt), b.iter || ITER);
    // yanlis parola burada 'OperationError' firlatir (GCM auth tag tutmaz)
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(b.iv) }, key, unb64(b.ct));
    return JSON.parse(td.decode(pt));
  }

  // CSV ice aktar (Chrome/Firefox/Bitwarden vb. disa aktarim). Baslik satirindan alan eslesir.
  function parseCSV(text) {
    const rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') q = false;
        else cell += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') { if (cell !== '' || row.length) { row.push(cell); rows.push(row); row = []; cell = ''; } if (c === '\r' && text[i + 1] === '\n') i++; }
      else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    if (!rows.length) return [];
    const head = rows[0].map((h) => h.toLowerCase().trim());
    const idx = (names) => head.findIndex((h) => names.includes(h));
    const iName = idx(['name', 'title', 'account']);
    const iUrl = idx(['url', 'website', 'login_uri', 'uri']);
    const iUser = idx(['username', 'user', 'login', 'email', 'login_username']);
    const iPass = idx(['password', 'pass', 'login_password']);
    const out = [];
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r]; if (!row.length || row.every((x) => !x)) continue;
      const pass = iPass >= 0 ? row[iPass] : '';
      if (!pass) continue;
      out.push({
        title: (iName >= 0 && row[iName]) || (iUrl >= 0 && row[iUrl]) || 'İsimsiz',
        url: iUrl >= 0 ? row[iUrl] || '' : '',
        username: iUser >= 0 ? row[iUser] || '' : '',
        password: pass, note: '',
      });
    }
    return out;
  }

  // guclu sifre uretici
  function genPassword(len = 20, opt = {}) {
    let set = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYЗ0123456789'.replace('З', '');
    if (opt.symbols !== false) set += '!@#$%^&*()-_=+[]{};:,.?';
    const rnd = crypto.getRandomValues(new Uint32Array(len));
    let out = '';
    for (let i = 0; i < len; i++) out += set[rnd[i] % set.length];
    return out;
  }

  g.VAULT = { encrypt, decrypt, parseCSV, genPassword, deriveKey };
})();
