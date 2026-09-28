/**
 * Les contenus éditables et leurs règles.
 *
 * L'administration ne fournit jamais de fichier brut : elle envoie des données, que ce
 * module vérifie champ par champ, normalise (ordre des clés, espaces, formats) et remet
 * dans la forme exacte que build.py attend. Une donnée qui ne respecte pas la structure
 * est refusée avec un message lisible, avant tout commit.
 */

import { HttpError } from "./github.js";

export const DOCS = {
  works: "content/works.json",
  series: "content/series.json",
  home: "content/home.json",
  exhibitions: "content/exhibitions.json",
  views: "content/views.json",
  gold: "content/livre-dor.json",
  critiques: "content/critiques.json",
  site: "content/site.json",
  demarche: "content/texts/demarche.md",
  recit: "content/texts/recit.md",
};

/* ------------------------------------------------------------ utilitaires */

export class Invalid extends HttpError {
  constructor(message) {
    super(400, "invalid", message);
  }
}

export function slugify(s) {
  return String(s || "")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/œ/g, "oe").replace(/Œ/g, "oe").replace(/æ/g, "ae").replace(/Æ/g, "ae")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Texte d'une ligne : espaces normalisés, longueur bornée. */
function line(v, label, { max = 200, required = false } = {}) {
  if (v == null) v = "";
  if (typeof v !== "string") throw new Invalid(`${label} : texte attendu.`);
  const s = v.replace(/\s+/g, " ").trim();
  if (required && !s) throw new Invalid(`${label} : ce champ est obligatoire.`);
  if (s.length > max) throw new Invalid(`${label} : ${max} caractères au maximum.`);
  return s;
}

/** Texte de plusieurs paragraphes : sauts de ligne gardés, le reste normalisé. */
function para(v, label, { max = 5000, required = false } = {}) {
  if (v == null) v = "";
  if (typeof v !== "string") throw new Invalid(`${label} : texte attendu.`);
  const s = v.replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (required && !s) throw new Invalid(`${label} : ce champ est obligatoire.`);
  if (s.length > max) throw new Invalid(`${label} : ${max} caractères au maximum.`);
  return s;
}

function list(v, label, max) {
  if (!Array.isArray(v)) throw new Invalid(`${label} : liste attendue.`);
  if (v.length > max) throw new Invalid(`${label} : ${max} éléments au maximum.`);
  return v;
}

const bool = (v) => v === true;
const dump = (obj) => JSON.stringify(obj, null, 2) + "\n";

function uniqueSlug(base, taken) {
  let s = (base || "sans-titre").slice(0, 60).replace(/-+$/, "") || "sans-titre";
  if (!taken.has(s)) return s;
  for (let i = 2; ; i++) if (!taken.has(`${s}-${i}`)) return `${s}-${i}`;
}

/* ---------------------------------------------- textes : markdown allégé
   Le format lu par build.py : « ## » intertitre, « > » citation, « — » signature,
   « # » titre (non affiché). L'admin manipule des blocs, jamais cette syntaxe. */

export function mdToBlocks(src) {
  const blocks = [];
  let title = "";
  let buf = [];
  let mode = null;
  const flush = () => {
    if (!buf.length) return;
    blocks.push({ type: mode === "quote" ? "quote" : "p", text: buf.join(" ").trim() });
    buf = [];
    mode = null;
  };
  for (const raw of String(src).split("\n")) {
    const s = raw.trimEnd();
    if (!s.trim()) { flush(); continue; }
    if (s.startsWith("## ")) { flush(); blocks.push({ type: "h", text: s.slice(3).trim() }); }
    else if (s.startsWith("# ")) { flush(); title = s.slice(2).trim(); }
    else if (s.startsWith("> ")) { if (mode !== "quote") flush(); mode = "quote"; buf.push(s.slice(2).trim()); }
    else { if (mode === "quote") flush(); buf.push(s.trim()); }
  }
  flush();
  let signature = "";
  const last = blocks[blocks.length - 1];
  if (last && last.type === "p" && last.text.startsWith("—")) {
    signature = last.text.replace(/^—\s*/, "");
    blocks.pop();
  }
  for (const b of blocks) b.text = b.text.replace(/^⁠/, "");
  return { title, blocks, signature };
}

