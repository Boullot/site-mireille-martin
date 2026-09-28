/**
 * Authentification des administrateurs. ADMIN_EMAIL : une adresse, ou plusieurs séparées
 * par des virgules ; chaque compte a son propre mot de passe et ses propres sessions.
 *
 * - Mot de passe : scrypt, après un HMAC avec une clé serveur (« poivre »). Même si le
 *   hachage fuitait, il serait inutilisable sans ADMIN_SECRET.
 * - Stockage : variable Actions privée du dépôt (voir github.js), avec un numéro de
 *   version. Changer le mot de passe incrémente la version et ferme toutes les sessions.
 * - Liens d'invitation / de réinitialisation : jetons signés, datés. Un lien n'est valable
 *   que s'il a été émis après le dernier changement de mot de passe : utilisé une fois,
 *   il devient caduc.
 * - Session : cookie HttpOnly, Secure, SameSite=Strict, signé.
 */

import crypto from "node:crypto";
import { promisify } from "node:util";
import { HttpError, readVariable, writeVariable } from "./github.js";

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SESSION_DAYS = 120;
export const COOKIE = "mm_admin";

export function adminEmails() {
  const list = (process.env.ADMIN_EMAIL || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (!list.length) throw new HttpError(503, "admin_not_configured");
  return list;
}

/** Adresse normalisée si elle fait partie des comptes, sinon null. */
export function knownEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  return adminEmails().includes(e) ? e : null;
}

function secret() {
  const s = process.env.ADMIN_SECRET;
  if (!s || s.length < 32) throw new HttpError(503, "admin_not_configured");
  return s;
}

const key = (label) => crypto.createHmac("sha256", secret()).update(label).digest();
const b64u = (buf) => Buffer.from(buf).toString("base64url");

/* ------------------------------------------------------------- jetons signés */

export function sign(purpose, payload) {
  const body = b64u(JSON.stringify(payload));
  const mac = crypto.createHmac("sha256", key("token:" + purpose)).update(body).digest();
  return `${body}.${b64u(mac)}`;
}

export function verify(purpose, token) {
  if (typeof token !== "string" || token.length > 2000) return null;
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const expected = crypto.createHmac("sha256", key("token:" + purpose)).update(body).digest();
  const got = Buffer.from(mac, "base64url");
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return null;
  let p;
  try { p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return null; }
  if (!p || typeof p.exp !== "number" || p.exp < Date.now()) return null;
  return p;
}

/** Lien pour créer (ou recréer) un mot de passe. Utilisé par scripts/admin-invite.mjs. */
export function inviteToken(email = adminEmails()[0], days = 30) {
  const e = knownEmail(email);
  if (!e) throw new Error(`${email} n'est pas dans ADMIN_EMAIL`);
  return sign("setup", { e, iat: Date.now(), exp: Date.now() + days * 864e5 });
}

export function resetToken(email) {
  return sign("setup", { e: knownEmail(email), iat: Date.now(), exp: Date.now() + 3600e3, reset: 1 });
}

/* --------------------------------------------------------------- stockage
   { accounts: { "adresse": { v, salt, hash, at } } } */

const VAR = () => process.env.ADMIN_AUTH_VAR || "ADMIN_AUTH";
let cache = null; // { at, value }

async function loadAll({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < 30_000) return cache.value;
  const raw = await readVariable(VAR());
  let value = null;
  try { value = raw ? JSON.parse(raw) : null; } catch { value = null; }
  // ancien format (un seul compte à plat) : il appartient au premier compte
  if (value && value.hash) value = { accounts: { [adminEmails()[0]]: value } };
  value = value && value.accounts ? value : { accounts: {} };
  cache = { at: Date.now(), value };
  return value;
}

/** Données d'un compte, ou null s'il n'a pas encore de mot de passe. */
export async function loadAuth(email, opts) {
  const e = knownEmail(email);
  return e ? (await loadAll(opts)).accounts[e] || null : null;
}

async function hashPassword(password, salt) {
  const peppered = crypto.createHmac("sha256", key("pepper")).update(password, "utf8").digest();
  return (await scrypt(peppered, salt, 64, SCRYPT)).toString("base64");
}

export function checkPasswordRules(password) {
  if (typeof password !== "string" || password.length < 8) return "password_too_short";
  if (password.length > 200) return "password_too_long";
  return null;
}

export async function setPassword(email, password) {
  const e = knownEmail(email);
  if (!e) throw new HttpError(403, "forbidden");
  const all = await loadAll({ fresh: true });
  const salt = crypto.randomBytes(16).toString("base64");
  const account = {
    v: (all.accounts[e]?.v || 0) + 1,
    salt,
    hash: await hashPassword(password, salt),
    at: Date.now(),
  };
  const next = { accounts: { ...all.accounts, [e]: account } };
  await writeVariable(VAR(), JSON.stringify(next));
  cache = { at: Date.now(), value: next };
  return account;
}

export async function checkPassword(email, password) {
  const e = knownEmail(email);
  const auth = e ? await loadAuth(e, { fresh: true }) : null;
  // le calcul est fait même si l'adresse est fausse : même durée de réponse
  const salt = auth?.salt || "c2VsLWZpeGUtcG91ci1sZS10ZW1wcw==";
  const h = await hashPassword(String(password || "").slice(0, 200), salt);
  if (!auth) return null;
  return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(auth.hash)) ? { email: e, ...auth } : null;
}

/** Un lien d'invitation est valable s'il a été émis après le dernier mot de passe du compte. */
export async function setupAllowed(payload) {
  if (!payload || !knownEmail(payload.e)) return false;
  const auth = await loadAuth(payload.e, { fresh: true });
  return !auth || payload.iat > auth.at;
}

/* ---------------------------------------------------------------- session */

export function sessionCookie(email, auth) {
  const token = sign("session", { e: knownEmail(email), v: auth.v, exp: Date.now() + SESSION_DAYS * 864e5 });
  return cookie(token, SESSION_DAYS * 86400);
}

export function clearCookie() {
  return cookie("", 0);
}

function cookie(value, maxAge) {
  const secure = process.env.ADMIN_INSECURE_COOKIE === "1" ? "" : "; Secure";
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

export function readCookie(request) {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return v.join("=");
  }
  return null;
}

/** Renvoie la session valide ou null. */
export async function session(request) {
  const p = verify("session", readCookie(request));
  if (!p || !knownEmail(p.e)) return null; // compte retiré de ADMIN_EMAIL : session close
  const auth = await loadAuth(p.e);
  if (!auth || auth.v !== p.v) return null;
  return { email: p.e, exp: p.exp, auth };
}

/* ------------------------------------------------------ limitation de débit */

const hits = new Map();

export function rateLimit(request, bucket, max, windowMs) {
  const ip = (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "local";
  const k = `${bucket}|${ip}`;
  const now = Date.now();
  const h = hits.get(k);
  if (!h || now > h.reset) {
    hits.set(k, { n: 1, reset: now + windowMs });
    if (hits.size > 5000) hits.clear();
    return;
  }
  h.n += 1;
  if (h.n > max) throw new HttpError(429, "too_many_attempts");
}
