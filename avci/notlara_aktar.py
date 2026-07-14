# -*- coding: utf-8 -*-
"""AVCI -> NOTES kopru (eski :7788 agac yapisini birebir yansitir).

notes/Avcı/ altina 3 mod koku, her biri eski sidebar agaci gibi ic ice:
  Avcı/AI Red Team/
     Teknikler/<NN · ATLAS taktigi>/<id · ad>.md      (TAKTIK_SIRA duzeninde)
     Araçlar/<tür>/<ad>.md
     Senaryolar/<id · ad>/<baslik>.md                 (motorun bulduklari, ayri)
  Avcı/AI-App Pentest/
     Teknikler/<NN · katman>/<ad>.md
     Senaryolar/<id · ad>/<baslik>.md
  Avcı/Silahlar/
     Gadgetlar/<ad>.md
     Senaryolar/<gadget>/<baslik>.md

Dosya/klasor adlari peer-sync safeNoteId kuraliyla normalize edilir.
Idempotent: her calismada Avcı/ altini bastan yazar.
"""
import os, re, sys, json, shutil, unicodedata

AVCI_SRC = os.path.expanduser("~/ai-saldiri-avcisi")
NOTES = os.path.expanduser("~/NotlarSync/notes")
KOK = "Avcı"
sys.path.insert(0, AVCI_SRC)

WINDOWS_RESERVED = re.compile(r'^(con|prn|aux|nul|com[1-9]|lpt[1-9])$', re.I)
KIRP = re.compile('[' + ''.join(chr(c) for c in range(0x20)) + '\x7f<>:"/\\\\|?*]')
WEB_SIRA = ['Girdi Yüzeyi', 'Çıktı & Render', 'Ajan & Yetki', 'Sır & Kimlik', 'Kaynak & Maliyet']

def safe_part(value):
    if not isinstance(value, str):
        value = str(value)
    clean = unicodedata.normalize('NFC', value)
    clean = KIRP.sub(' ', clean)
    clean = re.sub(r'\s+', ' ', clean).strip()
    clean = re.sub(r'[. ]+$', '', clean)[:120]
    clean = re.sub(r'[. ]+$', '', clean)
    if not clean or clean in ('.', '..') or clean.startswith('.') or WINDOWS_RESERVED.match(clean):
        return ''
    return clean

def load_json(name):
    try:
        with open(os.path.join(AVCI_SRC, name), encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}

def yaz(parts, meta, govde):
    """parts: Avcı altindaki klasor segmentleri + son eleman = dosya adi."""
    safe = [safe_part(p) for p in parts if safe_part(p)]
    if len(safe) < 2:
        return
    *dirs, ad = safe
    klasor = os.path.join(NOTES, *dirs)
    os.makedirs(klasor, exist_ok=True)
    yol = os.path.join(klasor, ad + ".md")
    n = 2
    while os.path.exists(yol):
        yol = os.path.join(klasor, f"{ad} ({n}).md"); n += 1
    fm = ["---"] + [f"{k}: {v}" for k, v in meta.items() if v] + ["---"]
    with open(yol, "w", encoding="utf-8") as f:
        f.write("\n".join(fm) + "\n\n" + govde.strip() + "\n")

def ders_govde(ders):
    return "\n\n".join(f"### {b}\n{m}" for b, m in (ders or []))

def varyant_govde(varyantlar):
    if not varyantlar:
        return ""
    return "## Varyantlar / somut numaralar\n" + "\n".join(f"- **{a}** — {o}" for a, o in varyantlar)

def senaryo_yaz(kok_parts, grup_ad, kayitlar, tid):
    """Bir teknigin/gadgetin senaryolarini ayri notlar olarak yazar.
    kok_parts: mod koku segment LISTESI (orn. [KOK, 'AI Red Team'])."""
    say = 0
    for s in (kayitlar or []):
        baslik = s.get("baslik") or s.get("url") or "senaryo"
        url = s.get("url", "")
        ek = re.sub(r'\s+', ' ', (s.get("ozet") or s.get("alinti") or "")).strip()
        skor = s.get("skor")
        tur = s.get("kaynak_turu")
        govde = f"**Kaynak:** {s.get('kaynak','')}"
        if isinstance(skor, (int, float)):
            rozet = "🟢" if skor >= 70 else ("🟡" if skor >= 45 else "🔴")
            govde += f"  ·  **Güven puanı:** {rozet} {skor}/100"
        if tur:
            govde += f"  ·  _{tur}_"
        govde += "\n\n"
        if url:
            govde += f"[{baslik}]({url})\n\n"
        if ek:
            govde += f"> {ek}\n"
        meta = {"kategori": "Avcı-Senaryo", "teknik": tid, "kaynak": s.get("kaynak"), "url": url}
        if isinstance(skor, (int, float)):
            meta["skor"] = skor
        if tur:
            meta["kaynak_turu"] = tur
        yaz(list(kok_parts) + ["Senaryolar", grup_ad, baslik], meta, govde)
        say += 1
    return say

