/**
 * Faux GitHub en mémoire, branché sur globalThis.fetch : juste ce que l'API admin
 * utilise (refs, commits, arbres récursifs, blobs, variables Actions, statuts).
 * Permet de tester le cycle complet — connexion, envoi d'image, enregistrement,
 * commit — sans réseau.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");
const blobSha = (buf) => sha1(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf]));

export function fakeGitHub({ root, repo = "o/r", branch = "main", paths, stubs = [] }) {
  const blobs = new Map();   // sha → Buffer
  const trees = new Map();   // sha → Map(path → blobSha)   (arbres « à plat »)
  const commits = new Map(); // sha → { tree, parents, message }
  const vars = new Map();
  const statuses = new Map();
  let head;
  const log = [];

  const putBlob = (buf) => { const s = blobSha(buf); blobs.set(s, buf); return s; };
  const putTree = (map) => {
    const s = sha1("tree" + [...map].sort().map(([p, b]) => p + b).join("|"));
    trees.set(s, new Map(map));
    return s;
  };

  // état initial : les fichiers demandés du vrai dépôt
  const initial = new Map();
  for (const p of paths) initial.set(p, putBlob(fs.readFileSync(path.join(root, p))));
  for (const p of stubs) initial.set(p, putBlob(Buffer.from(`stub:${p}`)));
  const t0 = putTree(initial);
  head = sha1("c0");
  commits.set(head, { tree: t0, parents: [], message: "init" });

  const ok = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  const nope = (status) => new Response(JSON.stringify({ message: "nope" }), { status });

  async function handle(method, url, body) {
    const u = new URL(url);
    const p = u.pathname.replace(`/repos/${repo}`, "");
    log.push(`${method} ${p}`);
    let m;
    if (method === "GET" && p === `/git/ref/heads/${branch}`) return ok({ object: { sha: head } });
    if (method === "GET" && (m = p.match(/^\/git\/commits\/(\w+)$/))) {
      const c = commits.get(m[1]);
      return c ? ok({ sha: m[1], tree: { sha: c.tree } }) : nope(404);
    }
    if (method === "GET" && (m = p.match(/^\/git\/trees\/(\w+)$/))) {
      const t = trees.get(m[1]);
      return ok({ sha: m[1], truncated: false, tree: [...t].map(([path, sha]) => ({ path, sha, type: "blob" })) });
    }
    if (method === "GET" && (m = p.match(/^\/git\/blobs\/(\w+)$/))) {
      const b = blobs.get(m[1]);
      return b ? ok({ content: b.toString("base64"), encoding: "base64" }) : nope(404);
    }
    if (method === "POST" && p === "/git/blobs") return ok({ sha: putBlob(Buffer.from(body.content, "base64")) }, 201);
    if (method === "POST" && p === "/git/trees") {
      const map = new Map(trees.get(body.base_tree));
      for (const e of body.tree) {
        if (e.sha === null) map.delete(e.path);
        else if ("content" in e) map.set(e.path, putBlob(Buffer.from(e.content, "utf8")));
        else { if (!blobs.has(e.sha)) return nope(422); map.set(e.path, e.sha); }
      }
      return ok({ sha: putTree(map) }, 201);
    }
    if (method === "POST" && p === "/git/commits") {
      const s = sha1("c" + commits.size + body.tree + body.message);
      commits.set(s, { tree: body.tree, parents: body.parents, message: body.message });
      return ok({ sha: s }, 201);
    }
    if (method === "PATCH" && p === `/git/refs/heads/${branch}`) {
      const c = commits.get(body.sha);
      if (!body.force && c.parents[0] !== head) return nope(422);
      head = body.sha;
      return ok({ object: { sha: head } });
    }
    if (method === "GET" && (m = p.match(/^\/commits\/(\w+)\/status$/))) {
      const st = statuses.get(m[1]);
      return ok({ state: st?.state || "pending", statuses: st ? [{ context: "Vercel", state: st.state, description: st.description || "", target_url: "https://vercel.test" }] : [] });
    }
    if ((m = p.match(/^\/actions\/variables\/(\w+)$/))) {
      if (method === "GET") return vars.has(m[1]) ? ok({ name: m[1], value: vars.get(m[1]) }) : nope(404);
      if (method === "PATCH") { if (!vars.has(m[1])) return nope(404); vars.set(m[1], body.value); return new Response(null, { status: 204 }); }
    }
    if (method === "POST" && p === "/actions/variables") { vars.set(body.name, body.value); return ok({}, 201); }
    return nope(404);
  }

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).startsWith("https://api.github.com/")) {
      return handle(init.method || "GET", String(url), init.body ? JSON.parse(init.body) : null);
    }
    return realFetch(url, init);
  };

  return {
    log,
    restore: () => { globalThis.fetch = realFetch; },
    get head() { return head; },
    files() { return trees.get(commits.get(head).tree); },
    read(p) { const s = this.files().get(p); return s ? blobs.get(s).toString("utf8") : null; },
    readBuf(p) { const s = this.files().get(p); return s ? blobs.get(s) : null; },
    commits: () => commits,
    setStatus: (sha, state, description = "") => statuses.set(sha, { state, description }),
    vars,
    /** Pousse un commit « extérieur » (quelqu'un d'autre modifie le dépôt). */
    external(pathName, content) {
      const map = new Map(this.files());
      map.set(pathName, putBlob(Buffer.from(content)));
      const s = sha1("ext" + commits.size);
      commits.set(s, { tree: putTree(map), parents: [head], message: "ext" });
      head = s;
    },
  };
}
