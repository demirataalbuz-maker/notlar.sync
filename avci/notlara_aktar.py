# -*- coding: utf-8 -*-
"""AVCI -> NOTES kopru: Avci katalogunu (teknik/tool/silah/web + avlanan gercek
ornekler) notlar-sync notes/Avci/ altina .md not olarak yazar.

- Dosya adlari peer-sync'in safeNoteId/safePart kuraliyla NORMALIZE edilir
  (cift bosluk/NFC cokme bug'ini tetiklememek icin).
- Her not frontmatter'li: kategori (graph gruplamasi + zihni), id, owasp, atlas.
- Idempotent: her calismada Avci/ altini bastan yazar (eskiyi siler).
"""
import os, re, sys, json, shutil, unicodedata

AVCI_SRC = os.path.expanduser("~/ai-saldiri-avcisi")
NOTES = os.path.expanduser("~/NotlarSync/notes")
KOK = "Avcı"  # notes altindaki ust klasor
sys.path.insert(0, AVCI_SRC)

WINDOWS_RESERVED = re.compile(r'^(con|prn|aux|nul|com[1-9]|lpt[1-9])$', re.I)
KIRP = re.compile('[' + ''.join(chr(c) for c in range(0x20)) + '\x7f<>:"/\\\\|?*]')

def safe_part(value):
    """peer-sync safePart JS mantiginin bire bir portu."""
    if not isinstance(value, str):
        return ''
    clean = unicodedata.normalize('NFC', value)
    clean = KIRP.sub(' ', clean)
    clean = re.sub(r'\s+', ' ', clean).strip()
    clean = re.sub(r'[. ]+$', '', clean)[:120]
    if not clean or clean in ('.', '..') or clean.startswith('.') or WINDOWS_RESERVED.match(clean):
        return ''
    return clean

def load_json(name):
    try:
        with open(os.path.join(AVCI_SRC, name), encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}

def yaz(kategori, ad, meta, govde):
    """notes/Avci/<kategori>/<ad>.md yaz."""
    dosya_ad = safe_part(ad) or safe_part(str(meta.get("id", ""))) or "adsiz"
    klasor = os.path.join(NOTES, safe_part(KOK), safe_part(kategori))
    os.makedirs(klasor, exist_ok=True)
    yol = os.path.join(klasor, dosya_ad + ".md")
    fm = ["---"]
    for k, v in meta.items():
        if v:
            fm.append(f"{k}: {v}")
    fm.append("---")
    with open(yol, "w", encoding="utf-8") as f:
        f.write("\n".join(fm) + "\n\n" + govde.strip() + "\n")
    return yol

def ders_govde(ders):
    parts = []
    for baslik, metin in (ders or []):
        parts.append(f"### {baslik}\n{metin}")
    return "\n\n".join(parts)

def varyant_govde(varyantlar):
    if not varyantlar:
        return ""
    satir = [f"- **{ad}** — {ornek}" for ad, ornek in varyantlar]
    return "## Varyantlar / somut numaralar\n" + "\n".join(satir)

def ornek_govde(baslik, kayitlar):
    """avlanan/senaryo gercek ornekleri -> link listesi."""
    if not kayitlar:
        return ""
    satir = [f"## {baslik}"]
    for k in kayitlar:
        b = k.get("baslik") or k.get("url") or "kaynak"
        url = k.get("url", "")
        ek = k.get("ozet") or k.get("alinti") or ""
        ek = re.sub(r'\s+', ' ', ek).strip()
        if len(ek) > 240:
            ek = ek[:240] + "…"
        satir.append(f"- [{b}]({url})" + (f"\n  > {ek}" if ek else ""))
    return "\n".join(satir)

