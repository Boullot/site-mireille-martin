/**
 * Fabrique, à partir d'une photographie envoyée depuis l'admin, exactement les fichiers
 * que build.py fabriquerait avec Pillow : WebP 420/840/1400/2000, JPEG de repli 1000,
 * carte Open Graph 1200×630 pour une œuvre. Le build distant n'a plus qu'à écrire le HTML.
 */

import crypto from "node:crypto";
import sharp from "sharp";
import signature from "./og-signature.js";
import { Invalid, slugify } from "./content.js";

const WIDTHS = [420, 840, 1400, 2000];
const MAX_SIDE = 3000;
const MIN_SIDE = 500;

export async function derive(input, { kind, name, taken }) {
  let original;
  try {
    // rotation EXIF appliquée, métadonnées (GPS compris) retirées, sRGB
    original = await sharp(input, { failOn: "error" })
      .rotate()
      .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true })
      .toColourspace("srgb")
      .jpeg({ quality: 90, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new Invalid("Cette image n'a pas pu être lue. Utilisez une photo JPEG ou PNG.");
  }
  const ow = original.info.width;
  const oh = original.info.height;
  if (Math.max(ow, oh) < MIN_SIDE) {
    throw new Invalid(`Image trop petite (${ow} × ${oh} pixels) : il en faut au moins ${MIN_SIDE} de côté.`);
  }

  const base = (slugify(name) || (kind === "view" ? "vue" : "oeuvre")).slice(0, 48).replace(/-+$/, "");
  let stem;
  do stem = `${base}-${crypto.randomBytes(3).toString("hex")}`;
  while (taken(stem));

  const sub = kind === "view" ? "vues/" : "";
  const out = [{ path: `assets/originals/${sub}${stem}.jpg`, data: original.data }];
  const src = original.data;

  const widths = [];
  for (const w of WIDTHS) {
    if (w > ow && widths.length) break;
    widths.push(Math.min(w, ow));
  }
  await Promise.all(widths.map(async (tw) => {
    const data = await sharp(src).resize({ width: tw, kernel: "lanczos3" })
      .webp({ quality: 84, effort: 5 }).toBuffer();
    out.push({ path: `dist/img/${sub}${stem}-${tw}.webp`, data });
  }));
  const fw = Math.min(1000, ow);
  out.push({
    path: `dist/img/${sub}${stem}-${fw}.jpg`,
    data: await sharp(src).resize({ width: fw, kernel: "lanczos3" })
      .jpeg({ quality: 82, progressive: true, mozjpeg: true }).toBuffer(),
  });

  if (kind === "work") {
    const thumb = await sharp(src)
      .resize({ width: 760, height: 470, fit: "inside", withoutEnlargement: true })
      .toBuffer({ resolveWithObject: true });
    const left = Math.floor((1200 - thumb.info.width) / 2);
    const top = Math.floor((630 - thumb.info.height) / 2) - 18;
    const card = await sharp({ create: { width: 1200, height: 630, channels: 3, background: { r: 245, g: 242, b: 234 } } })
      .composite([
        { input: thumb.data, left, top },
        { input: Buffer.from(signature, "base64"), left: 0, top: 0 },
      ])
      .jpeg({ quality: 86, mozjpeg: true })
      .toBuffer();
    out.push({ path: `dist/img/og/${stem}.jpg`, data: card });
  }

  return { stem, file: `${sub}${stem}.jpg`, width: ow, height: oh, files: out };
}

/** Chemins qu'un envoi d'image a le droit d'écrire, pour une image donnée. */
export function allowedPath(path, file) {
  const m = file.match(/^(vues\/)?([a-z0-9][a-z0-9-]*)\.jpg$/);
  if (!m) return false;
  const sub = m[1] || "";
  const stem = m[2].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sub_ = sub.replace("/", "\\/");
  return new RegExp(
    `^(assets\\/originals\\/${sub_}${stem}\\.jpg|dist\\/img\\/${sub_}${stem}-\\d+\\.(webp|jpg)` +
    (sub ? "" : `|dist\\/img\\/og\\/${stem}\\.jpg`) + ")$",
  ).test(path);
}

/** Tous les fichiers du dépôt qui appartiennent à une image (pour la supprimer). */
export function filesOf(file, repoFiles) {
  return [...repoFiles.keys()].filter((p) => allowedPath(p, file));
}
