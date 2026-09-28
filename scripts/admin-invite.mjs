/**
 * Génère le lien qui permet à l'administrateur de créer (ou recréer) son mot de passe.
 *
 *   npm run invite            lien valable 30 jours
 *   npm run invite -- 7       lien valable 7 jours
 *
 * Besoin de ADMIN_SECRET, ADMIN_EMAIL et SITE_URL (dans .env.local, identiques à Vercel).
 * Le lien ne sert qu'une fois : dès que le mot de passe est créé, il devient caduc.
 * Il ne change rien tant qu'il n'est pas utilisé ; l'ancien mot de passe reste valable.
 */
import { loadEnv } from "./env.mjs";

loadEnv();
const { inviteToken } = await import("../api/_lib/auth.js");
const days = Number(process.argv[2] || 30);
const site = (process.env.SITE_URL || "http://localhost:3000").replace(/\/+$/, "");
console.log(`${site}/admin/#invitation=${inviteToken(days)}`);
console.log(`\nPour ${process.env.ADMIN_EMAIL}, valable ${days} jours, utilisable une seule fois.`);
