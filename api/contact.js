/**
 * Formulaire de contact — fonction serverless Vercel.
 *
 * Variables d'environnement (voir README) :
 *   RESEND_API_KEY   clé API Resend (resend.com, offre gratuite : 3 000 envois/mois)
 *   MAIL_FROM        expéditeur d'un domaine vérifié chez Resend (ex. site@mireillemartin.com)
 *   CONTACT_TO       adresse de destination (ex. mireillemartin8@free.fr)
 *
 * Tant qu'elles ne sont pas définies, la fonction renvoie 503 et le formulaire bascule
 * automatiquement sur un lien mailto côté client.
 */

import { esc, mailConfigured, sendMail, siteUrl } from "./_lib/mail.js";

const SUBJECTS = {
  acquisition: "Acquisition d'une œuvre",
  prix: "Demande de prix",
  exposition: "Proposition d'exposition",
  presse: "Presse / publication",
  autre: "Message",
};

const seen = new Map(); // limitation de débit en mémoire (par instance)

function rateLimited(ip) {
  const now = Date.now();
  for (const [k, t] of seen) if (now - t > 3600_000) seen.delete(k);
  const hits = [...seen.keys()].filter((k) => k.startsWith(ip + "|")).length;
  if (hits >= 5) return true;
  seen.set(ip + "|" + now, now);
  return false;
}

const clean = (s, max) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const reply = (data, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request) {
  const to = process.env.CONTACT_TO;
  if (!mailConfigured() || !to) return reply({ error: "mail_not_configured" }, 503);

  const ip = (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "anon";
  if (rateLimited(ip)) return reply({ error: "too_many_requests" }, 429);

  let body;
  try { body = await request.json(); } catch { return reply({ error: "bad_json" }, 400); }
  body = body || {};

  if (clean(body.website, 10)) return reply({ ok: true }); // pot de miel

  const name = clean(body.name, 120);
  const email = clean(body.email, 160);
  const message = String(body.message ?? "").trim().slice(0, 5000);
  const work = clean(body.work, 120);
  const subject = SUBJECTS[clean(body.subject, 30)] || SUBJECTS.autre;

  if (!name || !message || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return reply({ error: "invalid_fields" }, 400);
  }

  const site = siteUrl(request);
  const workLine = work
    ? `<p style="margin:0 0 12px"><strong>Œuvre :</strong> ${esc(work)}<br>
       <a href="${esc(site)}/oeuvres/${encodeURIComponent(work)}/">Voir la fiche</a></p>`
    : "";

  const ok = await sendMail({
    to,
    replyTo: email,
    subject: `${subject} — ${name}`,
    html: `<div style="font:15px/1.6 -apple-system,Segoe UI,sans-serif;color:#14120f">
      <p style="margin:0 0 12px"><strong>${esc(name)}</strong> &lt;${esc(email)}&gt;</p>
      ${workLine}
      <p style="white-space:pre-wrap;margin:0;padding:16px;background:#f5f2ea;border-left:2px solid #c9351f">${esc(message)}</p>
      <p style="margin:20px 0 0;font-size:12px;color:#6b655c">Envoyé depuis le formulaire du site. Répondre à ce message écrit directement à ${esc(name)}.</p>
    </div>`,
    text: `${name} <${email}>\n${work ? `Œuvre : ${work}\n` : ""}\n${message}`,
  });
  return ok ? reply({ ok: true }) : reply({ error: "send_failed" }, 502);
}
