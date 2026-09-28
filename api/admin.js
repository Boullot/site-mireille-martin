/**
 * API de l'espace administrateur — une seule fonction Vercel, action passée en ?a=.
 *
 *   GET  session | content | status&sha=
 *   POST login | logout | setup | forgot | upload&kind=&name= | save
 *
 * Toutes les écritures passent par save : les rubriques modifiées sont validées
 * (content.js), puis écrites avec leurs images dans un seul commit. Vercel reconstruit
 * ensuite le site statique d'un bloc.
 */

import crypto from "node:crypto";
import {
  checkPassword, checkPasswordRules, clearCookie, rateLimit, resetToken, session,
  sessionCookie, setPassword, setupAllowed, verify, knownEmail,
} from "./_lib/auth.js";
import { DOCS, ORDER, Invalid, crossCheck, normalize, parseDoc, toClient } from "./_lib/content.js";
import { HttpError, commit, config, createBlob, deployState, readBlob, snapshot } from "./_lib/github.js";
import { allowedPath, filesOf } from "./_lib/images.js";
import { esc, mailConfigured, sendMail, siteUrl } from "./_lib/mail.js";

const MAX_UPLOAD = 4_300_000;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
      ...headers,
    },
  });
}

async function body(request) {
  try { return await request.json(); } catch { throw new Invalid("Requête illisible."); }
}

async function requireSession(request) {
  const s = await session(request);
  if (!s) throw new HttpError(401, "unauthenticated");
  return s;
}

/** Protection CSRF : en-tête maison (impossible en cross-origin sans CORS) + Origin. */
function sameOrigin(request) {
  if (request.headers.get("x-mm-admin") !== "1") throw new HttpError(403, "forbidden");
  const origin = request.headers.get("origin");
  if (origin && new URL(origin).host !== new URL(request.url).host) throw new HttpError(403, "forbidden");
}

const gitBlobSha = (text) => {
  const buf = Buffer.from(text, "utf8");
  return crypto.createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
};

/* ------------------------------------------------------------------ lecture */

async function content() {
  const snap = await snapshot();
  const docs = {};
  await Promise.all(Object.entries(DOCS).map(async ([name, path]) => {
    const sha = snap.files.get(path);
    if (!sha) throw new HttpError(500, "missing_doc", path);
    docs[name] = { data: toClient(name, await readBlob(sha)), base: sha };
  }));
  const { repo, branch } = config();
  return { head: snap.head, repo, branch, docs, thumbs: thumbs(snap.files) };
}

/** Pour chaque image, son plus petit dérivé WebP (les kakémonos font moins de 420 px). */
function thumbs(files) {
  const out = {};
  for (const p of files.keys()) {
    const m = p.match(/^dist\/img\/((?:vues\/)?[a-z0-9][a-z0-9-]*)-(\d+)\.webp$/);
    if (!m) continue;
    const file = `${m[1]}.jpg`;
    const w = Number(m[2]);
    if (!out[file] || w < out[file].w) out[file] = { w, path: p.slice("dist".length) };
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.path]));
}

/* -------------------------------------------------------------- écriture */