def main():
    import teknikler, araclar, silahlar, web_teknikler
    senaryolar = load_json("senaryolar.json")
    web_sen = load_json("web_senaryolar.json")
    silah_sen = load_json("silah_senaryolar.json")
    avlanan = load_json("avlanan.json").get("ornekler", {})
    taktik_sira = getattr(teknikler, "TAKTIK_SIRA", [])

    kok_yol = os.path.join(NOTES, safe_part(KOK))
    if os.path.isdir(kok_yol):
        shutil.rmtree(kok_yol)

    say = {"teknik": 0, "tool": 0, "web": 0, "silah": 0, "senaryo": 0}

    def aile_klasor(aile, sira):
        i = sira.index(aile) if aile in sira else 98
        return f"{i+1:02d} · {aile}"

    def gercek(tid):
        return (avlanan.get(tid, []) or []) + (senaryolar.get(tid, []) or [])

    # ── AI Red Team ──
    KOK_AI = [KOK, "AI Red Team"]
    for t in teknikler.TEKNIKLER:
        meta = {"kategori": "Avcı-Teknik", "id": t.get("id"), "owasp": t.get("owasp"),
                "atlas": t.get("atlas"), "aile": t.get("aile")}
        g = f"**{t.get('en','')}**\n\n> {t.get('ozet','')}\n\n" + ders_govde(t.get("ders")) + "\n\n" + varyant_govde(t.get("varyantlar"))
        if t.get("av"):
            g += "\n\n## Av sorguları\n" + "\n".join(f"- `{q}`" for q in t["av"])
        yaz(KOK_AI + ["Teknikler", aile_klasor(t.get("aile", ""), taktik_sira), f"{t['id']} · {t.get('ad','')}"], meta, g)
        say["teknik"] += 1
        say["senaryo"] += senaryo_yaz(KOK_AI, f"{t['id']} · {t.get('ad','')}", gercek(t["id"]), t["id"])

    for a in araclar.ARACLAR:
        grup = a.get("tur", "Genel").split("(")[0].split("+")[0].strip() or "Genel"
        g = f"> {a.get('ne','')}\n\n**İlgili teknik:** {a.get('teknik','')}\n\n"
        if a.get("link"):
            g += f"**Kaynak:** {a['link']}\n"
        yaz(KOK_AI + ["Araçlar", grup, a.get("ad", a.get("id"))],
            {"kategori": "Avcı-Tool", "id": a.get("id"), "tur": a.get("tur")}, g)
        say["tool"] += 1

    # ── AI-App Pentest ──
    KOK_WEB = [KOK, "AI-App Pentest"]
    web_list = [v for v in vars(web_teknikler).values() if isinstance(v, list) and v and isinstance(v[0], dict)][0]
    for w in web_list:
        katman = w.get("aile") or w.get("katman") or "Genel"
        i = WEB_SIRA.index(katman) if katman in WEB_SIRA else 98
        meta = {"kategori": "Avcı-Web", "id": w.get("id"), "owasp": w.get("owasp"),
                "cwe": w.get("cwe"), "atlas": w.get("atlas"), "katman": katman}
        g = f"**{w.get('en','')}**\n\n> {w.get('ozet','')}\n\n" + ders_govde(w.get("ders")) + "\n\n" + varyant_govde(w.get("varyantlar"))
        yaz(KOK_WEB + ["Teknikler", f"{i+1:02d} · {katman}", w.get("ad", w.get("id"))], meta, g)
        say["web"] += 1
        say["senaryo"] += senaryo_yaz(KOK_WEB, f"{w['id']} · {w.get('ad','')}", web_sen.get(w["id"], []), w["id"])

    # ── Silahlar ──
    KOK_SILAH = [KOK, "Silahlar"]
    for s in silahlar.SILAHLAR:
        g = f"> {s.get('ne','')}\n\n"
        if s.get("saldirilar"):
            g += "## Neler yapılabilir\n" + "\n".join(f"- {x}" for x in s["saldirilar"]) + "\n\n"
        if s.get("diy"):
            g += f"**Ucuz DIY klon:** {s['diy']}\n\n"
        if s.get("yasal"):
            g += f"**Yasal not:** {s['yasal']}\n"
        yaz(KOK_SILAH + ["Gadgetlar", s.get("ad", s.get("id"))],
            {"kategori": "Avcı-Silah", "id": s.get("id"), "tur": s.get("tur"), "fiyat": s.get("fiyat")}, g)
        say["silah"] += 1
        say["senaryo"] += senaryo_yaz(KOK_SILAH, s.get("ad", s.get("id")), silah_sen.get(s["id"], []), s["id"])

    toplam = sum(v for k, v in say.items())
    print(f"AKTARILDI -> {kok_yol}")
    print(f"  teknik={say['teknik']} tool={say['tool']} web={say['web']} "
          f"silah={say['silah']} senaryo={say['senaryo']}  TOPLAM={toplam}")

if __name__ == "__main__":
    main()
