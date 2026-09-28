/**
 * Génère le lien qui permet à l'administrateur de créer (ou recréer) son mot de passe.
 *
 *   npm run invite                              premier compte de ADMIN_EMAIL, 30 jours
 *   npm run invite -- leo.parleur@icloud.com    un autre compte (listé dans ADMIN_EMAIL)
 *   npm run invite -- leo.parleur@icloud.com 7  valable 7 jours
 *
 * Besoin de ADMIN_SECRET, ADMIN_EMAIL et SITE_URL (dans .env.local, identiques à Vercel).
 * Le lien ne sert qu'une fois : dès que le mot de passe est créé, il devient caduc.
 * Il ne change rien tant qu'il n'est pas utilisé ; l'ancien mot de passe reste valable.
 */
import { loadEnv } from "./env.mjs";

loadEnv();
const { inviteToken } = await import("../api/_lib/auth.js");
const args = process.argv.slice(2);
const email = args.find((a) => a.includes("@")) || process.env.ADMIN_EMAIL.split(",")[0].trim();
const days = Number(args.find((a) => /^\d+$/.test(a)) || 30);
const site = (process.env.SITE_URL || "http://localhost:3000").replace(/\/+$/, "");
console.log(`${site}/admin/#invitation=${inviteToken(email, days)}`);
console.log(`\nPour ${email}, valable ${days} jours, utilisable une seule fois.`);