async function save(payload) {
  const wanted = payload?.docs && typeof payload.docs === "object" ? payload.docs : {};
  const names = Object.keys(wanted);
  if (!names.length || names.some((n) => !DOCS[n])) throw new Invalid("Rien à enregistrer.");
  const uploads = Array.isArray(payload.uploads) ? payload.uploads.slice(0, 40) : [];
  const summary = String(payload.summary || "modification").replace(/\s+/g, " ").slice(0, 120);

  for (let attempt = 0; attempt < 3; attempt++) {
    const snap = await snapshot();
    for (const n of names) {
      if (wanted[n].base !== snap.files.get(DOCS[n])) {
        throw new HttpError(409, "conflict",
          "Le contenu a été modifié entre-temps (depuis un autre appareil ?). La page va se recharger.");
      }
    }

    const raw = {};
    const cur = {};
    await Promise.all(ORDER.map(async (n) => { raw[n] = await readBlob(snap.files.get(DOCS[n])); }));
    for (const n of ORDER) cur[n] = parseDoc(n, raw[n]);

    const out = {};
    const nextVal = {};
    const ctx = {
      current: (n) => cur[n],
      next: (n) => nextVal[n] ?? cur[n],
      files: snap.files,
      uploads: new Set(uploads.map((u) => u?.file).filter((f) => typeof f === "string")),
    };
    for (const n of ORDER) {
      if (!wanted[n]) continue;
      out[n] = normalize(n, wanted[n].data, ctx);
      nextVal[n] = parseDoc(n, out[n]);
    }
    // une œuvre supprimée disparaît aussi de la page d'accueil
    if (out.works && !out.home) {
      const home = normalize("home", cur.home, ctx);
      if (home !== raw.home) { out.home = home; nextVal.home = parseDoc("home", home); }
    }
    if (out.works || out.series) crossCheck(ctx.next);

    const entries = [];
    for (const [n, text] of Object.entries(out)) {
      if (text !== raw[n]) entries.push({ path: DOCS[n], content: text });
    }

    // images : celles qui ne sont plus référencées sont supprimées avec leurs dérivés,
    // les nouvelles sont ajoutées — dans le même commit que le texte qui les cite
    const refs = (get) => new Set([
      ...get("works").works.map((w) => w.file),
      ...get("views").views.map((v) => v.file),
    ]);
    const before = refs(ctx.current);
    const after = refs(ctx.next);
    for (const f of before) {
      if (!after.has(f)) for (const p of filesOf(f, snap.files)) entries.push({ path: p, sha: null });
    }
    for (const u of uploads) {
      if (!after.has(u?.file) || before.has(u.file)) continue;
      for (const x of Array.isArray(u.files) ? u.files : []) {
        if (typeof x?.path !== "string" || !/^[0-9a-f]{40}$/.test(x?.sha || "") || !allowedPath(x.path, u.file)) {
          throw new Invalid("Envoi d'image invalide.");
        }
        entries.push({ path: x.path, sha: x.sha });
      }
      if (!entries.some((e) => e.path === `assets/originals/${u.file}`)) throw new Invalid("Envoi d'image incomplet.");
    }

    const bases = Object.fromEntries(names.map((n) => [n, out[n] ? gitBlobSha(out[n]) : wanted[n].base]));
    if (!entries.length) return { unchanged: true, sha: snap.head, bases };

    const sha = await commit({
      baseHead: snap.head,
      baseTree: snap.tree,
      entries,
      message: `Admin : ${summary}`,
    });
    if (sha) {
      const docs = Object.fromEntries(Object.keys(out).map((n) => [n, { data: toClient(n, out[n]), base: gitBlobSha(out[n]) }]));
      return { sha, bases, docs };
    }
  }
  throw new HttpError(409, "conflict", "Le site est en cours de modification. Réessayez dans un instant.");
}

async function upload(request, params) {
  const kind = params.get("kind") === "view" ? "view" : "work";
  const len = Number(request.headers.get("content-length") || 0);
  if (len > MAX_UPLOAD) throw new Invalid("Image trop lourde, même après réduction. Essayez une autre photo.");
  const buf = Buffer.from(await request.arrayBuffer());
  if (!buf.length || buf.length > MAX_UPLOAD) throw new Invalid("Image absente ou trop lourde.");

  const { derive } = await import("./_lib/images.js"); // sharp n'est chargé qu'ici
  const snap = await snapshot();
  const sub = kind === "view" ? "vues/" : "";
  const img = await derive(buf, {
    kind,
    name: String(params.get("name") || "").slice(0, 80),
    taken: (stem) => snap.files.has(`assets/originals/${sub}${stem}.jpg`),
  });
  const files = [];
  for (let i = 0; i < img.files.length; i += 4) {
    files.push(...await Promise.all(img.files.slice(i, i + 4).map(async (f) =>
      ({ path: f.path, sha: await createBlob(f.data) }))));
  }
  return { file: img.file, stem: img.stem, width: img.width, height: img.height, files };
}

/* ------------------------------------------------------------ authentification */

async function login(request) {
  rateLimit(request, "login", 10, 15 * 60e3);
  const { email, password } = await body(request);
  const auth = await checkPassword(email, password);
  if (!auth) {
    await new Promise((r) => setTimeout(r, 400));
    throw new HttpError(401, "bad_credentials", "Adresse e-mail ou mot de passe incorrect.");
  }
  return json({ ok: true, email: auth.email }, 200, { "Set-Cookie": sessionCookie(auth.email, auth) });
}