def main():
    import teknikler, araclar, silahlar, web_teknikler
    senaryolar = load_json("senaryolar.json")
    web_sen = load_json("web_senaryolar.json")
    silah_sen = load_json("silah_senaryolar.json")
    avlanan = load_json("avlanan.json").get("ornekler", {})

    kok_yol = os.path.join(NOTES, safe_part(KOK))
    if os.path.isdir(kok_yol):
        shutil.rmtree(kok_yol)

    sayac = {}

    def gercek_ornekler(tid):
        return (avlanan.get(tid, []) or []) + (senaryolar.get(tid, []) or [])

    for t in teknikler.TEKNIKLER:
        meta = {"kategori": "Avcı-Teknik", "id": t.get("id"), "owasp": t.get("owasp"),
                "atlas": t.get("atlas"), "aile": t.get("aile")}
        govde = f"**{t.get('en','')}**\n\n> {t.get('ozet','')}\n\n"
        govde += ders_govde(t.get("ders")) + "\n\n" + varyant_govde(t.get("varyantlar"))
        ge = ornek_govde("Avlanan gerçek örnekler", gercek_ornekler(t.get("id")))
        if ge:
            govde += "\n\n" + ge
        if t.get("av"):
            govde += "\n\n## Av sorguları\n" + "\n".join(f"- `{q}`" for q in t["av"])
        yaz("Teknikler", t.get("ad", t.get("id")), meta, govde)
        sayac["teknik"] = sayac.get("teknik", 0) + 1

    for a in araclar.ARACLAR:
        meta = {"kategori": "Avcı-Tool", "id": a.get("id"), "tur": a.get("tur")}
        govde = f"> {a.get('ne','')}\n\n**İlgili teknik:** {a.get('teknik','')}\n\n"
        if a.get("link"):
            govde += f"**Kaynak:** {a['link']}\n"
        yaz("Araçlar", a.get("ad", a.get("id")), meta, govde)
        sayac["tool"] = sayac.get("tool", 0) + 1

    web_list = [v for v in vars(web_teknikler).values() if isinstance(v, list) and v and isinstance(v[0], dict)][0]
    for w in web_list:
        meta = {"kategori": "Avcı-Web", "id": w.get("id"), "owasp": w.get("owasp"),
                "cwe": w.get("cwe"), "atlas": w.get("atlas"), "katman": w.get("katman")}
        govde = f"**{w.get('en','')}**\n\n> {w.get('ozet','')}\n\n"
        govde += ders_govde(w.get("ders")) + "\n\n" + varyant_govde(w.get("varyantlar"))
        ge = ornek_govde("Avlanan gerçek örnekler", web_sen.get(w.get("id"), []))
        if ge:
            govde += "\n\n" + ge
        yaz("Web-Pentest", w.get("ad", w.get("id")), meta, govde)
        sayac["web"] = sayac.get("web", 0) + 1

    for s in silahlar.SILAHLAR:
        meta = {"kategori": "Avcı-Silah", "id": s.get("id"), "tur": s.get("tur"), "fiyat": s.get("fiyat")}
        govde = f"> {s.get('ne','')}\n\n"
        if s.get("saldirilar"):
            govde += "## Neler yapılabilir\n" + "\n".join(f"- {x}" for x in s["saldirilar"]) + "\n\n"
        if s.get("diy"):
            govde += f"**Ucuz DIY klon:** {s['diy']}\n\n"
        if s.get("yasal"):
            govde += f"**Yasal not:** {s['yasal']}\n\n"
        ge = ornek_govde("Avlanan projeler", silah_sen.get(s.get("id"), []))
        if ge:
            govde += ge
        yaz("Silahlar", s.get("ad", s.get("id")), meta, govde)
        sayac["silah"] = sayac.get("silah", 0) + 1

    toplam = sum(sayac.values())
    print(f"AKTARILDI -> {kok_yol}")
    print(f"  teknik={sayac.get('teknik',0)} tool={sayac.get('tool',0)} "
          f"web={sayac.get('web',0)} silah={sayac.get('silah',0)}  TOPLAM={toplam}")

if __name__ == "__main__":
    main()