export function blocksToMd({ title = "", blocks = [], signature = "" }) {
  // un paragraphe qui commencerait par un signe de syntaxe est protégé par un
  // caractère invisible : il reste un paragraphe
  const guard = (t) => (/^(#|>|—)/.test(t) ? "⁠" + t : t);
  const out = [];
  if (title) out.push(`# ${title}`, "");
  for (const b of blocks) {
    if (b.type === "h") out.push(`## ${b.text}`);
    else if (b.type === "quote") out.push(`> ${b.text}`);
    else out.push(guard(b.text));
    out.push("");
  }
  if (signature) out.push(`— ${signature}`, "");
  return out.join("\n").replace(/\n+$/, "") + "\n";
}

function cleanBlocks(v, label) {
  const out = [];
  for (const b of list(v, label, 200)) {
    const type = ["p", "h", "quote"].includes(b?.type) ? b.type : "p";
    if (type === "h") {
      const text = line(b?.text, `${label} — intertitre`, { max: 200 });
      if (text) out.push({ type, text });
      continue;
    }
    // une ligne vide tapée dans un paragraphe en fait deux : c'est ce que l'on attend
    for (const chunk of para(b?.text, label, { max: 6000 }).split(/\n\s*\n/)) {
      const text = chunk.replace(/\s+/g, " ").trim();
      if (text) out.push({ type, text });
    }
  }
  return out;
}

/* ---------------------------------------------------- lecture pour l'admin */

export function toClient(name, raw) {
  if (name === "demarche" || name === "recit") return mdToBlocks(raw);
  const doc = JSON.parse(raw);
  if (name === "critiques") {
    return {
      critiques: doc.critiques.map((c) => ({
        title: c.title || "", author: c.author || "", role: c.role || "",
        blocks: mdToBlocks(c.text).blocks,
      })),
    };
  }
  if (name === "site") {
    return { email: doc.email, phone: doc.phone || "", instagram: doc.instagram || "",
      credits_photo: doc.credits_photo || "" };
  }
  delete doc.note;
  return doc;
}

/* ------------------------------------------------ validation et écriture
   normalize(name, data, ctx) → contenu du fichier, prêt à committer.
   ctx : { current(name) → objet actuel, next(name) → objet après cet enregistrement,
           uploads: Set des images envoyées dans cet enregistrement, files: index du dépôt } */

const NORMALIZE = {
  series(data, ctx) {
    const cur = ctx.current("series");
    const families = [];
    const keys = new Set();
    for (const f of list(data.families, "Familles", 30)) {
      const title = line(f?.title, "Nom de la famille", { max: 60, required: true });
      let key = typeof f?.key === "string" && cur.families.some((x) => x.key === f.key) ? f.key : null;
      if (!key) key = uniqueSlug(slugify(title), new Set([...keys, ...cur.families.map((x) => x.key)]));
      if (keys.has(key)) throw new Invalid(`Famille en double : ${title}.`);
      keys.add(key);
      families.push({
        key, title,
        lede: line(f?.lede, `Présentation de « ${title} »`, { max: 600 }),
        medium: line(f?.medium, `Technique de « ${title} »`, { max: 80 }),
      });
    }
    if (!families.length) throw new Invalid("Il faut au moins une famille.");
    const groups = [];
    const names = new Set();
    for (const g of list(data.groups, "Séries", 200)) {
      const name = line(g?.name, "Nom de la série", { max: 60, required: true });
      if (names.has(name.toLowerCase())) throw new Invalid(`Deux séries portent le nom « ${name} ».`);
      names.add(name.toLowerCase());
      if (!keys.has(g?.family)) throw new Invalid(`Série « ${name} » : famille inconnue.`);
      groups.push({ name, family: g.family,
        note: line(g?.note, `Note de « ${name} »`, { max: 240 }), tall: bool(g?.tall) });
    }
    return dump({ note: cur.note, families, groups });
  },

  works(data, ctx) {
    const cur = ctx.current("works").works;
    const series = ctx.next("series");
    const byName = new Map(series.groups.map((g) => [g.name, g]));
    const curBySlug = new Map(cur.map((w) => [w.slug, w]));
    const taken = new Set();
    let n = Math.max(0, ...cur.map((w) => w.n || 0));
    const works = [];
    const items = list(data.works, "Œuvres", 2000);
    // les œuvres existantes réservent leur référence d'abord : une nouvelle ne peut pas la prendre
    for (const w of items) if (curBySlug.has(w?.slug)) taken.add(w.slug);
    const kept = new Set();
    for (const w of items) {
      const title = line(w?.title, "Titre de l'œuvre", { max: 120, required: true });
      if (curBySlug.has(w?.slug)) {
        if (kept.has(w.slug)) throw new Invalid(`« ${title} » figure deux fois dans le catalogue.`);
        kept.add(w.slug);
      }
      const label = `« ${title} »`;
      const group = byName.get(w?.group);
      if (!group) throw new Invalid(`${label} : choisissez une série.`);
      const dims = list(w?.dimensions ?? [], `${label} — formats`, 12).map((d) => {
        const m = String(d).match(/^\s*(\d{1,4}(?:[.,]\d{1,2})?)\s*[×xX*]\s*(\d{1,4}(?:[.,]\d{1,2})?)\s*$/);
        if (!m) throw new Invalid(`${label} : format « ${d} » illisible (exemple : 60 × 80).`);
        return `${m[1].replace(".", ",")} × ${m[2].replace(".", ",")}`;
      });
      const file = typeof w?.file === "string" ? w.file : "";
      if (!/^[a-z0-9][a-z0-9-]*\.jpg$/.test(file) ||
          !(ctx.files.has(`assets/originals/${file}`) || ctx.uploads.has(file))) {
        throw new Invalid(`${label} : photographie manquante.`);
      }
      const old = curBySlug.get(w?.slug);
      const slug = old ? old.slug : uniqueSlug(slugify(title), new Set([...taken, ...curBySlug.keys()]));
      taken.add(slug);
      const note = line(w?.note, `${label} — caractère`, { max: 12 }) || null;
      const short = line(w?.short, `${label} — titre court`, { max: 60 }) || null;
      const description = para(w?.description, `${label} — présentation`, { max: 3000 });
      works.push({
        n: old ? old.n : ++n,
        title,
        series: group.family,
        group: group.name,
        technique: line(w?.technique, `${label} — technique`, { max: 120, required: true }),
        dimensions: dims,
        note,
        slug,
        untitled: old ? old.untitled : /^sans titre/i.test(title),
        file,
        short,
        ...(description ? { description } : {}),
      });
    }
    if (!works.length) throw new Invalid("Le catalogue ne peut pas être vide.");
    return dump({ works });
  },

  home(data, ctx) {
    const cur = ctx.current("home");
    const works = ctx.next("works").works;
    const slugs = new Set(works.map((w) => w.slug));
    // « file:xxx.jpg » désigne une œuvre créée dans ce même enregistrement
    const byFile = new Map(works.map((w) => [`file:${w.file}`, w.slug]));
    const featured = [...new Set(list(data.featured ?? [], "Sélection de l'accueil", 24)
      .map((s) => byFile.get(s) || s).filter((s) => slugs.has(s)))];
    const hero = slugs.has(data.hero) ? data.hero : (slugs.has(cur.hero) ? cur.hero : [...slugs][0]);
    return dump({ note: cur.note, hero, featured });
  },

  exhibitions(data, ctx) {
    const cur = ctx.current("exhibitions");
    const clean = (arr, label) => list(arr ?? [], label, 500).map((x) => {
      const title = line(x?.title, "Titre de l'exposition", { max: 160, required: true });
      const sort = String(x?.sort || "");
      if (!/^(19|20)\d{2}-(0[1-9]|1[0-2])$/.test(sort)) throw new Invalid(`« ${title} » : indiquez le mois et l'année.`);
      return {
        sort,
        when: line(x?.when, `« ${title} » — dates`, { max: 80, required: true }),
        title,
        venue: line(x?.venue, `« ${title} » — lieu`, { max: 160 }),
        city: line(x?.city, `« ${title} » — ville`, { max: 80 }),
        solo: bool(x?.solo),
      };
    });
    return dump({
      note: cur.note,
      exhibitions: clean(data.exhibitions, "Expositions"),
      upcoming: clean(data.upcoming, "Expositions à venir"),
    });
  },

  views(data, ctx) {
    const cur = ctx.current("views").views;
    const curByFile = new Map(cur.map((v) => [v.file, v]));
    let n = Math.max(0, ...cur.map((v) => v.n || 0));
    const views = list(data.views, "Vues d'accrochage", 1000).map((v) => {
      const file = typeof v?.file === "string" ? v.file : "";
      const m = file.match(/^vues\/([a-z0-9][a-z0-9-]*)\.jpg$/);
      if (!m || !(ctx.files.has(`assets/originals/${file}`) || ctx.uploads.has(file))) {
        throw new Invalid("Vue d'accrochage : photographie manquante.");
      }
      const old = curByFile.get(file);
      return {
        n: old ? old.n : ++n,
        caption: line(v?.caption, "Légende de la vue", { max: 200, required: true }),
        slug: m[1],
        file,
      };
    });
    return dump({ views });
  },

  gold(data, ctx) {
    const entries = list(data.entries, "Livre d'or", 1000)
      .map((t) => line(t, "Mot du livre d'or", { max: 3000 })).filter(Boolean);
    return dump({ note: ctx.current("gold").note, entries });
  },

  critiques(data, ctx) {
    const critiques = list(data.critiques, "Critiques", 50).map((c) => {
      const author = line(c?.author, "Auteur de la critique", { max: 120, required: true });
      const blocks = cleanBlocks(c?.blocks ?? [], `Critique de ${author}`);
      if (!blocks.length) throw new Invalid(`Critique de ${author} : le texte est vide.`);
      return {
        title: line(c?.title, `Critique de ${author} — titre`, { max: 200 }),
        author,
        role: line(c?.role, `Critique de ${author} — qualité`, { max: 120 }),
        text: blocksToMd({ blocks }).trim(),
      };
    });
    return dump({ note: ctx.current("critiques").note, critiques });
  },

  site(data, ctx) {
    const cur = ctx.current("site");
    const email = line(data.email, "Adresse e-mail", { max: 160, required: true });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new Invalid("Adresse e-mail invalide.");
    const phone = line(data.phone, "Téléphone", { max: 30 });
    if (phone && !/^[+0-9 ().-]{6,30}$/.test(phone)) throw new Invalid("Numéro de téléphone invalide.");
    const instagram = line(data.instagram, "Instagram", { max: 60 }).replace(/^@/, "");
    if (instagram && !/^[A-Za-z0-9._]+$/.test(instagram)) throw new Invalid("Nom Instagram invalide.");
    return dump({
      ...cur,
      email,
      phone,
      instagram: instagram || cur.instagram,
      instagram_url: `https://www.instagram.com/${instagram || cur.instagram}/`,
      credits_photo: line(data.credits_photo, "Crédit photographique", { max: 120, required: true }),
    });
  },

  demarche(data, ctx) {
    const blocks = cleanBlocks(data.blocks, "Démarche");
    if (!blocks.length) throw new Invalid("Le texte de la démarche est vide.");
    return blocksToMd({ title: ctx.current("demarche").title || "Démarche", blocks });
  },

  recit(data, ctx) {
    const blocks = cleanBlocks(data.blocks, "Récit");
    if (!blocks.length) throw new Invalid("Le récit est vide.");
    return blocksToMd({
      title: ctx.current("recit").title,
      blocks,
      signature: line(data.signature, "Signature du récit", { max: 160 }),
    });
  },
};

/** Ordre de traitement : ce dont dépendent les autres d'abord. */
export const ORDER = ["series", "works", "home", "exhibitions", "views", "gold", "critiques", "site", "demarche", "recit"];

export function normalize(name, data, ctx) {
  if (!NORMALIZE[name]) throw new Invalid(`Rubrique inconnue : ${name}.`);
  if (!data || typeof data !== "object") throw new Invalid("Données manquantes.");
  return NORMALIZE[name](data, ctx);
}

/** Lecture d'un fichier pour ctx.current / ctx.next (objets, pas le format client). */
export function parseDoc(name, raw) {
  if (name === "demarche" || name === "recit") return mdToBlocks(raw);
  return JSON.parse(raw);
}

/** Contrôles croisés, faits sur l'état final : ce que build.py exigera. */
export function crossCheck(next) {
  const series = next("series");
  const groups = new Map(series.groups.map((g) => [g.name, g.family]));
  for (const w of next("works").works) {
    if (groups.get(w.group) !== w.series) {
      throw new Invalid(`L'œuvre « ${w.title} » appartient à une série qui n'existe plus. ` +
        "Déplacez-la d'abord dans une autre série.");
    }
  }
}
