// Charge .env.local (non versionné) dans process.env, sans dépendance.
import fs from "node:fs";
import path from "node:path";

export function loadEnv(root = path.resolve(import.meta.dirname, "..")) {
  const file = path.join(root, ".env.local");
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const m = raw.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}