async function setup(request) {
  rateLimit(request, "setup", 10, 15 * 60e3);
  const { token, password } = await body(request);
  const p = verify("setup", token);
  if (!p || !(await setupAllowed(p))) {
    throw new HttpError(410, "link_expired",
      "Ce lien n'est plus valable (déjà utilisé ou expiré). Demandez-en un nouveau.");
  }
  const rule = checkPasswordRules(password);
  if (rule) throw new Invalid("Le mot de passe doit faire au moins 8 caractères.");
  const auth = await setPassword(p.e, password);
  return json({ ok: true, email: p.e }, 200, { "Set-Cookie": sessionCookie(p.e, auth) });
}

/** Changement de mot de passe, une fois connecté : l'ancien est redemandé. */
async function changePassword(request, s) {
  rateLimit(request, "password", 10, 15 * 60e3);
  const { current, password } = await body(request);
  if (!(await checkPassword(s.email, current))) {
    await new Promise((r) => setTimeout(r, 400));
    throw new HttpError(403, "bad_password", "Le mot de passe actuel n'est pas le bon.");
  }
  if (checkPasswordRules(password)) throw new Invalid("Le nouveau mot de passe doit faire au moins 8 caractères.");
  const auth = await setPassword(s.email, password);
  // les autres appareils sont déconnectés ; celui-ci reçoit une session neuve
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(s.email, auth) });
}

async function forgot(request) {
  rateLimit(request, "forgot", 4, 60 * 60e3);
  const { email } = await body(request);
  if (!mailConfigured()) return json({ ok: true, sent: false });
  const account = knownEmail(email);
  if (account) {
    const link = `${siteUrl(request)}/admin/#reinitialisation=${resetToken(account)}`;
    await sendMail({
      to: account,
      subject: "Site Mireille Martin — nouveau mot de passe",
      text: `Bonjour,\n\nPour choisir un nouveau mot de passe, ouvrez ce lien (valable une heure) :\n${link}\n\nSi vous n'avez rien demandé, ignorez ce message.`,
      html: `<div style="font:16px/1.6 -apple-system,Segoe UI,sans-serif;color:#14120f">
        <p>Bonjour,</p><p>Pour choisir un nouveau mot de passe pour l'administration du site,
        ouvrez ce lien (valable une heure) :</p>
        <p><a href="${esc(link)}" style="color:#a92a19">Choisir un nouveau mot de passe</a></p>
        <p style="color:#6b655c;font-size:14px">Si vous n'avez rien demandé, ignorez ce message.</p></div>`,
    });
  }
  return json({ ok: true, sent: true });
}

/** Diagnostic sans session : ce qui est configuré, et si sharp se charge. Aucun secret. */
async function health() {
  let sharp = null;
  try { sharp = (await import("sharp")).default.versions.sharp; } catch (err) { sharp = `erreur : ${err.message}`; }
  return {
    github: Boolean(process.env.GITHUB_TOKEN),
    secret: (process.env.ADMIN_SECRET || "").length >= 32,
    email: Boolean(process.env.ADMIN_EMAIL),
    mail: mailConfigured(),
    sharp,
  };
}

/* ------------------------------------------------------------------ routeur */

async function route(request) {
  const url = new URL(request.url);
  const a = url.searchParams.get("a");

  if (request.method === "GET") {
    if (a === "health") return json(await health());
    if (a === "session") {
      const s = await session(request);
      return json(s ? { authenticated: true, email: s.email, mail: mailConfigured() } : { authenticated: false });
    }
    await requireSession(request);
    if (a === "content") return json(await content());
    if (a === "status") {
      const sha = url.searchParams.get("sha") || "";
      if (!/^[0-9a-f]{40}$/.test(sha)) throw new Invalid("Référence invalide.");
      return json(await deployState(sha));
    }
    throw new HttpError(404, "not_found");
  }

  if (request.method !== "POST") throw new HttpError(405, "method_not_allowed");
  sameOrigin(request);
  if (a === "login") return login(request);
  if (a === "setup") return setup(request);
  if (a === "forgot") return forgot(request);
  if (a === "logout") return json({ ok: true }, 200, { "Set-Cookie": clearCookie() });

  const s = await requireSession(request);
  if (a === "password") return changePassword(request, s);
  if (a === "upload") return json(await upload(request, url.searchParams));
  if (a === "save") return json(await save(await body(request)));
  throw new HttpError(404, "not_found");
}

async function handle(request) {
  try {
    return await route(request);
  } catch (err) {
    if (err instanceof HttpError) {
      return json({ error: err.code, message: typeof err.detail === "string" ? err.detail : undefined }, err.status);
    }
    console.error(err);
    return json({ error: "server_error" }, 500);
  }
}

export const GET = handle;
export const POST = handle;
