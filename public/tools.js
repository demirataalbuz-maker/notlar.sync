// Kodlama / sifre araclari — encode + decode, hepsi offline.
// CTF/red-team icin yaygin teknikler. window.TOOLS.run(name, 'enc'|'dec', text, opt)
(function () {
  const g = typeof window !== 'undefined' ? window : globalThis;
  const te = new TextEncoder(), td = new TextDecoder();

  // --- base32 (RFC4648) ---
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  function b32enc(str) {
    const b = te.encode(str); let bits = 0, val = 0, out = '';
    for (const x of b) { val = (val << 8) | x; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
    if (bits > 0) out += B32[(val << (5 - bits)) & 31];
    while (out.length % 8) out += '=';
    return out;
  }
  function b32dec(s) {
    s = s.replace(/=+$/, '').toUpperCase().replace(/[^A-Z2-7]/g, '');
    let bits = 0, val = 0; const out = [];
    for (const c of s) { val = (val << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
    return td.decode(new Uint8Array(out));
  }

  // --- morse ---
  const MORSE = { A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..', J: '.---', K: '-.-', L: '.-..', M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..', 0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-', 5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.', '.': '.-.-.-', ',': '--..--', '?': '..--..', "'": '.----.', '!': '-.-.--', '/': '-..-.', '(': '-.--.', ')': '-.--.-', '&': '.-...', ':': '---...', ';': '-.-.-.', '=': '-...-', '+': '.-.-.', '-': '-....-', '_': '..--.-', '"': '.-..-.', '$': '...-..-', '@': '.--.-.', ' ': '/' };
  const MORSE_R = Object.fromEntries(Object.entries(MORSE).map(([k, v]) => [v, k]));
  const morseEnc = (s) => s.toUpperCase().split('').map((c) => MORSE[c] ?? '').filter(Boolean).join(' ');
  const morseDec = (s) => s.trim().split(/\s+/).map((c) => c === '/' ? ' ' : (MORSE_R[c] ?? '')).join('');

  const caesar = (s, n) => s.replace(/[a-z]/gi, (c) => {
    const base = c <= 'Z' ? 65 : 97;
    return String.fromCharCode((c.charCodeAt(0) - base + (n % 26) + 26) % 26 + base);
  });
  const atbash = (s) => s.replace(/[a-z]/gi, (c) => {
    const base = c <= 'Z' ? 65 : 97;
    return String.fromCharCode(base + 25 - (c.charCodeAt(0) - base));
  });
  const rot47 = (s) => s.replace(/[!-~]/g, (c) => String.fromCharCode(33 + (c.charCodeAt(0) - 33 + 47) % 94));

  function vigenere(s, key, dir) {
    if (!key) return s; let ki = 0;
    return s.replace(/[a-z]/gi, (c) => {
      const base = c <= 'Z' ? 65 : 97;
      const k = key.toLowerCase().charCodeAt(ki % key.length) - 97; ki++;
      const shift = dir === 'dec' ? -k : k;
      return String.fromCharCode((c.charCodeAt(0) - base + shift + 26) % 26 + base);
    });
  }

  const htmlEnc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const htmlDec = (s) => s.replace(/&(#\d+|#x[0-9a-f]+|amp|lt|gt|quot|#39);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return { amp: '&', lt: '<', gt: '>', quot: '"' }[e.toLowerCase()] ?? m;
  });

  const b64enc = (s) => btoa(unescape(encodeURIComponent(s)));
  const b64dec = (s) => decodeURIComponent(escape(atob(s.replace(/\s/g, ''))));
  const hexToBytes = (h) => new Uint8Array((h.replace(/[^0-9a-f]/gi, '').match(/.{1,2}/g) || []).map((x) => parseInt(x, 16)));

  async function sha(algo, s) {
    const buf = await crypto.subtle.digest(algo, te.encode(s));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function jwtDecode(s) {
    const p = s.split('.');
    if (p.length < 2) throw new Error('JWT degil');
    const dec = (x) => JSON.stringify(JSON.parse(b64dec(x.replace(/-/g, '+').replace(/_/g, '/'))), null, 2);
    return 'HEADER:\n' + dec(p[0]) + '\n\nPAYLOAD:\n' + dec(p[1]);
  }

  // teknik tablosu: enc/dec fonksiyonlari (opt = ayar, ornegin caesar kaymasi)
  const T = {
    'Base64':      { enc: b64enc, dec: b64dec },
    'Base64 URL':  { enc: (s) => b64enc(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), dec: (s) => b64dec(s.replace(/-/g, '+').replace(/_/g, '/')) },
    'Base32':      { enc: b32enc, dec: b32dec },
    'Hex':         { enc: (s) => [...te.encode(s)].map((b) => b.toString(16).padStart(2, '0')).join(''), dec: (s) => td.decode(hexToBytes(s)) },
    'Binary':      { enc: (s) => [...te.encode(s)].map((b) => b.toString(2).padStart(8, '0')).join(' '), dec: (s) => td.decode(new Uint8Array((s.trim().split(/\s+/)).map((b) => parseInt(b, 2)))) },
    'Ondalık (ASCII)': { enc: (s) => [...te.encode(s)].join(' '), dec: (s) => td.decode(new Uint8Array(s.trim().split(/\s+/).map(Number))) },
    'URL':         { enc: encodeURIComponent, dec: decodeURIComponent },
    'HTML Entity': { enc: htmlEnc, dec: htmlDec },
    'ROT13':       { enc: (s) => caesar(s, 13), dec: (s) => caesar(s, 13) },
    'ROT47':       { enc: rot47, dec: rot47 },
    'Caesar (kaydır)': { enc: (s, o) => caesar(s, +o || 3), dec: (s, o) => caesar(s, -(+o || 3)), opt: 'kaydırma (ör. 3)' },
    'Atbash':      { enc: atbash, dec: atbash },
    'Vigenère':    { enc: (s, o) => vigenere(s, o || '', 'enc'), dec: (s, o) => vigenere(s, o || '', 'dec'), opt: 'anahtar kelime' },
    'Ters çevir':  { enc: (s) => [...s].reverse().join(''), dec: (s) => [...s].reverse().join('') },
    'Morse':       { enc: morseEnc, dec: morseDec },
    'JWT çöz':     { enc: null, dec: jwtDecode },
    'SHA-1':       { enc: (s) => sha('SHA-1', s), dec: null },
    'SHA-256':     { enc: (s) => sha('SHA-256', s), dec: null },
    'SHA-512':     { enc: (s) => sha('SHA-512', s), dec: null },
  };

  g.TOOLS = {
    names: Object.keys(T),
    optLabel: (name) => T[name] && T[name].opt,
    canEnc: (name) => !!(T[name] && T[name].enc),
    canDec: (name) => !!(T[name] && T[name].dec),
    async run(name, dir, text, opt) {
      const t = T[name]; if (!t) throw new Error('bilinmeyen teknik');
      const fn = dir === 'dec' ? t.dec : t.enc;
      if (!fn) throw new Error(dir === 'dec' ? 'bu teknik çözülemez (tek yönlü)' : 'bu teknik sadece çözer');
      return await fn(text, opt);
    },
    // "sihirli çöz": metni tüm çözücülerden geçir, okunabilir sonuçları göster
    async magic(text) {
      const out = [];
      for (const name of Object.keys(T)) {
        if (!T[name].dec) continue;
        try {
          const r = await T[name].dec(text, name === 'Caesar (kaydır)' ? 13 : '');
          if (r && r !== text && /[\x20-\x7e]/.test(r) && !/[\x00-\x08\x0e-\x1f]/.test(r))
            out.push({ name, r: r.slice(0, 200) });
        } catch {}
      }
      return out;
    },
  };
})();
