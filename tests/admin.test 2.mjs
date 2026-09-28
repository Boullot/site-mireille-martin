/**
 * Cycle complet de l'administration contre un faux GitHub :
 *   invitation → mot de passe → connexion → lecture → envoi d'image → enregistrement
 *   → commit → build.py sur le résultat.
 *
 *   npm test
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fakeGitHub } from "./fake-github.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
Object.assign(process.env, {
  GITHUB_TOKEN: "test", GITHUB_REPO: "o/r", GITHUB_BRANCH: "main",
  ADMIN_EMAIL: "michel.martin54@free.fr",
  ADMIN_SECRET: crypto.randomBytes(32).toString("hex"),
  ADMIN_AUTH_VAR: "ADMIN_AUTH_TEST",
  SITE_URL: "https://exemple.test",
});
delete process.env.RESEND_API_KEY;

const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((d) =>
  d.isDirectory() ? walk(`${dir}/${d.name}`) : [`${dir}/${d.name}`]);

let gh, api, auth, content;
const HOST = "http://localhost:3000";

before(async () => {
  gh = fakeGitHub({
    root: ROOT,
    paths: [...walk("content")],
    stubs: [...walk("assets/originals"), ...walk("dist/img")],
  });
  api = await import("../api/admin.js");
  auth = await import("../api/_lib/auth.js");
  content = await import("../api/_lib/content.js");
});
after(() => gh.restore());

async function call(method, action, { json, blob, cookie, params = {}, headers = {} } = {}) {
  const qs = new URLSearchParams({ a: action, ...params });
  const h = { "x-mm-admin": "1", ...headers };
  if (cookie) h.cookie = cookie;
  if (json) h["content-type"] = "application/json";
  if (blob) h["content-type"] = "image/jpeg";
  const res = await api[method](new Request(`${HOST}/api/admin?${qs}`, {
    method, headers: h, body: json ? JSON.stringify(json) : blob,
  }));
  const data = await res.json().catch(() => null);
  const set = res.headers.get("set-cookie");
  return { status: res.status, data, cookie: set ? set.split(";")[0] : null, raw: set };
}

let cookie;
const docs = async () => (await call("GET", "content", { cookie })).data.docs;

describe("authentification", () => {
  test("pas de session au départ", async () => {
    const r = await call("GET", "session");
    assert.equal(r.status, 200);
    assert.equal(r.data.authenticated, false);
    assert.equal((await call("GET", "content")).status, 401);
  });

  test("un jeton falsifié est refusé", async () => {
    const t = auth.inviteToken();
    const forged = t.slice(0, -3) + (t.endsWith("AAA") ? "BBB" : "AAA");
    assert.equal((await call("POST", "setup", { json: { token: forged, password: "une phrase longue" } })).status, 410);
  });

  test("invitation : création du mot de passe, puis lien caduc", async () => {
    const t = auth.inviteToken();
    const short = await call("POST", "setup", { json: { token: t, password: "court" } });
    assert.equal(short.status, 400);
    const r = await call("POST", "setup", { json: { token: t, password: "le carré noir et le blanc" } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.match(r.raw, /HttpOnly/);
    assert.match(r.raw, /SameSite=Strict/);
    assert.match(r.raw, /Secure/);
    const stored = gh.vars.get("ADMIN_AUTH_TEST");
    assert.ok(stored && !stored.includes("carré"), "le mot de passe n'est jamais stocké en clair");
    cookie = r.cookie;
    const again = await call("POST", "setup", { json: { token: t, password: "autre chose encore" } });
    assert.equal(again.status, 410, "un lien ne sert qu'une fois");
  });

  test("connexion", async () => {
    assert.equal((await call("POST", "login", { json: { email: "michel.martin54@free.fr", password: "faux mot de passe" } })).status, 401);
    assert.equal((await call("POST", "login", { json: { email: "autre@free.fr", password: "le carré noir et le blanc" } })).status, 401);
    const r = await call("POST", "login", { json: { email: " Michel.Martin54@free.fr ", password: "le carré noir et le blanc" } });
    assert.equal(r.status, 200);
    cookie = r.cookie;
    const s = await call("GET", "session", { cookie });
    assert.equal(s.data.authenticated, true);
  });

  test("protection CSRF : en-tête obligatoire et même origine", async () => {
    const noHeader = await api.POST(new Request(`${HOST}/api/admin?a=save`, {
      method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" }));
    assert.equal(noHeader.status, 403);
    const cross = await call("POST", "save", { cookie, json: {}, headers: { origin: "https://pirate.test" } });
    assert.equal(cross.status, 403);
  });

  test("mot de passe oublié sans e-mail configuré : pas d'envoi, réponse honnête", async () => {
    const r = await call("POST", "forgot", { json: { email: "michel.martin54@free.fr" } });
    assert.equal(r.data.sent, false);
  });
});

describe("contenu", () => {
  test("lecture de toutes les rubriques", async () => {
    const d = await docs();
    assert.equal(d.works.data.works.length, 108);
    assert.ok(d.demarche.data.blocks.some((b) => b.type === "h"));
    assert.ok(d.critiques.data.critiques[0].blocks.length >= 3);
    assert.equal(d.recit.data.signature, "Annette Pharamond");
    assert.equal(d.site.data.email, "mireillemartin8@free.fr");
  });

  test("réenregistrer chaque rubrique telle quelle ne change aucun fichier", async () => {
    const d = await docs();
    const head = gh.head;
    for (const name of Object.keys(d)) {
      const r = await call("POST", "save", { cookie, json: { docs: { [name]: d[name] }, summary: "test" } });
      assert.equal(r.status, 200, `${name} : ${JSON.stringify(r.data)}`);
      assert.equal(r.data.unchanged, true, `${name} : la normalisation doit être stable`);
    }
    assert.equal(gh.head, head);
  });

  test("les champs invalides sont refusés avec un message lisible", async () => {
    const d = await docs();
    const bad = async (mutate) => {
      const w = structuredClone(d.works);
      mutate(w.data.works);
      const r = await call("POST", "save", { cookie, json: { docs: { works: w } } });
      assert.equal(r.status, 400);
      assert.ok(r.data.message && !/undefined/.test(r.data.message), r.data.message);
      return r.data.message;
    };
    assert.match(await bad((ws) => { ws[0].title = "  "; }), /obligatoire/);
    assert.match(await bad((ws) => { ws[0].dimensions = ["60 sur 80"]; }), /illisible/);
    assert.match(await bad((ws) => { ws[0].group = "Série fantôme"; }), /série/);
    assert.match(await bad((ws) => { ws[0].file = "inexistant.jpg"; }), /photographie/);
    assert.match(await bad((ws) => { ws.push(structuredClone(ws[0])); }), /deux fois/);
    assert.match(await bad((ws) => { ws.length = 0; }), /vide/);
  });

  test("un format « 60x80 » est normalisé en « 60 × 80 »", async () => {
    const d = await docs();
    d.works.data.works[0].dimensions = ["60x80", "80,5 × 100"];
    const r = await call("POST", "save", { cookie, json: { docs: { works: d.works }, summary: "formats" } });
    assert.equal(r.status, 200);
    const w = JSON.parse(gh.read("content/works.json")).works[0];
    assert.deepEqual(w.dimensions, ["60 × 80", "80,5 × 100"]);
    assert.equal(w.slug, "aller-retour-i", "la référence d'une œuvre existante ne change jamais");
  });

  test("conflit : une rubrique modifiée entre-temps n'est pas écrasée", async () => {
    const d = await docs();
    gh.external("content/livre-dor.json", JSON.stringify({ note: "", entries: ["écrit ailleurs"] }, null, 2) + "\n");
    const r = await call("POST", "save", { cookie, json: { docs: { gold: d.gold } } });
    assert.equal(r.status, 409);
    assert.match(r.data.message, /modifié/);
  });

  test("un commit extérieur sur un autre fichier n'empêche pas d'enregistrer", async () => {
    const d = await docs();
    gh.external("README.md", "autre");
    d.site.data.phone = "06 00 00 00 00";
    const r = await call("POST", "save", { cookie, json: { docs: { site: d.site }, summary: "téléphone" } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(JSON.parse(gh.read("content/site.json")).phone, "06 00 00 00 00");
    assert.equal(gh.read("README.md"), "autre");
  });

  test("textes : blocs → markdown → blocs, sans perte, et un tiret de dialogue reste un paragraphe", async () => {
    const d = await docs();
    d.demarche.data.blocks.push({ type: "p", text: "— Un paragraphe qui commence par un tiret." });
    d.demarche.data.blocks.push({ type: "p", text: "Premier.\n\nSecond, tapé dans le même bloc." });
    const r = await call("POST", "save", { cookie, json: { docs: { demarche: d.demarche }, summary: "démarche" } });
    assert.equal(r.status, 200);
    const back = content.mdToBlocks(gh.read("content/texts/demarche.md"));
    assert.equal(back.signature, "", "pas de fausse signature");
    assert.equal(back.blocks.at(-3).text, "— Un paragraphe qui commence par un tiret.");
    assert.equal(back.blocks.at(-2).text, "Premier.");
    assert.equal(back.blocks.at(-1).text, "Second, tapé dans le même bloc.");
  });
});

describe("œuvres et images", () => {
  let upload;

  test("envoi d'une photo : dérivés identiques à ceux du build", async () => {
    const jpg = fs.readFileSync(path.join(ROOT, "assets/originals/aller-retour-i.jpg"));
    const r = await call("POST", "upload", { cookie, blob: jpg, params: { kind: "work", name: "Géométrie nouvelle" } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    upload = r.data;
    assert.match(upload.file, /^geometrie-nouvelle-[0-9a-f]{6}\.jpg$/);
    const names = upload.files.map((f) => f.path.replace(upload.stem, "S")).sort();
    assert.deepEqual(names, [
      "assets/originals/S.jpg", "dist/img/S-1000.jpg", "dist/img/S-1400.webp", "dist/img/S-2000.webp",
      "dist/img/S-420.webp", "dist/img/S-840.webp", "dist/img/og/S.jpg",
    ]);
    assert.equal(gh.files().has(`assets/originals/${upload.file}`), false, "rien n'est publié avant l'enregistrement");
  });

  test("une image illisible est refusée", async () => {
    const r = await call("POST", "upload", { cookie, blob: Buffer.from("pas une image"), params: { kind: "work" } });
    assert.equal(r.status, 400);
    assert.match(r.data.message, /lue/);
  });

  test("ajout d'une œuvre + mise en avant sur l'accueil : un seul commit", async () => {
    const d = await docs();
    const before = gh.commits().size;
    d.works.data.works.push({ title: "Géométrie nouvelle", group: "Aller Retour", technique: "Acrylique sur toile",
      dimensions: ["60 × 80"], note: null, short: null, description: "Une toile de 2026.\nDeuxième ligne.", file: upload.file });
    d.home.data.featured.push(`file:${upload.file}`);
    const r = await call("POST", "save", { cookie, json: {
      docs: { works: d.works, home: d.home },
      uploads: [{ file: upload.file, files: upload.files }],
      summary: "œuvre ajoutée « Géométrie nouvelle »",
    } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(gh.commits().size, before + 1);
    const works = JSON.parse(gh.read("content/works.json")).works;
    const w = works.at(-1);
    assert.equal(w.slug, "geometrie-nouvelle");
    assert.equal(w.series, "aller-retour");
    assert.equal(w.n, Math.max(...works.slice(0, -1).map((x) => x.n)) + 1);
    assert.ok(JSON.parse(gh.read("content/home.json")).featured.includes("geometrie-nouvelle"));
    for (const f of upload.files) assert.ok(gh.files().has(f.path), f.path);
    assert.match(gh.commits().get(gh.head).message, /^Admin : œuvre ajoutée/);
  });

  test("build.py produit la page de la nouvelle œuvre à partir du dépôt", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mm-build-"));
    for (const p of ["build.py", "assets", "admin"]) fs.cpSync(path.join(ROOT, p), path.join(tmp, p), { recursive: true });
    fs.cpSync(path.join(ROOT, "dist/img"), path.join(tmp, "dist/img"), { recursive: true });
    // le dépôt tel que Vercel le verra : les contenus et les images de la nouvelle œuvre
    for (const [p] of gh.files()) {
      if (p.startsWith("content/") || p.includes(upload.stem)) {
        fs.mkdirSync(path.dirname(path.join(tmp, p)), { recursive: true });
        fs.writeFileSync(path.join(tmp, p), gh.readBuf(p));
      }
    }
    // sans Pillow, comme sur Vercel : le build ne doit rien avoir à fabriquer
    const out = execFileSync("/usr/bin/python3", ["-S", "build.py"], { cwd: tmp, encoding: "utf8" });
    assert.match(out, /109 œuvres/);
    const html = fs.readFileSync(path.join(tmp, "dist/oeuvres/geometrie-nouvelle/index.html"), "utf8");
    assert.match(html, /<h1 class="work__title">Géométrie nouvelle<\/h1>/);
    assert.match(html, /Une toile de 2026\.<\/p><p>Deuxième ligne\./);
    assert.match(html, new RegExp(`/img/og/${upload.stem}\\.jpg`));
    assert.match(html, new RegExp(`/img/${upload.stem}-2000\\.webp 2000w`));
    const home = fs.readFileSync(path.join(tmp, "dist/index.html"), "utf8");
    assert.match(home, /\/oeuvres\/geometrie-nouvelle\//);
    assert.match(home, /Les 109 œuvres/);
    const index = fs.readFileSync(path.join(tmp, "dist/oeuvres/index.html"), "utf8");
    assert.match(index, /Cent neuf œuvres/);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("renommer une série renomme ses œuvres dans le même commit", async () => {
    const d = await docs();
    const g = d.series.data.groups.find((x) => x.name === "Lignes");
    g.name = "Les lignes";
    for (const w of d.works.data.works) if (w.group === "Lignes") w.group = "Les lignes";
    const r = await call("POST", "save", { cookie, json: { docs: { series: d.series, works: d.works }, summary: "renommage" } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(JSON.parse(gh.read("content/works.json")).works.filter((w) => w.group === "Les lignes").length, 4);
  });

  test("impossible de supprimer une série qui contient des œuvres", async () => {
    const d = await docs();
    d.series.data.groups = d.series.data.groups.filter((x) => x.name !== "Équinoxe");
    const r = await call("POST", "save", { cookie, json: { docs: { series: d.series } } });
    assert.equal(r.status, 400);
    assert.match(r.data.message, /série qui n'existe plus/);
  });

  test("nouvelle famille et nouvelle série, puis une œuvre dedans", async () => {
    const d = await docs();
    d.series.data.families.push({ title: "Gravures", medium: "Gravure sur papier", lede: "" });
    const r1 = await call("POST", "save", { cookie, json: { docs: { series: d.series } } });
    assert.equal(r1.status, 200, JSON.stringify(r1.data));
    const fam = JSON.parse(gh.read("content/series.json")).families.at(-1);
    assert.equal(fam.key, "gravures");
    const d2 = await docs();
    d2.series.data.groups.push({ name: "Premières gravures", family: "gravures", note: "", tall: false });
    const r2 = await call("POST", "save", { cookie, json: { docs: { series: d2.series } } });
    assert.equal(r2.status, 200);
  });

  test("supprimer une œuvre retire ses images et la retire de l'accueil", async () => {
    const d = await docs();
    d.works.data.works = d.works.data.works.filter((w) => w.slug !== "geometrie-nouvelle");
    const r = await call("POST", "save", { cookie, json: { docs: { works: d.works }, summary: "suppression" } });
    assert.equal(r.status, 200);
    for (const f of upload.files) assert.equal(gh.files().has(f.path), false, f.path);
    assert.ok(!JSON.parse(gh.read("content/home.json")).featured.includes("geometrie-nouvelle"));
    assert.ok(gh.files().has("dist/img/aller-retour-i-420.webp"), "les images voisines ne sont pas touchées");
    assert.ok(gh.files().has("dist/img/2111-v-420.webp"));
  });

  test("vues d'accrochage : ajout puis suppression", async () => {
    const jpg = fs.readFileSync(path.join(ROOT, "assets/originals/vues/atelier-de-la-page-blanche-rouen-1.jpg"));
    const up = (await call("POST", "upload", { cookie, blob: jpg, params: { kind: "view", name: "Less is more" } })).data;
    assert.match(up.file, /^vues\/less-is-more-[0-9a-f]{6}\.jpg$/);
    assert.ok(!up.files.some((f) => f.path.includes("/og/")), "pas de carte OG pour une vue");
    const d = await docs();
    d.views.data.views.unshift({ caption: "« Less is more », Espace UAP", file: up.file });
    const r = await call("POST", "save", { cookie, json: { docs: { views: d.views }, uploads: [up] } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.ok(gh.files().has(`assets/originals/${up.file}`));
    const d2 = await docs();
    d2.views.data.views.shift();
    await call("POST", "save", { cookie, json: { docs: { views: d2.views } } });
    assert.equal(gh.files().has(`assets/originals/${up.file}`), false);
  });

  test("un envoi ne peut pas écrire ailleurs que dans ses propres fichiers", async () => {
    const d = await docs();
    const w = d.works.data.works[1];
    const evil = [{ file: "piege-abc123.jpg", files: [{ path: "build.py", sha: "a".repeat(40) }] }];
    d.works.data.works.push({ ...w, slug: undefined, title: "Piège", file: "piege-abc123.jpg" });
    const r = await call("POST", "save", { cookie, json: { docs: { works: d.works }, uploads: evil } });
    assert.equal(r.status, 400);
  });
});

describe("expositions, livre d'or, critiques", () => {
  test("exposition à venir, puis passée", async () => {
    const d = await docs();
    d.exhibitions.data.upcoming.push({ sort: "2027-03", when: "Mars 2027", title: "Nouvelle exposition", venue: "Galerie", city: "Rouen", solo: true });
    let r = await call("POST", "save", { cookie, json: { docs: { exhibitions: d.exhibitions } } });
    assert.equal(r.status, 200);
    const bad = await docs();
    bad.exhibitions.data.exhibitions[0].sort = "mars";
    r = await call("POST", "save", { cookie, json: { docs: { exhibitions: bad.exhibitions } } });
    assert.equal(r.status, 400);
    assert.match(r.data.message, /mois et l'année/);
  });

  test("livre d'or et critiques", async () => {
    const d = await docs();
    d.gold.data.entries.unshift("Un mot de visiteur.");
    d.critiques.data.critiques.push({ title: "", author: "Jean Dupont", role: "critique d'art",
      blocks: [{ type: "p", text: "Premier paragraphe." }, { type: "quote", text: "Une citation." }] });
    const r = await call("POST", "save", { cookie, json: { docs: { gold: d.gold, critiques: d.critiques } } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const c = JSON.parse(gh.read("content/critiques.json")).critiques.at(-1);
    assert.equal(c.text, "Premier paragraphe.\n\n> Une citation.");
    const noAuthor = await docs();
    noAuthor.critiques.data.critiques.at(-1).author = "";
    assert.equal((await call("POST", "save", { cookie, json: { docs: { critiques: noAuthor.critiques } } })).status, 400);
  });
});

describe("statut de mise en ligne et sessions", () => {
  test("statut Vercel relayé", async () => {
    gh.setStatus(gh.head, "success");
    const r = await call("GET", "status", { cookie, params: { sha: gh.head } });
    assert.equal(r.data.state, "success");
  });

  test("un build annulé au profit d'un commit plus récent n'est pas un échec", async () => {
    const first = gh.head;
    const d = await docs();
    d.gold.data.entries.push("Encore un mot.");
    await call("POST", "save", { cookie, json: { docs: { gold: d.gold } } });
    gh.setStatus(first, "failure", "Canceled from the Vercel Dashboard");
    gh.setStatus(gh.head, "pending");
    assert.equal((await call("GET", "status", { cookie, params: { sha: first } })).data.state, "pending");
    gh.setStatus(gh.head, "success");
    assert.equal((await call("GET", "status", { cookie, params: { sha: first } })).data.state, "success");
    gh.setStatus(gh.head, "failure", "Build failed");
    assert.equal((await call("GET", "status", { cookie, params: { sha: gh.head } })).data.state, "failure");
  });

  test("un nouveau mot de passe ferme les anciennes sessions", async () => {
    const t = auth.inviteToken();
    await new Promise((r) => setTimeout(r, 5));
    const r = await call("POST", "setup", { json: { token: t, password: "une autre phrase secrète" } });
    assert.equal(r.status, 200);
    assert.equal((await call("GET", "content", { cookie })).status, 401);
    assert.equal((await call("GET", "content", { cookie: r.cookie })).status, 200);
  });
});
