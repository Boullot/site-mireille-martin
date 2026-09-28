/**
 * Accès au dépôt GitHub : c'est la base de données du site.
 *
 * Chaque enregistrement de l'administration devient UN commit sur la branche publiée.
 * Vercel reconstruit alors le site statique : le contenu reste du HTML écrit en dur,
 * jamais chargé après coup. Un commit raté ne touche à rien, un build raté laisse la
 * version précédente en ligne.
 */

const API = "https://api.github.com";

export function config() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO || "Boullot/site-mireille-martin";
  const branch = process.env.GITHUB_BRANCH || "main";
  if (!token) throw new HttpError(503, "github_not_configured");
  return { token, repo, branch };
}

export class HttpError extends Error {
  constructor(status, code, detail) {
    super(code);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export async function gh(method, path, body, { allow = [] } = {}) {
  const { token } = config();
  const r = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "site-mireille-martin-admin",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (allow.includes(r.status)) return { status: r.status, data: null };
  const text = await r.text();
  if (!r.ok) {
    console.error("github", method, path, r.status, text.slice(0, 400));
    throw new HttpError(r.status === 409 || r.status === 422 ? 409 : 502, "github_error",
      { status: r.status, path });
  }
  return { status: r.status, data: text ? JSON.parse(text) : null };
}

const repoPath = () => `/repos/${config().repo}`;

/** État courant de la branche : sha du commit, sha de l'arbre, index chemin → sha de blob. */
export async function snapshot() {
  const { branch } = config();
  const ref = (await gh("GET", `${repoPath()}/git/ref/heads/${encodeURIComponent(branch)}`)).data;
  const head = ref.object.sha;
  const commit = (await gh("GET", `${repoPath()}/git/commits/${head}`)).data;
  const tree = (await gh("GET", `${repoPath()}/git/trees/${commit.tree.sha}?recursive=1`)).data;
  if (tree.truncated) throw new HttpError(502, "tree_truncated");
  const files = new Map();
  for (const e of tree.tree) if (e.type === "blob") files.set(e.path, e.sha);
  return { head, tree: commit.tree.sha, files };
}

const blobCache = new Map(); // un blob est immuable : son sha est son contenu

export async function readBlob(sha) {
  if (blobCache.has(sha)) return blobCache.get(sha);
  const b = (await gh("GET", `${repoPath()}/git/blobs/${sha}`)).data;
  const text = Buffer.from(b.content, "base64").toString("utf8");
  if (blobCache.size > 200) blobCache.clear();
  blobCache.set(sha, text);
  return text;
}

export async function createBlob(buffer) {
  const b = (await gh("POST", `${repoPath()}/git/blobs`, {
    content: buffer.toString("base64"),
    encoding: "base64",
  })).data;
  return b.sha;
}

/**
 * Écrit un commit sur la branche. entries : [{path, content}] (texte), [{path, sha}]
 * (blob déjà envoyé) ou [{path, sha: null}] (suppression).
 * Refuse d'écraser un commit arrivé entre-temps (force: false) : l'appelant relit et recommence.
 */
export async function commit({ baseHead, baseTree, entries, message }) {
  const { branch } = config();
  const tree = (await gh("POST", `${repoPath()}/git/trees`, {
    base_tree: baseTree,
    tree: entries.map((e) => ({
      path: e.path,
      mode: "100644",
      type: "blob",
      ...("content" in e ? { content: e.content } : { sha: e.sha }),
    })),
  })).data;
  const author = {
    name: "Espace administrateur",
    email: "admin@mireillemartin.com",
    date: new Date().toISOString(),
  };
  const c = (await gh("POST", `${repoPath()}/git/commits`, {
    message,
    tree: tree.sha,
    parents: [baseHead],
    author,
    committer: author,
  })).data;
  const r = await gh("PATCH", `${repoPath()}/git/refs/heads/${encodeURIComponent(branch)}`,
    { sha: c.sha, force: false }, { allow: [409, 422] });
  if (r.status === 409 || r.status === 422) return null; // la branche a bougé
  return c.sha;
}

async function commitState(sha) {
  const s = (await gh("GET", `${repoPath()}/commits/${sha}/status`)).data;
  const v = (s.statuses || []).find((x) => /vercel/i.test(x.context));
  if (!v) return { state: "queued" };
  // pending | success | failure | error
  return { state: v.state, url: v.target_url || null, canceled: /cancel/i.test(v.description || "") };
}

/**
 * État de la mise en ligne d'un commit, tel que Vercel le publie sur GitHub.
 * Deux enregistrements rapprochés : Vercel annule le build du premier (statut
 * « failure », description « Canceled ») au profit du second, qui contient les deux
 * modifications. Ce n'est pas un échec : on suit alors le commit le plus récent.
 */
export async function deployState(sha) {
  const st = await commitState(sha);
  if (st.state !== "failure" || !st.canceled) return st;
  const { branch } = config();
  const head = (await gh("GET", `${repoPath()}/git/ref/heads/${encodeURIComponent(branch)}`)).data.object.sha;
  if (head === sha) return st;
  const next = await commitState(head);
  return next.state === "failure" && next.canceled ? { state: "pending" } : next;
}

/* ---------------------------------------------------------------- variables
   Le hachage du mot de passe vit dans une variable Actions du dépôt : privée
   (lisible seulement avec un jeton d'écriture), hors de l'historique git, et sans
   service supplémentaire à maintenir. */

export async function readVariable(name) {
  const r = await gh("GET", `${repoPath()}/actions/variables/${name}`, null, { allow: [404] });
  return r.status === 404 ? null : r.data.value;
}

export async function writeVariable(name, value) {
  const r = await gh("PATCH", `${repoPath()}/actions/variables/${name}`, { name, value },
    { allow: [404] });
  if (r.status === 404) await gh("POST", `${repoPath()}/actions/variables`, { name, value });
}
