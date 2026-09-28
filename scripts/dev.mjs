/**
 * Serveur local : sert dist/ comme Vercel (URL propres) et les fonctions api/*.js.
 *
 *   python3 build.py && npm run dev      →  http://localhost:3000
 *
 * Lit .env.local. Les cookies de session y sont posés sans « Secure » (http).
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { loadEnv } from "./env.mjs";

loadEnv();
process.env.ADMIN_INSECURE_COOKIE = "1";
const ROOT = path.resolve(import.meta.dirname, "..");
const DIST = path.join(ROOT, "dist");
const PORT = Number(process.env.PORT || 3000);
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".webp": "image/webp", ".xml": "application/xml", ".txt": "text/plain", ".webmanifest": "application/manifest+json" };

async function api(req, res, name) {
  const file = path.join(ROOT, "api", `${name}.js`);
  if (!/^[a-z-]+$/.test(name) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
  const mod = await import(file);
  const handler = mod[req.method];
  if (!handler) { res.writeHead(405).end(); return; }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const request = new Request(`http://${req.headers.host}${req.url}`, {
    method: req.method,
    headers: Object.entries(req.headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]])),
    body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks),
  });
  const response = await handler(request);
  const headers = {};
  response.headers.forEach((v, k) => { headers[k] = v; });
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}

function serve(req, res) {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p.endsWith("/")) p += "index.html";
  let file = path.join(DIST, p);
  if (!file.startsWith(DIST)) { res.writeHead(403).end(); return; }
  if (!fs.existsSync(file) && fs.existsSync(file + ".html")) file += ".html";
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    if (fs.existsSync(path.join(file, "index.html"))) { res.writeHead(308, { Location: p + "/" }).end(); return; }
    res.writeHead(404, { "Content-Type": TYPES[".html"] }).end(fs.readFileSync(path.join(DIST, "404.html")));
    return;
  }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

http.createServer((req, res) => {
  const m = req.url.match(/^\/api\/([a-z-]+)\/?(\?.*)?$/);
  (m ? api(req, res, m[1]) : Promise.resolve(serve(req, res))).catch((err) => {
    console.error(err);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
}).listen(PORT, () => console.log(`→ http://localhost:${PORT}  (admin : /admin/)`));
