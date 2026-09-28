/**
 * Authentification de l'administrateur (un seul compte : ADMIN_EMAIL).
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

export function adminEmail() {
  const e = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  if (!e) throw new HttpError(503, "admin_not_configured");
  return e;
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

/** Lien pour créer (ou recréer) le mot de passe. Utilisé par scripts/admin-invite.mjs. */
export function inviteToken(days = 30) {
  return sign("setup", { e: adminEmail(), iat: Date.now(), exp: Date.now() + days * 864e5 });
}

export function resetToken() {
  return sign("setup", { e: adminEmail(), iat: Date.now(), exp: Date.now() + 3600e3, reset: 1 });
}

/* --------------------------------------------------------------- stockage */

const VAR = () => process.env.ADMIN_AUTH_VAR || "ADMIN_AUTH";
let cache = null; // { at, value }

export async function loadAuth({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < 30_000) return cache.value;
  const raw = await readVariable(VAR());
  let value = null;
  try { value = raw ? JSON.parse(raw) : null; } catch { value = null; }
  cache = { at: Date.now(), value };
  return value;
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

export async function setPassword(password) {
  const current = await loadAuth({ fresh: true });
  const salt = crypto.randomBytes(16).toString("base64");
  const value = {
    v: (current?.v || 0) + 1,
    salt,
    hash: await hashPassword(password, salt),
    at: Date.now(),
  };
  await writeVariable(VAR(), JSON.stringify(value));
  cache = { at: Date.now(), value };
  return value;
}

export async function checkPassword(email, password) {
  const auth = await loadAuth({ fresh: true });
  // le calcul est fait même si l'adresse est fausse : même durée de réponse
  const salt = auth?.salt || "c2VsLWZpeGUtcG91ci1sZS10ZW1wcw==";
  const h = await hashPassword(String(password || "").slice(0, 200), salt);
  if (!auth) return null;
  const ok = crypto.timingSafeEqual(Buffer.from(h), Buffer.from(auth.hash)) &&
    String(email || "").trim().toLowerCase() === adminEmail();
  return ok ? auth : null;
}

/** Un lien d'invitation est valable s'il a été émis après le dernier mot de passe. */
export async function setupAllowed(payload) {
  if (!payload || payload.e !== adminEmail()) return false;
  const auth = await loadAuth({ fresh: true });
  return !auth || payload.iat > auth.at;
}

/* ---------------------------------------------------------------- session */

export function sessionCookie(auth) {
  const token = sign("session", { e: adminEmail(), v: auth.v, exp: Date.now() + SESSION_DAYS * 864e5 });
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
  if (!p || p.e !== adminEmail()) return null;
  const auth = await loadAuth();
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
