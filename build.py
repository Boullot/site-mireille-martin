#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Générateur du site de Mireille Martin.

    python3 -m venv .venv && .venv/bin/pip install -r requirements-build.txt
    .venv/bin/python build.py

Tout le contenu vit dans content/ et assets/originals/.
Le site complet est écrit dans dist/, prêt à être déposé sur Vercel.
"""

import html
import json
import os
import re
import shutil
import unicodedata
from datetime import date

from PIL import Image, ImageOps, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.abspath(__file__))
CONTENT = os.path.join(ROOT, "content")
ASSETS = os.path.join(ROOT, "assets")
ORIGINALS = os.path.join(ASSETS, "originals")
DIST = os.path.join(ROOT, "dist")
IMGDIR = os.path.join(DIST, "img")

WIDTHS = [420, 840, 1400, 2000]
TODAY = date.today()

# ============================================================== utilitaires


def load(name):
    with open(os.path.join(CONTENT, name), encoding="utf-8") as f:
        return json.load(f)


def text(name):
    with open(os.path.join(CONTENT, "texts", name), encoding="utf-8") as f:
        return f.read()


def e(s):
    return html.escape(str(s), quote=True)


def slugify(s):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


SITE = load("site.json")
WORKS = load("works.json")["works"]
VIEWS = load("views.json")["views"]
EXPOS = load("exhibitions.json")
GOLD = load("livre-dor.json")

BASE = SITE["domain"].rstrip("/")

SERIES = {
    "aller-retour": {
        "title": "Aller Retour",
        "lede": "Le cœur de l'œuvre. Une variation construite à partir de deux carrés, "
                "un noir et un blanc, reprise trente-quatre fois sans jamais se répéter.",
        "medium": "Acrylique sur toile",
    },
    "peintures": {
        "title": "Peintures",
        "lede": "Autour de la série principale : les petits formats, les six Équinoxes, "
                "les triangles, et les toiles où le rouge fait son entrée.",
        "medium": "Acrylique sur toile",
    },
    "carregraphies": {
        "title": "Carrégraphies",
        "lede": "Onze idéogrammes chinois ramenés à l'orthogonale, posés au centre d'une "
                "trame. La calligraphie passée au tamis de la géométrie.",
        "medium": "Acrylique sur toile",
    },
    "encres": {
        "title": "Encres de Chine",
        "lede": "Quatre projets menés au pinceau et à l'encre sur papier : les kakémonos "
                "de « Géométrie d'encre et de papier », les doubles, les mots, l'ombre et la lumière.",
        "medium": "Encre de Chine sur papier",
    },
}

GROUP_ORDER = [
    "Aller Retour",
    "2111", "Équinoxe", "Grands carrés", "Lignes", "Triangles aux carrés", "Sans titre",
    "Carrégraphies",
    "Géométrie d'encre et de papier", "Aller Retour Double", "Les mots entre les lignes",
    "Ombre et lumière",
]

GROUP_NOTES = {
    "2111": "Quatre toiles où l'ocre traverse le noir et le blanc.",
    "Équinoxe": "Six formats verticaux 20 × 40, où l'équilibre bascule d'un côté puis de l'autre.",
    "Grands carrés": "Deux toiles de 80 × 80.",
    "Lignes": "Petits formats : la ligne comme seul sujet.",
    "Triangles aux carrés": "La diagonale prend le pas sur l'angle droit.",
    "Sans titre": "Toiles récentes et peintures de la série principale restées sans titre.",
    "Géométrie d'encre et de papier": "Kakémonos, encre de Chine sur papier xuan, 35 × 137 cm.",
    "Aller Retour Double": "Huit encres de petit format, 17,5 × 22 cm.",
    "Les mots entre les lignes": "Huit idéogrammes, encre de Chine sur papier, 30 × 30 cm.",
    "Ombre et lumière": "Projet en cours.",
}

TALL_GROUPS = {"Géométrie d'encre et de papier"}

NAV = [
    ("/oeuvres/", "Œuvres"),
    ("/demarche/", "Démarche"),
    ("/expositions/", "Expositions"),
    ("/livre-dor/", "Livre d'or"),
    ("/contact/", "Contact"),
]

# =============================================================== images

_meta_cache = {}


def process(rel_src, base_name, subdir=""):
    """Produit les dérivés webp + un JPEG de repli. Renvoie (srcset, fallback, w, h)."""
    key = (rel_src, base_name)
    if key in _meta_cache:
        return _meta_cache[key]

    src = os.path.join(ORIGINALS, rel_src)
    im = ImageOps.exif_transpose(Image.open(src)).convert("RGB")
    ow, oh = im.size
    outdir = os.path.join(IMGDIR, subdir) if subdir else IMGDIR
    os.makedirs(outdir, exist_ok=True)

    parts = []
    for w in WIDTHS:
        if w > ow and parts:
            break
        tw = min(w, ow)
        th = round(oh * tw / ow)
        name = f"{base_name}-{tw}.webp"
        path = os.path.join(outdir, name)
        if not os.path.exists(path):
            im.resize((tw, th), Image.LANCZOS).save(path, "WEBP", quality=84, method=5)
        url = f"/img/{subdir + '/' if subdir else ''}{name}"
        parts.append(f"{url} {tw}w")

    fw = min(1000, ow)
    fb = f"{base_name}-{fw}.jpg"
    fbpath = os.path.join(outdir, fb)
    if not os.path.exists(fbpath):
        im.resize((fw, round(oh * fw / ow)), Image.LANCZOS).save(
            fbpath, "JPEG", quality=82, optimize=True, progressive=True)

    res = (", ".join(parts), f"/img/{subdir + '/' if subdir else ''}{fb}", ow, oh)
    _meta_cache[key] = res
    return res


def og_image(rel_src, base_name):
    """Carte Open Graph 1200×630 : l'œuvre centrée sur le papier, signée."""
    out = os.path.join(IMGDIR, "og", f"{base_name}.jpg")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    if os.path.exists(out):
        return f"/img/og/{base_name}.jpg"

    canvas = Image.new("RGB", (1200, 630), (245, 242, 234))
    im = ImageOps.exif_transpose(Image.open(os.path.join(ORIGINALS, rel_src))).convert("RGB")
    im.thumbnail((760, 470), Image.LANCZOS)
    canvas.paste(im, ((1200 - im.width) // 2, (630 - im.height) // 2 - 18))

    d = ImageDraw.Draw(canvas)
    try:
        f = ImageFont.truetype("/System/Library/Fonts/Supplemental/Optima.ttc", 26)
    except OSError:
        f = ImageFont.load_default()
    d.text((600, 580), "MIREILLE MARTIN", fill=(60, 56, 50), font=f, anchor="mm")
    d.line([(490, 552), (710, 552)], fill=(201, 53, 31), width=2)
    canvas.save(out, "JPEG", quality=86, optimize=True)
    return f"/img/og/{base_name}.jpg"


def picture(rel_src, base_name, alt, cls="", sizes="100vw", subdir="", eager=False, ratio=True):
    srcset, fb, w, h = process(rel_src, base_name, subdir)
    loading = "eager" if eager else "lazy"
    prio = ' fetchpriority="high"' if eager else ""
    dims = f' width="{w}" height="{h}"' if ratio else ""
    return (
        f'<picture><source type="image/webp" srcset="{srcset}" sizes="{e(sizes)}">'
        f'<img src="{fb}" alt="{e(alt)}"{dims} loading="{loading}" decoding="async"{prio}'
        f'{f" class={chr(34)}{cls}{chr(34)}" if cls else ""}></picture>'
    )


# =============================================================== markdown light


def md(src):
    out, buf, mode = [], [], None

    def flush():
        nonlocal buf, mode
        if not buf:
            return
        joined = " ".join(x.strip() for x in buf).strip()
        if mode == "quote":
            out.append(f"<blockquote><p>{inline(joined)}</p></blockquote>")
        elif joined.startswith("—"):
            out.append(f'<p class="signature">{inline(joined)}</p>')
        else:
            out.append(f"<p>{inline(joined)}</p>")
        buf, mode = [], None

    for line in src.splitlines():
        s = line.rstrip()
        if not s.strip():
            flush()
            continue
        if s.startswith("## "):
            flush()
            out.append(f"<h2>{inline(s[3:])}</h2>")
        elif s.startswith("# "):
            flush()
        elif s.startswith("> "):
            if mode != "quote":
                flush()
                mode = "quote"
            buf.append(s[2:])
        else:
            if mode == "quote":
                flush()
            buf.append(s)
    flush()
    return "\n".join(out)


def inline(s):
    s = html.escape(s, quote=False)
    s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
    return s


# =============================================================== gabarit


def page(path, title, description, body, og=None, extra_head="", nav_key=None,
         jsonld=None, cls=""):
    url = BASE + path
    og = og or f"{BASE}/img/og/accueil.jpg"
    nav = "".join(
        f'<a href="{href}"{" aria-current=\"page\"" if href == nav_key else ""}>{label}</a>'
        for href, label in NAV
    )
    ld = ""
    if jsonld:
        for block in (jsonld if isinstance(jsonld, list) else [jsonld]):
            ld += ('<script type="application/ld+json">'
                   + json.dumps(block, ensure_ascii=False, separators=(",", ":"))
                   + "</script>")

    doc = f"""<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{e(title)}</title>
<meta name="description" content="{e(description)}">
<link rel="canonical" href="{e(url)}">
<meta name="theme-color" content="#f5f2ea" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#131210" media="(prefers-color-scheme: dark)">
<meta property="og:type" content="website">
<meta property="og:locale" content="fr_FR">
<meta property="og:site_name" content="Mireille Martin">
<meta property="og:title" content="{e(title)}">
<meta property="og:description" content="{e(description)}">
<meta property="og:url" content="{e(url)}">
<meta property="og:image" content="{e(BASE + og)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<link rel="stylesheet" href="/styles.css">
<script>
(function(){{try{{var t=localStorage.getItem('mm-theme');if(t)document.documentElement.setAttribute('data-theme',t);}}catch(e){{}}}})();
</script>
{extra_head}{ld}
</head>
<body{f' class="{cls}"' if cls else ''}>
<a class="skip" href="#main">Aller au contenu</a>
<header class="masthead">
  <div class="wrap masthead__inner">
    <a class="wordmark" href="/"><b>Mireille</b> <span>Martin</span></a>
    <nav class="nav" id="nav" aria-label="Navigation principale">{nav}</nav>
    <div class="masthead__tools">
      <button class="theme-toggle" id="theme" type="button" aria-label="Changer de thème">
        <svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
        <svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2.4M12 19.6V22M2 12h2.4M19.6 12H22M4.9 4.9l1.7 1.7M17.4 17.4l1.7 1.7M19.1 4.9l-1.7 1.7M6.6 17.4l-1.7 1.7"/></svg>
      </button>
      <button class="nav-toggle" id="navtoggle" type="button" aria-expanded="false" aria-controls="nav" aria-label="Ouvrir le menu">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18"/></svg>
      </button>
    </div>
  </div>
</header>
<main id="main">
{body}
</main>
<footer class="foot">
  <div class="wrap">
    <div class="foot__grid">
      <div>
        <h4>Mireille Martin</h4>
        <p>Peintre, abstraction géométrique.<br>Rouen, Normandie.</p>
      </div>
      <div>
        <h4>Le site</h4>
        <ul>{"".join(f'<li><a href="{h}">{l}</a></li>' for h, l in NAV)}<li><a href="/en/">English</a></li></ul>
      </div>
      <div>
        <h4>Ailleurs</h4>
        <ul>
          <li><a href="{e(SITE['instagram_url'])}" rel="me noopener" target="_blank">Instagram</a></li>
          <li><a href="http://cac-normandie.org/martin.html" rel="noopener" target="_blank">CAC-Normandie</a></li>
          <li><a href="https://realitesnouvelles.org/" rel="noopener" target="_blank">Réalités Nouvelles</a></li>
        </ul>
      </div>
      <div>
        <h4>Écrire</h4>
        <ul><li><a href="mailto:{e(SITE['email'])}">{e(SITE['email'])}</a></li></ul>
      </div>
    </div>
    <div class="foot__bottom">
      <span>© {TODAY.year} Mireille Martin — tous droits réservés.</span>
      <span>Photographies des œuvres : {e(SITE['credits_photo'])} · <a href="/mentions-legales/">Mentions légales</a></span>
    </div>
  </div>
</footer>
<script src="/app.js" defer></script>
</body>
</html>
"""
    out = os.path.join(DIST, path.strip("/"), "index.html") if path != "/" else os.path.join(DIST, "index.html")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        f.write(doc)
    return url


# =============================================================== fragments


def dims_str(w):
    return " · ".join(f"{d} cm" for d in w["dimensions"]) if w["dimensions"] else ""


def dims_short(w):
    """Sur les vignettes : un seul format, le reste compté. Évite les légendes sur trois lignes."""
    d = w["dimensions"]
    if not d:
        return ""
    if len(d) == 1:
        return f"{d[0]} cm"
    return f"{d[0]} cm  +{len(d) - 1} format{'s' if len(d) > 2 else ''}"


def plate(w, sizes="(min-width:1200px) 300px, (min-width:700px) 33vw, 50vw", eager=False):
    ideo = f'<span class="ideo">{e(w["note"])}</span>' if w.get("note") else ""
    meta = dims_short(w) or w["technique"]
    img = picture(w["file"], w["slug"], f'{w["title"]}, {w["technique"]}', sizes=sizes, eager=eager)
    # l'intertitre du groupe porte déjà le nom du projet : la vignette peut être brève
    label = w.get("short") or w["title"]
    return f"""<article class="plate" data-series="{e(w['series'])}">
  <a href="/oeuvres/{e(w['slug'])}/">
    <div class="plate__frame">{img}</div>
    <div class="plate__caption">
      <span class="plate__title">{e(label)}{ideo}</span>
      <span class="plate__meta">{e(meta)}</span>
    </div>
  </a>
</article>"""


def groups_of(series_key):
    out = []
    for g in GROUP_ORDER:
        items = [w for w in WORKS if w["series"] == series_key and w["group"] == g]
        if items:
            out.append((g, items))
    return out


def render_group(g, items, show_head=True):
    tall = " plates--tall" if g in TALL_GROUPS else ""
    head = ""
    if show_head:
        note = GROUP_NOTES.get(g, "")
        head = f"""<div class="group__head">
      <h3>{e(g)}</h3>
      {f'<p class="label">{e(note)}</p>' if note else ''}
    </div>"""
    plates = "\n".join(plate(w) for w in items)
    return f'<div class="group" id="{slugify(g)}">{head}<div class="plates{tall}">{plates}</div></div>'


# =============================================================== pages


def build_home():
    hero_work = next(w for w in WORKS if w["slug"] == "sans-titre-01")
    og_image(hero_work["file"], "accueil")

    picks = ["aller-retour-i", "aller-retour-xi", "carregraphie-harmonie",
             "geometrie-encre-papier-3", "equinoxe-iii", "2111-xix",
             "vice-et-versa", "mots-entre-les-lignes-liberte"]
    selection = [w for s in picks for w in WORKS if w["slug"] == s]

    last = sorted(EXPOS["exhibitions"], key=lambda x: x["sort"], reverse=True)
    upcoming = [x for x in EXPOS["upcoming"]] or []
    if upcoming:
        agenda_title = "Prochainement"
        agenda_items = upcoming[:3]
    else:
        agenda_title = "Dernières expositions"
        agenda_items = last[:3]

    agenda = "".join(
        f"""<div class="tl-item" data-solo="{str(x.get('solo', False)).lower()}">
          {'<span class="tag">Exposition personnelle</span>' if x.get('solo') else ''}
          <strong>{e(x['title'])}</strong>
          <span>{e(x['when'])}{' — ' + e(x['venue']) if x.get('venue') else ''}{', ' + e(x['city']) if x.get('city') else ''}</span>
        </div>""" for x in agenda_items)

    n_expos = len(EXPOS["exhibitions"])
    n_solo = len([x for x in EXPOS["exhibitions"] if x.get("solo")])
    memberships = "".join(
        f'<li><a href="{e(m["url"])}" rel="noopener" target="_blank">{e(m["label"])}</a></li>'
        for m in SITE["memberships"])

    body = f"""
<div class="wrap">
  <section class="hero">
    <div>
      <p class="label">Peintre · Abstraction géométrique · Normandie</p>
      <h1 class="hero__title">Autant de noir<em>que de blanc.</em></h1>
      <p class="hero__quote">« La géométrie a toujours été pour moi source de poésie
        et prétexte à m'évader. »</p>
      <div class="btn-row">
        <a class="btn" href="/oeuvres/">Voir les œuvres</a>
        <a class="btn btn--ghost" href="/contact/">Acquérir une œuvre</a>
      </div>
    </div>
    <figure class="hero__figure" style="margin:0">
      {picture(hero_work['file'], hero_work['slug'], 'Peinture de Mireille Martin, acrylique sur toile, noir et blanc', sizes='(min-width:900px) 46vw, 92vw', eager=True)}
    </figure>
  </section>
</div>

<section>
  <div class="wrap">
    <div class="section-head">
      <h2>La règle</h2>
      <a class="link-arrow" href="/demarche/">La démarche →</a>
    </div>
    <div class="split">
      <div class="prose">
        <p>Chaque tableau contient un carré noir, un carré blanc, et autant de noir que de blanc.
        C'est la seule contrainte, et elle tient depuis plus de dix ans : une règle
        « oupeinpienne » dont Mireille Martin tire, tableau après tableau, un répertoire de
        variations qui ne se répètent jamais.</p>
        <p>Le point de départ est un cahier de mathématiques de classe de troisième, puis
        l'abbaye de Fontevraud et ses couloirs dallés de carrés noirs et blancs. Le reste est
        venu de Chine : le vide et le plein, le pinceau, la calligraphie.</p>
      </div>
      <div class="facts">
        <div><b>{len(WORKS)}</b><span>œuvres au catalogue</span></div>
        <div><b>{n_expos}</b><span>expositions depuis 2014</span></div>
        <div><b>{n_solo}</b><span>expositions personnelles</span></div>
        <div class="facts__memb">
          <span class="label">Membre de</span>
          <ul>{memberships}</ul>
        </div>
      </div>
    </div>
  </div>
</section>

<section>
  <div class="wrap">
    <div class="section-head">
      <h2>Un choix d'œuvres</h2>
      <a class="link-arrow" href="/oeuvres/">Les 108 œuvres →</a>
    </div>
    <div class="plates">{"".join(plate(w) for w in selection)}</div>
  </div>
</section>

<section>
  <div class="wrap">
    <div class="section-head">
      <h2>{agenda_title}</h2>
      <a class="link-arrow" href="/expositions/">Toutes les expositions →</a>
    </div>
    <div class="tl-list" style="max-width:44rem">{agenda}</div>
  </div>
</section>

<section>
  <div class="wrap">
    <div class="section-head"><h2>Ce qu'on en dit</h2>
      <a class="link-arrow" href="/livre-dor/">Le livre d'or →</a></div>
    <div class="prose">
      <blockquote><p>Au-delà de la simple représentation mathématique rigoureuse, avec une extrême
      sobriété et une grande économie de moyens, elle nous démontre sa capacité à créer la
      perfection formelle par des équilibres remarquables et de simples contrastes de
      non-couleurs.</p></blockquote>
      <p class="signature">— Francine Bunel-Malras, historienne de l'art</p>
    </div>
  </div>
</section>
"""
    ld = [{
        "@context": "https://schema.org", "@type": "Person",
        "name": "Mireille Martin", "alternateName": "Mireille de Camps Martin",
        "jobTitle": "Artiste peintre", "url": BASE,
        "image": BASE + "/img/og/accueil.jpg",
        "email": "mailto:" + SITE["email"],
        "sameAs": [SITE["instagram_url"], "http://cac-normandie.org/martin.html"],
        "address": {"@type": "PostalAddress", "addressLocality": SITE["city"],
                    "addressRegion": SITE["region"], "addressCountry": "FR"},
        "knowsAbout": ["abstraction géométrique", "art concret", "encre de Chine", "calligraphie"],
        "memberOf": [{"@type": "Organization", "name": m["label"]} for m in SITE["memberships"]],
    }, {
        "@context": "https://schema.org", "@type": "WebSite",
        "name": "Mireille Martin", "url": BASE, "inLanguage": "fr-FR",
    }]
    page("/", "Mireille Martin — peintre, abstraction géométrique",
         "Peintures et encres de Chine en noir et blanc. Chaque tableau contient un carré noir, "
         "un carré blanc, et autant de noir que de blanc. Œuvres à découvrir et à acquérir.",
         body, og="/img/og/accueil.jpg", jsonld=ld)


def build_works_index():
    counts = {k: len([w for w in WORKS if w["series"] == k]) for k in SERIES}
    filters = ['<button class="filter" data-filter="all" aria-pressed="true">Tout <em>%d</em></button>' % len(WORKS)]
    for k, s in SERIES.items():
        filters.append(f'<button class="filter" data-filter="{k}" aria-pressed="false">{e(s["title"])} <em>{counts[k]}</em></button>')

    sections = []
    for k, s in SERIES.items():
        gs = groups_of(k)
        inner = "\n".join(render_group(g, items, show_head=(len(gs) > 1 or g != s["title"]))
                          for g, items in gs)
        sections.append(f"""<section data-series="{k}">
  <div class="wrap">
    <div class="section-head">
      <h2>{e(s['title'])}</h2>
      <p class="label">{e(s['medium'])} · {counts[k]} œuvres</p>
    </div>
    <p class="lede" style="margin-bottom:var(--space-7)">{e(s['lede'])}</p>
    {inner}
  </div>
</section>""")

    body = f"""
<div class="wrap">
  <section style="padding-bottom:var(--space-5)">
    <p class="label">Catalogue</p>
    <h1 style="font-size:var(--fs-2xl);margin-block:var(--space-3) var(--space-5)">Œuvres</h1>
    <p class="lede">Cent huit œuvres, quatre familles. Les acryliques sur toile de la série
      <em style="font-style:normal;color:var(--fg)">Aller Retour</em>, les peintures qui
      l'entourent, les onze <em style="font-style:normal;color:var(--fg)">Carrégraphies</em>
      et les encres de Chine sur papier.</p>
    <div class="filters" style="margin-top:var(--space-7)" role="group" aria-label="Filtrer par série">
      {"".join(filters)}
    </div>
  </section>
</div>
{"".join(sections)}
"""
    ld = {"@context": "https://schema.org", "@type": "CollectionPage",
          "name": "Œuvres de Mireille Martin", "url": BASE + "/oeuvres/",
          "hasPart": [{"@type": "VisualArtwork", "name": w["title"],
                       "url": f"{BASE}/oeuvres/{w['slug']}/"} for w in WORKS[:40]]}
    page("/oeuvres/", "Œuvres — Mireille Martin",
         "Le catalogue complet : 108 peintures et encres de Chine en noir et blanc. "
         "Séries Aller Retour, Carrégraphies, Équinoxe, Géométrie d'encre et de papier.",
         body, nav_key="/oeuvres/", jsonld=ld)


def build_work_pages():
    by_series = {}
    for w in WORKS:
        by_series.setdefault(w["series"], []).append(w)

    for w in WORKS:
        siblings = by_series[w["series"]]
        i = siblings.index(w)
        prev = siblings[i - 1] if i > 0 else siblings[-1]
        nxt = siblings[(i + 1) % len(siblings)]
        # les quatre suivantes du même groupe, en cycle — pas toujours les mêmes
        same = [x for x in siblings if x["group"] == w["group"]]
        pool = same if len(same) > 4 else siblings
        j = pool.index(w)
        others = [pool[(j + k) % len(pool)] for k in range(1, 5)]

        og = og_image(w["file"], w["slug"])
        srcset, fb, ow, oh = process(w["file"], w["slug"])
        s = SERIES[w["series"]]

        dims_html = ""
        if w["dimensions"]:
            lst = "".join(f"<li>{e(d)} cm</li>" for d in w["dimensions"])
            plural = " <span class=\"label\">formats disponibles</span>" if len(w["dimensions"]) > 1 else ""
            dims_html = f"<div><dt>Dimensions</dt><dd><ul>{lst}</ul>{plural}</dd></div>"

        ideo = f'<span class="work__ideo">{e(w["note"])}</span>' if w.get("note") else ""
        subject = f"Œuvre : {w['title']}"

        body = f"""
<div class="wrap">
  <p class="label" style="padding-top:var(--space-5)">
    <a href="/oeuvres/" style="color:inherit">Œuvres</a> ›
    <a href="/oeuvres/#{e(slugify(w['group']))}" style="color:inherit">{e(w['group'])}</a>
  </p>
  <div class="work">
    <div>
      <div class="work__stage">
        <button type="button" class="zoom" data-full="{e(fb)}" data-srcset="{e(srcset)}"
                data-caption="{e(w['title'])}" aria-label="Agrandir {e(w['title'])}">
          {picture(w['file'], w['slug'], f"{w['title']} — {w['technique']}, {dims_str(w) or 'dimensions non précisées'}", sizes="(min-width:940px) 62vw, 92vw", eager=True)}
        </button>
      </div>
      <p class="label" style="margin-top:var(--space-3)">Photographie : {e(SITE['credits_photo'])} — cliquer pour agrandir</p>
    </div>
    <aside class="work__aside">
      <p class="label">{e(s['title'])}</p>
      <h1 class="work__title">{e(w['title'])}{ideo}</h1>
      <dl class="specs">
        <div><dt>Technique</dt><dd>{e(w['technique'])}</dd></div>
        {dims_html}
        <div><dt>Série</dt><dd><a href="/oeuvres/#{e(slugify(w['group']))}" style="border-bottom:1px solid var(--rule-strong)">{e(w['group'])}</a></dd></div>
        <div><dt>Référence</dt><dd style="font-family:var(--font-mono);font-size:var(--fs-xs)">{e(w['slug'])}</dd></div>
      </dl>
      <div class="btn-row">
        <a class="btn" href="/contact/?oeuvre={e(w['slug'])}">Se renseigner sur cette œuvre</a>
      </div>
      <p class="form-note">Prix communiqué sur demande. Envoi et remise en main propre
        possibles depuis Rouen.</p>
    </aside>
  </div>

  <nav class="work__nav">
    <a class="link-arrow" href="/oeuvres/{e(prev['slug'])}/">← {e(prev['title'])}</a>
    <a class="link-arrow" href="/oeuvres/{e(nxt['slug'])}/">{e(nxt['title'])} →</a>
  </nav>
</div>

<section>
  <div class="wrap">
    <div class="section-head"><h2>Dans la même série</h2>
      <a class="link-arrow" href="/oeuvres/">Tout le catalogue →</a></div>
    <div class="plates">{"".join(plate(x) for x in others)}</div>
  </div>
</section>
"""
        desc = (f"{w['title']} — {w['technique']}"
                + (f", {dims_str(w)}" if w["dimensions"] else "")
                + f". Œuvre de Mireille Martin, série {w['group']}.")
        ld = [{
            "@context": "https://schema.org", "@type": "VisualArtwork",
            "name": w["title"], "url": f"{BASE}/oeuvres/{w['slug']}/",
            "image": f"{BASE}{fb}",
            "artform": "Peinture" if "Acrylique" in w["technique"] else "Dessin",
            "artMedium": w["technique"],
            "artworkSurface": "Toile" if "toile" in w["technique"] else "Papier",
            "creator": {"@type": "Person", "name": "Mireille Martin", "url": BASE},
            "isPartOf": {"@type": "CreativeWorkSeries", "name": w["group"]},
            "inLanguage": "fr",
            **({"width": {"@type": "Distance", "name": w["dimensions"][0].split("×")[0].strip() + " cm"}} if w["dimensions"] else {}),
        }, {
            "@context": "https://schema.org", "@type": "BreadcrumbList",
            "itemListElement": [
                {"@type": "ListItem", "position": 1, "name": "Accueil", "item": BASE + "/"},
                {"@type": "ListItem", "position": 2, "name": "Œuvres", "item": BASE + "/oeuvres/"},
                {"@type": "ListItem", "position": 3, "name": w["title"],
                 "item": f"{BASE}/oeuvres/{w['slug']}/"},
            ],
        }]
        page(f"/oeuvres/{w['slug']}/", f"{w['title']} — Mireille Martin", desc,
             body, og=og, nav_key="/oeuvres/", jsonld=ld)


def build_demarche():
    portrait = picture("portrait-mireille-martin.jpg", "portrait", "Mireille Martin dans son atelier",
                       sizes="(min-width:900px) 34vw, 92vw")
    og_image("portrait-mireille-martin.jpg", "demarche")
    manifest = next(w for w in WORKS if w["slug"] == "sans-titre-01")

    infl = " · ".join(SITE["influences"])
    memb = "".join(
        f'<li><a href="{e(m["url"])}" rel="noopener" target="_blank">{e(m["label"])}</a>'
        f'<br><span class="label">{e(m["detail"])}</span></li>' for m in SITE["memberships"])

    body = f"""
<div class="wrap">
  <section style="padding-bottom:var(--space-6)">
    <p class="label">Démarche</p>
    <h1 style="font-size:var(--fs-2xl);margin-block:var(--space-3) var(--space-5)">Deux carrés, et tout ce qui en découle</h1>
  </section>
</div>

<div class="wrap">
  <div style="display:grid;gap:var(--space-8);grid-template-columns:1fr" class="demarche-grid">
    <div class="prose">{md(text('demarche.md'))}</div>
    <div>
      <figure style="margin:0">
        {portrait}
        <figcaption class="label" style="margin-top:var(--space-3)">Mireille Martin</figcaption>
      </figure>
      <div class="info-list" style="margin-top:var(--space-7)">
        <div><h3>Membre de</h3><ul style="list-style:none;padding:0;margin:0;display:grid;gap:var(--space-3)">{memb}</ul></div>
        <div><h3>Filiations revendiquées</h3><p style="font-size:var(--fs-sm);color:var(--fg-muted)">{e(infl)}</p></div>
      </div>
    </div>
  </div>
</div>

<section>
  <div class="wrap">
    <figure style="margin:0;max-width:44rem">
      <div class="plate__frame" style="--plate-ratio:auto;aspect-ratio:auto">
        {picture(manifest['file'], manifest['slug'], "Le tableau fondateur : un carré noir, un carré blanc", sizes="(min-width:900px) 44rem, 92vw")}
      </div>
      <figcaption class="label" style="margin-top:var(--space-3)">
        Un carré noir, un carré blanc : le point de départ de tout le reste.
      </figcaption>
    </figure>
  </div>
</section>

<section>
  <div class="wrap">
    <div class="section-head"><h2>Critique</h2></div>
    <div class="prose">{md(text('critique.md'))}</div>
  </div>
</section>

<section>
  <div class="wrap">
    <div class="section-head"><h2>Récit</h2></div>
    <div class="prose">{md(text('recit.md'))}</div>
  </div>
</section>
"""
    extra = """<style>@media(min-width:900px){.demarche-grid{grid-template-columns:minmax(0,1fr) 20rem!important;gap:var(--space-8)}}</style>"""
    page("/demarche/", "Démarche — Mireille Martin",
         "Une contrainte « oupeinpienne » : un carré noir, un carré blanc, autant de noir que "
         "de blanc. Fontevraud, la Chine, la calligraphie — et les textes de Francine "
         "Bunel-Malras et Annette Pharamond.",
         body, og="/img/og/demarche.jpg", nav_key="/demarche/", extra_head=extra)


def build_exhibitions():
    ex = sorted(EXPOS["exhibitions"], key=lambda x: x["sort"], reverse=True)
    by_year = {}
    for x in ex:
        by_year.setdefault(x["sort"][:4], []).append(x)

    rows = []
    for y in sorted(by_year, reverse=True):
        items = "".join(
            f"""<div class="tl-item" data-solo="{str(x.get('solo', False)).lower()}">
              {'<span class="tag">Personnelle</span>' if x.get('solo') else ''}
              <strong>{e(x['title'])}</strong>
              <span>{e(x['when'])}{' — ' + e(x['venue']) if x.get('venue') else ''}{', ' + e(x['city']) if x.get('city') else ''}</span>
            </div>""" for x in by_year[y])
        rows.append(f'<div class="tl-year"><h3>{y}</h3><div class="tl-list">{items}</div></div>')

    upcoming_html = ""
    if EXPOS["upcoming"]:
        u = "".join(
            f"""<div class="tl-item" data-solo="{str(x.get('solo', False)).lower()}">
              <strong>{e(x['title'])}</strong>
              <span>{e(x['when'])}{' — ' + e(x.get('venue', '')) if x.get('venue') else ''}{', ' + e(x['city']) if x.get('city') else ''}</span>
            </div>""" for x in EXPOS["upcoming"])
        upcoming_html = f"""<section><div class="wrap">
          <div class="section-head"><h2>Prochainement</h2></div>
          <div class="tl-list" style="max-width:44rem">{u}</div></div></section>"""

    seen, blocks = set(), []
    for v in VIEWS:
        if v["caption"] in seen:
            continue
        seen.add(v["caption"])
        group = [x for x in VIEWS if x["caption"] == v["caption"]]
        figs = "".join(
            f'<div class="view"><figure>{picture(x["file"], x["slug"], x["caption"], sizes="(min-width:900px) 30vw, 92vw", subdir="vues")}</figure></div>'
            for x in group)
        blocks.append(f"""<div class="group">
          <div class="group__head"><h3>{e(v['caption'])}</h3></div>
          <div class="views">{figs}</div>
        </div>""")

    og_image("vues/" + VIEWS[0]["slug"] + ".jpg", "expositions")

    n_solo = len([x for x in ex if x.get("solo")])
    body = f"""
<div class="wrap">
  <section style="padding-bottom:var(--space-5)">
    <p class="label">Expositions</p>
    <h1 style="font-size:var(--fs-2xl);margin-block:var(--space-3) var(--space-5)">Là où le travail s'est montré</h1>
    <p class="lede">{len(ex)} expositions depuis 2014, dont {n_solo} personnelles.
      Rouen, Caen, Bayeux, Paris — Grand Palais, Réalités Nouvelles, galerie Abstract Project —
      et Taipei.</p>
  </section>
</div>
{upcoming_html}
<section>
  <div class="wrap">
    <div class="section-head"><h2>Chronologie</h2>
      <p class="label">Rouge : expositions personnelles</p></div>
    <div class="timeline">{"".join(rows)}</div>
  </div>
</section>

<section>
  <div class="wrap">
    <div class="section-head"><h2>Vues d'accrochage</h2>
      <p class="label">{len(VIEWS)} photographies</p></div>
    {"".join(blocks)}
  </div>
</section>
"""
    page("/expositions/", "Expositions — Mireille Martin",
         f"{len(ex)} expositions depuis 2014, dont {n_solo} personnelles : Grand Palais, Réalités "
         "Nouvelles, galerie Abstract Project, bibliothèque de Caen, Taipei. Vues d'accrochage.",
         body, og="/img/og/expositions.jpg", nav_key="/expositions/")


def build_gold():
    voices = "".join(f'<blockquote class="voice">{e(t)}</blockquote>' for t in GOLD["entries"])
    body = f"""
<div class="wrap">
  <section style="padding-bottom:var(--space-6)">
    <p class="label">Livre d'or</p>
    <h1 style="font-size:var(--fs-2xl);margin-block:var(--space-3) var(--space-5)">Origami d'Or</h1>
    <p class="lede">Ce que les visiteurs écrivent en repartant. Extraits des pages manuscrites
      du livre d'or, tenu d'exposition en exposition depuis 2017.</p>
  </section>
</div>
<section>
  <div class="wrap"><div class="voices">{voices}</div></div>
</section>
<section>
  <div class="wrap" style="text-align:center">
    <p class="lede" style="margin-inline:auto">Vous avez vu le travail quelque part ?</p>
    <div class="btn-row" style="justify-content:center">
      <a class="btn btn--ghost" href="/contact/">Écrire un mot</a>
    </div>
  </div>
</section>
"""
    page("/livre-dor/", "Livre d'or — Mireille Martin",
         "« Origami d'Or » : ce que les visiteurs écrivent en repartant. Extraits du livre d'or "
         "tenu d'exposition en exposition depuis 2017.",
         body, nav_key="/livre-dor/")


def build_contact():
    phone = SITE.get("phone", "").strip()
    phone_html = (f'<div><h3>Téléphone</h3><p><a href="tel:{e(phone.replace(" ", ""))}">{e(phone)}</a></p></div>'
                  if phone else "")
    opts = "".join(f'<option value="{e(w["slug"])}">{e(w["title"])} — {e(w["group"])}</option>' for w in WORKS)

    body = f"""
<div class="wrap">
  <section style="padding-bottom:var(--space-6)">
    <p class="label">Contact</p>
    <h1 style="font-size:var(--fs-2xl);margin-block:var(--space-3) var(--space-5)">Acquérir une œuvre, ou simplement écrire</h1>
    <p class="lede">Les œuvres sont disponibles à la vente directement auprès de l'artiste.
      Prix communiqué sur demande, selon le format. Visite de l'atelier possible sur
      rendez-vous, à Rouen.</p>
  </section>
</div>

<section>
  <div class="wrap contact-grid">
    <form id="contact-form" action="{e(SITE['form_endpoint'])}" method="post"
          data-email="{e(SITE['email'])}" novalidate>
      <div class="field">
        <label for="name">Votre nom</label>
        <input id="name" name="name" type="text" autocomplete="name" required>
      </div>
      <div class="field">
        <label for="email">Votre adresse e-mail</label>
        <input id="email" name="email" type="email" autocomplete="email" required>
      </div>
      <div class="field">
        <label for="subject">Objet</label>
        <select id="subject" name="subject">
          <option value="acquisition">Acquérir une œuvre</option>
          <option value="prix">Demander un prix</option>
          <option value="exposition">Proposition d'exposition</option>
          <option value="presse">Presse ou publication</option>
          <option value="autre">Autre</option>
        </select>
      </div>
      <div class="field">
        <label for="work">Œuvre concernée <span style="text-transform:none;letter-spacing:0">(facultatif)</span></label>
        <select id="work" name="work">
          <option value="">—</option>
          {opts}
        </select>
      </div>
      <div class="field">
        <label for="message">Votre message</label>
        <textarea id="message" name="message" required></textarea>
      </div>
      <div class="hp" aria-hidden="true">
        <label for="website">Ne pas remplir</label>
        <input id="website" name="website" type="text" tabindex="-1" autocomplete="off">
      </div>
      <button class="btn" type="submit">Envoyer</button>
      <p class="form-status" id="form-status" role="status" aria-live="polite"></p>
      <p class="form-note">Le message est transmis directement à l'artiste. Aucune donnée n'est
        conservée sur ce site. Si le formulaire ne fonctionne pas, écrivez à
        <a href="mailto:{e(SITE['email'])}" style="border-bottom:1px solid var(--rule-strong)">{e(SITE['email'])}</a>.</p>
    </form>

    <div class="info-list">
      <div><h3>E-mail</h3><p><a href="mailto:{e(SITE['email'])}">{e(SITE['email'])}</a></p></div>
      {phone_html}
      <div><h3>Atelier</h3><p>Rouen, Normandie.<br>Visite sur rendez-vous.</p></div>
      <div><h3>Instagram</h3><p><a href="{e(SITE['instagram_url'])}" rel="me noopener" target="_blank">@{e(SITE['instagram'])}</a></p></div>
      <div><h3>Collectifs</h3><p>{"<br>".join(f'<a href="{e(m["url"])}" rel="noopener" target="_blank">{e(m["label"])}</a>' for m in SITE["memberships"])}</p></div>
    </div>
  </div>
</section>
"""
    ld = {"@context": "https://schema.org", "@type": "ContactPage",
          "url": BASE + "/contact/",
          "mainEntity": {"@type": "Person", "name": "Mireille Martin",
                         "email": "mailto:" + SITE["email"]}}
    page("/contact/", "Contact — Mireille Martin",
         "Acquérir une œuvre, demander un prix, proposer une exposition. Les peintures et encres "
         "sont vendues directement par l'artiste, à Rouen.",
         body, nav_key="/contact/", jsonld=ld)


def build_english():
    body = f"""
<div class="wrap">
  <section style="padding-bottom:var(--space-6)">
    <p class="label">English</p>
    <h1 style="font-size:var(--fs-2xl);margin-block:var(--space-3) var(--space-5)">As much black as white</h1>
    <p class="lede">Mireille Martin is a French painter working in geometric abstraction.
      A founding member of the Collectif Art Concret — Normandie, she lives and works near Rouen.</p>
  </section>
</div>
<section>
  <div class="wrap">
    <div class="prose">
      <h2>The rule</h2>
      <p>Every painting contains one black square, one white square — and exactly as much black
      as white. That single constraint has held for more than ten years, and from it she draws a
      repertoire of variations that never repeat.</p>
      <blockquote><p>For me, geometry has always been a source of poetry and a pretext for escape.</p></blockquote>
      <h2>Criticism</h2>
      <p>Mireille Martin took to painting after keeping sketchbooks, in which she would cut out
      geometric shapes with scissors. Fascinated by the Abbey of Fontevraud and the magic of its
      black and white stone, she intentionally oriented her own painting style toward stark motifs
      and basic “non-colours”, which she tirelessly explores in her series
      <em>Allers-Retours</em> by opposing contrasts.</p>
      <p>Drawn to Abstract Expressionism, the artist works in the spirit of Geometric Abstraction.
      Assembling well constructed and radically simple elements allows her to divide and to
      accentuate space with black and white solid fills, whilst simultaneously playing on right
      angles and the diagonal line. Going beyond merely a strict mathematical representation, she
      demonstrates with extreme sobriety and very sparing means — in both her acrylic and Indian
      ink paintings — her ability to create formal perfection through astonishing plays of balance
      and simple contrasts of non-colours.</p>
      <p>Her trips to China have also been decisive in her artistic career, which is very marked
      by Chinese philosophy. Her approach is as much an aesthetic reflection as a genuine
      pictorial meditation.</p>
      <p class="signature">— Francine Bunel-Malras, art historian</p>
      <h2>Work and enquiries</h2>
      <p>The catalogue holds {len(WORKS)} works: acrylics on canvas and Indian ink on paper.
      All of them are available directly from the artist; prices on request.</p>
      <p><a href="/oeuvres/" class="link-arrow">Browse the works →</a></p>
      <p><a href="mailto:{e(SITE['email'])}" class="link-arrow">{e(SITE['email'])} →</a></p>
    </div>
  </div>
</section>
"""
    page("/en/", "Mireille Martin — geometric abstraction",
         "French painter, geometric abstraction. Every painting contains one black square, one "
         "white square, and as much black as white. Works available directly from the artist.",
         body)


def build_legal():
    body = f"""
<div class="wrap">
  <section>
    <p class="label">Mentions légales</p>
    <h1 style="font-size:var(--fs-xl);margin-block:var(--space-3) var(--space-6)">Mentions légales</h1>
    <div class="prose">
      <h2>Éditrice</h2>
      <p>Mireille Martin, artiste peintre — Rouen, France.<br>
      Contact : <a href="mailto:{e(SITE['email'])}" style="border-bottom:1px solid var(--rule-strong)">{e(SITE['email'])}</a></p>
      <h2>Hébergement</h2>
      <p>Vercel Inc., 440 N Barranca Ave #4133, Covina, CA 91723, États-Unis.</p>
      <h2>Propriété intellectuelle</h2>
      <p>L'ensemble des œuvres reproduites sur ce site est la propriété exclusive de Mireille
      Martin. Toute reproduction, représentation ou diffusion, totale ou partielle, sans
      autorisation écrite préalable est interdite.</p>
      <p>Photographies des œuvres : {e(SITE['credits_photo'])}.</p>
      <h2>Données personnelles</h2>
      <p>Le formulaire de contact transmet le message par courrier électronique à l'artiste.
      Aucune donnée n'est stockée sur ce site, aucun cookie n'est déposé, aucun outil de mesure
      d'audience tiers n'est utilisé. Pour exercer vos droits d'accès, de rectification ou de
      suppression, écrivez à l'adresse ci-dessus.</p>
    </div>
  </section>
</div>
"""
    page("/mentions-legales/", "Mentions légales — Mireille Martin",
         "Mentions légales, propriété intellectuelle et données personnelles.", body)


def build_404():
    body = """
<div class="wrap">
  <section style="text-align:center;padding-block:var(--space-9)">
    <p class="label">Erreur 404</p>
    <h1 style="font-size:var(--fs-2xl);margin-block:var(--space-4)">Cette page n'existe pas</h1>
    <p class="lede" style="margin-inline:auto">Le carré noir a peut-être recouvert le blanc.</p>
    <div class="btn-row" style="justify-content:center">
      <a class="btn" href="/">Retour à l'accueil</a>
      <a class="btn btn--ghost" href="/oeuvres/">Voir les œuvres</a>
    </div>
  </section>
</div>
"""
    page("/404", "Page introuvable — Mireille Martin", "Page introuvable.", body)
    shutil.move(os.path.join(DIST, "404", "index.html"), os.path.join(DIST, "404.html"))
    os.rmdir(os.path.join(DIST, "404"))


def build_static():
    shutil.copyfile(os.path.join(ASSETS, "styles.css"), os.path.join(DIST, "styles.css"))
    shutil.copyfile(os.path.join(ASSETS, "app.js"), os.path.join(DIST, "app.js"))

    favicon = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
               '<rect width="32" height="32" fill="#f5f2ea"/>'
               '<rect x="3" y="3" width="14" height="14" fill="#14120f"/>'
               '<rect x="17" y="17" width="12" height="12" fill="none" stroke="#14120f" stroke-width="2"/>'
               '</svg>')
    with open(os.path.join(DIST, "favicon.svg"), "w", encoding="utf-8") as f:
        f.write(favicon)

    ico = Image.new("RGB", (180, 180), (245, 242, 234))
    d = ImageDraw.Draw(ico)
    d.rectangle([18, 18, 96, 96], fill=(20, 18, 15))
    d.rectangle([96, 96, 162, 162], outline=(20, 18, 15), width=10)
    ico.save(os.path.join(DIST, "apple-touch-icon.png"))

    manifest = {
        "name": "Mireille Martin", "short_name": "M. Martin",
        "start_url": "/", "display": "standalone",
        "background_color": "#f5f2ea", "theme_color": "#f5f2ea",
        "icons": [{"src": "/apple-touch-icon.png", "sizes": "180x180", "type": "image/png"}],
    }
    with open(os.path.join(DIST, "site.webmanifest"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False)

    with open(os.path.join(DIST, "robots.txt"), "w", encoding="utf-8") as f:
        f.write(f"User-agent: *\nAllow: /\n\nSitemap: {BASE}/sitemap.xml\n")


def build_sitemap(urls):
    items = "".join(
        f"<url><loc>{e(u)}</loc><lastmod>{TODAY.isoformat()}</lastmod>"
        f"<priority>{p}</priority></url>" for u, p in urls)
    xml = ('<?xml version="1.0" encoding="UTF-8"?>'
           '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
           f"{items}</urlset>")
    with open(os.path.join(DIST, "sitemap.xml"), "w", encoding="utf-8") as f:
        f.write(xml)


def main():
    if os.path.exists(DIST):
        for entry in os.listdir(DIST):
            if entry != "img":
                p = os.path.join(DIST, entry)
                shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)
    os.makedirs(IMGDIR, exist_ok=True)

    build_home()
    build_works_index()
    build_work_pages()
    build_demarche()
    build_exhibitions()
    build_gold()
    build_contact()
    build_english()
    build_legal()
    build_404()
    build_static()

    urls = [(BASE + "/", "1.0"), (BASE + "/oeuvres/", "0.9"), (BASE + "/demarche/", "0.8"),
            (BASE + "/expositions/", "0.8"), (BASE + "/livre-dor/", "0.6"),
            (BASE + "/contact/", "0.7"), (BASE + "/en/", "0.5"),
            (BASE + "/mentions-legales/", "0.2")]
    urls += [(f"{BASE}/oeuvres/{w['slug']}/", "0.7") for w in WORKS]
    build_sitemap(urls)

    n_html = sum(len([f for f in fs if f.endswith(".html")]) for _, _, fs in os.walk(DIST))
    n_img = len(os.listdir(IMGDIR)) + len(os.listdir(os.path.join(IMGDIR, "vues")))
    print(f"✓ {n_html} pages HTML, {n_img} fichiers image, {len(WORKS)} œuvres → dist/")


if __name__ == "__main__":
    main()
