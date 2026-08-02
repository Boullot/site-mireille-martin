/**
 * Formulaire de contact — fonction serverless Vercel.
 *
 * Variables d'environnement à définir dans le projet Vercel :
 *   RESEND_API_KEY   clé API Resend (resend.com, offre gratuite : 3 000 envois/mois)
 *   CONTACT_TO       adresse de destination        (ex. mireillemartin8@free.fr)
 *   CONTACT_FROM     expéditeur vérifié chez Resend (ex. site@mireille-martin.fr)
 *
 * Tant que ces variables ne sont pas définies, la fonction renvoie 503 et le
 * formulaire bascule automatiquement sur un lien mailto côté client.
 */

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
  const hits = [...seen.entries()].filter(([k]) => k.startsWith(ip + "|")).length;
  if (hits >= 5) return true;
  seen.set(ip + "|" + now, now);
  return false;
}

const clean = (s, max) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const key = process.env.RESEND_API_KEY;
  const to = process.env.CONTACT_TO;
  const from = process.env.CONTACT_FROM;
  if (!key || !to || !from) {
    return res.status(503).json({ error: "mail_not_configured" });
  }

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "anon";
  if (rateLimited(ip)) return res.status(429).json({ error: "too_many_requests" });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "bad_json" }); }
  }
  body = body || {};

  if (clean(body.website, 10)) return res.status(200).json({ ok: true }); // pot de miel

  const name = clean(body.name, 120);
  const email = clean(body.email, 160);
  const message = String(body.message ?? "").trim().slice(0, 5000);
  const work = clean(body.work, 120);
  const subject = SUBJECTS[clean(body.subject, 30)] || SUBJECTS.autre;

  if (!name || !message || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return res.status(400).json({ error: "invalid_fields" });
  }

  const esc = (s) => s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const workLine = work
    ? `<p style="margin:0 0 12px"><strong>Œuvre :</strong> ${esc(work)}<br>
       <a href="https://mireille-martin.fr/oeuvres/${encodeURIComponent(work)}/">Voir la fiche</a></p>`
    : "";

  const htmlBody = `<div style="font:15px/1.6 -apple-system,Segoe UI,sans-serif;color:#14120f">
    <p style="margin:0 0 12px"><strong>${esc(name)}</strong> &lt;${esc(email)}&gt;</p>
    ${workLine}
    <p style="white-space:pre-wrap;margin:0;padding:16px;background:#f5f2ea;border-left:2px solid #c9351f">${esc(message)}</p>
    <p style="margin:20px 0 0;font-size:12px;color:#6b655c">Envoyé depuis le formulaire de mireille-martin.fr</p>
  </div>`;

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: `Site Mireille Martin <${from}>`,
        to: [to],
        reply_to: email,
        subject: `${subject} — ${name}`,
        html: htmlBody,
        text: `${name} <${email}>\n${work ? `Œuvre : ${work}\n` : ""}\n${message}`,
      }),
    });
    if (!r.ok) {
      console.error("resend", r.status, await r.text());
      return res.status(502).json({ error: "send_failed" });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(502).json({ error: "send_failed" });
  }
}
