/**
 * Envoi d'e-mails par Resend (formulaire de contact, mot de passe oublié).
 * RESEND_API_KEY + MAIL_FROM (adresse d'un domaine vérifié chez Resend).
 * CONTACT_FROM est accepté comme ancien nom de MAIL_FROM.
 */

export function mailConfigured() {
  return Boolean(process.env.RESEND_API_KEY && (process.env.MAIL_FROM || process.env.CONTACT_FROM));
}

export async function sendMail({ to, subject, html, text, replyTo }) {
  if (!mailConfigured()) return false;
  const from = process.env.MAIL_FROM || process.env.CONTACT_FROM;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `Site Mireille Martin <${from}>`,
      to: Array.isArray(to) ? to : [to],
      ...(replyTo ? { reply_to: replyTo } : {}),
      subject,
      html,
      text,
    }),
  });
  if (!r.ok) {
    console.error("resend", r.status, (await r.text()).slice(0, 400));
    return false;
  }
  return true;
}

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function siteUrl(request) {
  return (process.env.SITE_URL || new URL(request.url).origin).replace(/\/+$/, "");
}
