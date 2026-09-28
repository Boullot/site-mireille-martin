/* Administration du site de Mireille Martin.
 *
 * Une seule page, sans dépendance. Tout passe par /api/admin :
 *   - lecture : le contenu actuel du dépôt (pas celui du site en ligne, qui peut avoir
 *     une minute de retard) ;
 *   - écriture : chaque « Enregistrer » envoie la rubrique entière, le serveur la valide
 *     et l'écrit dans un commit ; Vercel reconstruit le site statique, et le bandeau
 *     « Publication » suit la mise en ligne jusqu'au bout.
 */

const $ = (sel, root = document) => root.querySelector(sel);
const app = document.getElementById("app");

/* =============================================================== outils DOM */

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else if (k === "checked") el.checked = Boolean(v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const clone = (x) => JSON.parse(JSON.stringify(x));
let uid = 0;
const id = (p = "f") => `${p}${++uid}`;

function field(label, control, hint) {
  if (!control.id) control.id = id();
  return h("div", { class: "field" },
    h("label", { for: control.id }, label),
    control,
    hint ? h("p", { class: "hint" }, hint) : null);
}

function input(value, attrs = {}) {
  return h("input", { type: "text", value: value ?? "", autocomplete: "off", ...attrs });
}

function textarea(value, attrs = {}) {
  const t = h("textarea", { rows: 3, ...attrs });
  t.value = value ?? "";
  const fit = () => { t.style.height = "auto"; t.style.height = `${t.scrollHeight + 2}px`; };
  t.addEventListener("input", fit);
  requestAnimationFrame(fit);
  return t;
}

function select(options, value, attrs = {}) {
  const s = h("select", attrs);
  for (const o of options) {
    if (o.group) {
      s.append(h("optgroup", { label: o.group }, o.options.map((x) => h("option", { value: x.value }, x.label))));
    } else {
      s.append(h("option", { value: o.value }, o.label));
    }
  }
  if (value != null) s.value = value;
  return s;
}

function button(label, onclick, cls = "btn") {
  return h("button", { type: "button", class: cls, onclick }, label);
}

function checkbox(label, checked, hint) {
  const c = h("input", { type: "checkbox", checked, id: id() });
  const wrap = h("label", { class: "check", for: c.id }, c, h("span", {}, label));
  return { el: h("div", { class: "field" }, wrap, hint ? h("p", { class: "hint" }, hint) : null), input: c };
}

/* ----------------------------------------------------------- boîtes de dialogue */

function dialog({ title, text, ok = "Confirmer", cancel = "Annuler", danger = false }) {
  return new Promise((resolve) => {
    const d = h("dialog", { class: "modal" },
      h("h2", {}, title),
      text ? h("p", {}, text) : null,
      h("div", { class: "modal__actions" },
        cancel ? button(cancel, () => d.close("no"), "btn btn--ghost") : null,
        button(ok, () => d.close("yes"), danger ? "btn btn--danger" : "btn")));
    d.addEventListener("close", () => { d.remove(); resolve(d.returnValue === "yes"); });
    document.body.append(d);
    d.showModal();
  });
}

function toast(text, kind = "ok") {
  const t = h("div", { class: `toast toast--${kind}`, role: "status" }, text);
  document.body.append(t);
  setTimeout(() => t.classList.add("toast--out"), 3200);
  setTimeout(() => t.remove(), 3800);
}

/* ======================================================================= API */

class ApiError extends Error {
  constructor(status, data) {
    super(data?.message || data?.error || `Erreur ${status}`);
    this.status = status;
    this.data = data || {};
  }
}

async function call(method, action, { params = {}, json, blob } = {}) {
  const qs = new URLSearchParams({ a: action, ...params });
  const headers = { "x-mm-admin": "1" };
  if (json) headers["Content-Type"] = "application/json";
  if (blob) headers["Content-Type"] = blob.type || "application/octet-stream";
  let r;
  try {
    r = await fetch(`/api/admin/?${qs}`, {
      method, headers, credentials: "same-origin",
      body: json ? JSON.stringify(json) : blob,
    });
  } catch {
    throw new ApiError(0, { message: "Pas de connexion internet. Vérifiez le réseau puis réessayez." });
  }
  let data = null;
  try { data = await r.json(); } catch { /* réponse vide */ }
  if (!r.ok) {
    if (r.status === 401 && action !== "login") { showLogin("Votre session a expiré. Reconnectez-vous."); }
    if (r.status === 413) throw new ApiError(413, { message: "Image trop lourde. Essayez une autre photo." });
    throw new ApiError(r.status, data);
  }
  return data;
}

function explain(err) {
  if (err instanceof ApiError && err.data?.message) return err.data.message;
  if (err instanceof ApiError && /not_configured/.test(err.data?.error || "")) {
    return "L'espace d'administration n'est pas encore activé sur le serveur. Léo doit terminer sa mise en place.";
  }
  if (err instanceof ApiError && err.status === 429) return "Trop d'essais. Patientez un quart d'heure.";
  if (err instanceof ApiError && err.status >= 500) return "Le serveur n'a pas répondu correctement. Réessayez dans un instant ; si cela persiste, prévenez Léo.";
  return err.message || "Une erreur est survenue.";
}

/* ==================================================================== état */

const state = {
  email: "",
  mail: false,
  docs: null,     // { works: {data, base}, ... }
  repo: "",
  branch: "",
  tab: sessionStorage.getItem("mm-tab") || "oeuvres",
  thumbs: {},
  fresh: new Map(), // fichier → URL locale de l'aperçu
  dirty: false,
};
const D = (name) => state.docs[name].data;

async function loadContent() {
  const r = await call("GET", "content");
  state.docs = r.docs;
  state.repo = r.repo;
  state.branch = r.branch;
  state.thumbs = r.thumbs || {};
}

/** Retient la miniature d'une image tout juste envoyée. */
function rememberThumb(upload) {
  const webps = upload.files.map((f) => f.path.match(/-(\d+)\.webp$/)).filter(Boolean)
    .sort((a, b) => Number(a[1]) - Number(b[1]));
  if (webps.length) state.thumbs[upload.file] = webps[0].input.slice("dist".length);
  if (upload.preview) state.fresh.set(upload.file, upload.preview);
}

/**
 * Enregistre une ou plusieurs rubriques. change() modifie des copies des données ;
 * rien n'est touché localement tant que le serveur n'a pas accepté.
 *   save("gold", (doc) => …)              une rubrique : change reçoit la rubrique
 *   save(["works", "home"], (c) => …)     plusieurs : change reçoit { works, home }
 */
async function save(which, change, summary, uploads = []) {
  const names = Array.isArray(which) ? which : [which];
  const copies = Object.fromEntries(names.map((n) => [n, clone(D(n))]));
  change(Array.isArray(which) ? copies : copies[which]);
  const r = await call("POST", "save", {
    json: {
      docs: Object.fromEntries(names.map((n) => [n, { data: copies[n], base: state.docs[n].base }])),
      uploads,
      summary,
    },
  }).catch(async (err) => {
    if (err instanceof ApiError && err.status === 409) {
      await dialog({ title: "Contenu modifié ailleurs", text: explain(err), ok: "Recharger", cancel: null });
      state.dirty = false;
      await loadContent();
      render();
      throw Object.assign(err, { handled: true });
    }
    throw err;
  });
  for (const [n, d] of Object.entries(r.docs || {})) state.docs[n] = d;
  for (const [n, b] of Object.entries(r.bases || {})) if (state.docs[n]) state.docs[n].base = b;
  state.dirty = false;
  if (r.unchanged) toast("Aucun changement à publier.");
  else publish.track(r.sha);
  return r;
}

/** Bouton « Enregistrer » : état d'attente, message d'erreur sous le formulaire. */
async function withSaving(btn, errBox, fn) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Enregistrement…";
  errBox.textContent = "";
  try {
    await fn();
  } catch (err) {
    if (!err.handled) {
      errBox.textContent = explain(err);
      errBox.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

window.addEventListener("beforeunload", (ev) => {
  if (state.dirty) { ev.preventDefault(); ev.returnValue = ""; }
});

async function leaveOk() {
  if (!state.dirty) return true;
  const ok = await dialog({
    title: "Modifications non enregistrées",
    text: "Vous avez commencé une modification sans l'enregistrer. L'abandonner ?",
    ok: "Abandonner", cancel: "Continuer à modifier", danger: true,
  });
  if (ok) state.dirty = false;
  return ok;
}

function watchDirty(root) {
  root.addEventListener("input", () => { state.dirty = true; });
  root.addEventListener("change", () => { state.dirty = true; });
}

/* ============================================================ publication */

const publish = (() => {
  const KEY = "mm-admin-publish";
  let timer = null;
  let bar = null;

  function mount(el) {
    bar = el;
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(KEY) || "null"); } catch { /* */ }
    if (saved && Date.now() - saved.at < 15 * 60e3) poll(saved.sha, saved.at);
  }

  function show(kind, content) {
    if (!bar) return;
    bar.hidden = false;
    bar.className = `publish publish--${kind}`;
    bar.replaceChildren(...content);
  }

  function track(sha) {
    const at = Date.now();
    try { localStorage.setItem(KEY, JSON.stringify({ sha, at })); } catch { /* */ }
    poll(sha, at);
  }

  function poll(sha, at) {
    clearTimeout(timer);
    show("pending", [h("span", { class: "spinner", "aria-hidden": "true" }),
      h("span", {}, h("strong", {}, "Publication en cours. "),
        "Le site sera à jour dans une minute environ. Vous pouvez continuer à travailler.")]);
    const tick = async () => {
      let s;
      try { s = await call("GET", "status", { params: { sha } }); } catch { s = { state: "pending" }; }
      if (s.state === "success") {
        try { localStorage.removeItem(KEY); } catch { /* */ }
        show("ok", [h("span", { class: "dot", "aria-hidden": "true" }),
          h("span", {}, h("strong", {}, "C'est en ligne. "), "Vos modifications sont visibles sur le site. "),
          h("a", { href: "/", target: "_blank", rel: "noopener" }, "Voir le site ↗"),
          button("Fermer", () => { bar.hidden = true; }, "publish__close")]);
        return;
      }
      if (s.state === "failure" || s.state === "error") {
        try { localStorage.removeItem(KEY); } catch { /* */ }
        show("err", [h("span", { class: "dot", "aria-hidden": "true" }),
          h("span", {}, h("strong", {}, "La mise en ligne a échoué. "),
            "Le site n'a pas changé et reste en ligne tel quel. Prévenez Léo : votre modification est bien gardée, il pourra la publier."),
          button("Fermer", () => { bar.hidden = true; }, "publish__close")]);
        return;
      }
      if (Date.now() - at > 10 * 60e3) {
        show("err", [h("span", {}, h("strong", {}, "La publication prend plus de temps que prévu. "),
          "Rechargez la page dans quelques minutes pour vérifier.")]);
        return;
      }
      timer = setTimeout(tick, 5000);
    };
    timer = setTimeout(tick, 4000);
  }

  return { mount, track };
})();

/* ================================================================ images */

const IMG_MAX_SIDE = 3000;
const IMG_MAX_BYTES = 3_900_000;

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Ce format d'image n'est pas lu par ce navigateur. Enregistrez la photo en JPEG, ou choisissez-la depuis un iPhone ou un Mac."));
    img.src = url;
  });
}

/** Réduit la photo dans le navigateur : un envoi léger, même depuis un téléphone. */
async function prepare(file) {
  if (!file.type.startsWith("image/") && !/\.(jpe?g|png|heic|heif|webp|tiff?)$/i.test(file.name)) {
    throw new Error("Ce fichier n'est pas une image.");
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const w0 = img.naturalWidth;
    const h0 = img.naturalHeight;
    const k = Math.min(1, IMG_MAX_SIDE / Math.max(w0, h0));
    const w = Math.round(w0 * k);
    const h0k = Math.round(h0 * k);
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h0k;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h0k);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, w, h0k);
    for (const q of [0.92, 0.86, 0.8, 0.72, 0.64]) {
      const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", q));
      if (blob && blob.size <= IMG_MAX_BYTES) return { blob, width: w, height: h0k, small: Math.max(w0, h0) < 1400 };
    }
    throw new Error("Cette image est trop lourde.");
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Sélecteur de photo : aperçu immédiat, envoi en arrière-plan, état lisible. */
function imagePicker({ kind, name, current }) {
  const st = { upload: null, busy: null };
  const preview = h("div", { class: "picker__preview" });
  const status = h("p", { class: "picker__status", role: "status" });
  const fileInput = h("input", { type: "file", accept: "image/*", class: "sr", id: id("img") });
  const choose = h("label", { class: "btn btn--ghost", for: fileInput.id },
    current ? "Remplacer la photo" : "Choisir une photo");
  if (current) preview.append(thumbImg(current, "picker__img"));
  else preview.append(h("span", { class: "picker__empty" }, "Aucune photo"));

  fileInput.addEventListener("change", () => {
    const file = fileInput.files[0];
    fileInput.value = "";
    if (!file) return;
    st.upload = null;
    st.busy = (async () => {
      status.className = "picker__status";
      status.textContent = "Préparation de la photo…";
      choose.classList.add("is-disabled");
      try {
        const p = await prepare(file);
        const url = URL.createObjectURL(p.blob);
        preview.replaceChildren(h("img", { src: url, alt: "", class: "picker__img" }));
        status.textContent = "Envoi de la photo…";
        const r = await call("POST", "upload", { params: { kind, name: name() || "" }, blob: p.blob });
        st.upload = { file: r.file, files: r.files, url };
        rememberThumb({ ...r, preview: url });
        status.className = "picker__status is-ok";
        status.textContent = p.small
          ? "Photo prête. Elle est un peu petite : elle risque d'être floue en grand."
          : "Photo prête. Elle sera publiée à l'enregistrement.";
        state.dirty = true;
      } catch (err) {
        status.className = "picker__status is-err";
        status.textContent = explain(err);
        preview.replaceChildren(current ? thumbImg(current, "picker__img") : h("span", { class: "picker__empty" }, "Aucune photo"));
      } finally {
        choose.classList.remove("is-disabled");
        st.busy = null;
      }
    })();
  });

  const el = h("div", { class: "picker" }, preview,
    h("div", { class: "picker__side" },
      h("p", { class: "field-label" }, kind === "view" ? "Photographie" : "Photographie de l'œuvre"),
      choose, fileInput, status,
      h("p", { class: "hint" }, kind === "view"
        ? "Une vue de l'accrochage, dans le sens de la photo."
        : "Cadrez au plus près de la toile, sans le mur autour. La photo est réduite automatiquement.")));
  return {
    el,
    async ready() { if (st.busy) await st.busy; return st.upload; },
  };
}

/** Miniature d'une image du dépôt : le site en ligne d'abord, GitHub si elle vient d'arriver. */
function thumbImg(file, cls = "thumb") {
  const path = state.thumbs?.[file] || `/img/${file.replace(/\.jpg$/, "")}-420.webp`;
  const raw = () => `https://raw.githubusercontent.com/${state.repo}/${state.branch}/dist${path}`;
  // une image envoyée pendant cette visite n'est pas encore en ligne : son aperçu local
  const img = h("img", { src: state.fresh.get(file) || path, alt: "", class: cls, loading: "lazy", decoding: "async" });
  img.addEventListener("error", function fallback() {
    img.removeEventListener("error", fallback);
    if (state.repo) img.src = raw();
  });
  return img;
}

/* ======================================================= listes ordonnables */

/**
 * Mode « changer l'ordre » : flèches ↑ ↓ sur chaque ligne, puis un seul
 * enregistrement. Pas de glisser-déposer : trop capricieux au doigt.
 */
function reorder(container, items, label, onSave) {
  const order = items.slice();
  const errBox = h("p", { class: "form-error", role: "alert" });
  const listEl = h("ol", { class: "reorder" });
  const draw = () => {
    listEl.replaceChildren(...order.map((it, i) => h("li", {},
      it.thumb ? thumbImg(it.thumb) : null,
      h("span", { class: "reorder__label" }, label(it)),
      h("span", { class: "reorder__btns" },
        h("button", { type: "button", class: "icon-btn", "aria-label": "Monter", disabled: i === 0,
          onclick: () => { [order[i - 1], order[i]] = [order[i], order[i - 1]]; state.dirty = true; draw(); } }, "↑"),
        h("button", { type: "button", class: "icon-btn", "aria-label": "Descendre", disabled: i === order.length - 1,
          onclick: () => { [order[i + 1], order[i]] = [order[i], order[i + 1]]; state.dirty = true; draw(); } }, "↓")))));
  };
  draw();
  const saveBtn = h("button", { type: "button", class: "btn" }, "Enregistrer l'ordre");
  saveBtn.addEventListener("click", () => withSaving(saveBtn, errBox, async () => { await onSave(order); render(); }));
  container.replaceChildren(h("div", { class: "card card--edit" },
    h("p", { class: "hint" }, "Utilisez les flèches pour déplacer, puis enregistrez."),
    listEl, errBox,
    h("div", { class: "actions" }, saveBtn,
      button("Annuler", async () => { if (await leaveOk()) render(); }, "btn btn--ghost"))));
}

/* ========================================================== authentification */

function authShell(title, lede, form) {
  app.replaceChildren(h("main", { class: "auth" },
    h("div", { class: "auth__card" },
      h("p", { class: "wordmark" }, h("b", {}, "Mireille"), " ", h("span", {}, "Martin")),
      h("p", { class: "label" }, "Administration du site"),
      h("h1", {}, title),
      lede ? h("p", { class: "auth__lede" }, lede) : null,
      form),
    h("p", { class: "auth__back" }, h("a", { href: "/" }, "← Retour au site"))));
  $("input", app)?.focus();
}

function passwordInput(attrs) {
  const inp = h("input", { type: "password", autocomplete: "current-password", ...attrs });
  const toggle = h("button", { type: "button", class: "pw-toggle", "aria-label": "Afficher le mot de passe" }, "Afficher");
  toggle.addEventListener("click", () => {
    const show = inp.type === "password";
    inp.type = show ? "text" : "password";
    toggle.textContent = show ? "Masquer" : "Afficher";
  });
  return { inp, el: h("div", { class: "pw" }, inp, toggle) };
}

function showLogin(message) {
  const email = input("", { type: "email", autocomplete: "username", inputmode: "email", required: true, id: "login-email" });
  const pw = passwordInput({ id: "login-pw", required: true });
  const err = h("p", { class: "form-error", role: "alert" }, message || "");
  const btn = h("button", { type: "submit", class: "btn btn--wide" }, "Se connecter");
  const form = h("form", { novalidate: true },
    field("Adresse e-mail", email),
    h("div", { class: "field" }, h("label", { for: "login-pw" }, "Mot de passe"), pw.el),
    err, btn,
    h("p", { class: "auth__alt" }, button("Mot de passe oublié ?", () => showForgot(email.value), "linkish")));
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    withSaving(btn, err, async () => {
      const r = await call("POST", "login", { json: { email: email.value, password: pw.inp.value } });
      state.email = r.email;
      await start();
    });
  });
  authShell("Connexion", null, form);
}

function showForgot(prefill) {
  const email = input(prefill || "", { type: "email", autocomplete: "username", inputmode: "email" });
  const err = h("p", { class: "form-error", role: "alert" });
  const btn = h("button", { type: "submit", class: "btn btn--wide" }, "Recevoir un lien");
  const form = h("form", { novalidate: true }, field("Adresse e-mail", email), err, btn,
    h("p", { class: "auth__alt" }, button("← Revenir à la connexion", () => showLogin(), "linkish")));
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    withSaving(btn, err, async () => {
      const r = await call("POST", "forgot", { json: { email: email.value } });
      authShell("Mot de passe oublié",
        r.sent
          ? "Si cette adresse est celle de l'administration, un e-mail vient d'y être envoyé avec un lien valable une heure. Pensez à regarder dans les indésirables."
          : "L'envoi d'e-mails n'est pas encore en place sur le site. Demandez à Léo un nouveau lien pour choisir votre mot de passe.",
        h("p", {}, button("← Revenir à la connexion", () => showLogin(), "linkish")));
    });
  });
  authShell("Mot de passe oublié", "Indiquez votre adresse : vous recevrez un lien pour choisir un nouveau mot de passe.", form);
}

function tokenEmail(token) {
  try {
    const b = token.split(".")[0].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(decodeURIComponent(escape(atob(b)))).e || "";
  } catch { return ""; }
}

function showSetup(token, reset) {
  history.replaceState(null, "", location.pathname); // le jeton ne reste pas dans l'historique
  const email = tokenEmail(token);
  const pw = passwordInput({ autocomplete: "new-password", id: "setup-pw", minlength: 8 });
  const pw2 = passwordInput({ autocomplete: "new-password", id: "setup-pw2" });
  const err = h("p", { class: "form-error", role: "alert" });
  const btn = h("button", { type: "submit", class: "btn btn--wide" }, "Enregistrer mon mot de passe");
  const user = h("input", { type: "email", value: email, autocomplete: "username", readonly: true, id: "setup-email" });
  const form = h("form", { novalidate: true },
    field("Adresse e-mail", user),
    h("div", { class: "field" }, h("label", { for: "setup-pw" }, "Mot de passe"), pw.el,
      h("p", { class: "hint" }, "Au moins 8 caractères. Une petite phrase facile à retenir fait un excellent mot de passe.")),
    h("div", { class: "field" }, h("label", { for: "setup-pw2" }, "Le même, une seconde fois"), pw2.el),
    err, btn);
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    if (pw.inp.value.length < 8) { err.textContent = "Le mot de passe doit faire au moins 8 caractères."; return; }
    if (pw.inp.value !== pw2.inp.value) { err.textContent = "Les deux mots de passe ne sont pas identiques."; return; }
    withSaving(btn, err, async () => {
      const r = await call("POST", "setup", { json: { token, password: pw.inp.value } });
      state.email = r.email;
      toast("Mot de passe enregistré. Bienvenue !");
      await start();
    });
  });
  authShell(reset ? "Nouveau mot de passe" : "Bienvenue",
    reset ? "Choisissez votre nouveau mot de passe."
      : "Voici l'espace pour tenir le site à jour vous-même. Pour commencer, choisissez votre mot de passe.",
    form);
}

/* ================================================================ coquille */

const TABS = [
  ["oeuvres", "Œuvres"],
  ["series", "Séries"],
  ["accueil", "Accueil"],
  ["demarche", "Démarche"],
  ["expositions", "Expositions"],
  ["livre", "Livre d'or"],
  ["coordonnees", "Coordonnées"],
  ["aide", "Aide"],
];

let panel;

function shell() {
  const tabs = h("nav", { class: "tabs", "aria-label": "Rubriques" },
    TABS.map(([key, label]) => h("button", {
      type: "button", class: "tab", "aria-current": state.tab === key ? "page" : null,
      onclick: async () => {
        if (state.tab === key || !(await leaveOk())) return;
        state.tab = key;
        sessionStorage.setItem("mm-tab", key);
        tabs.querySelectorAll(".tab").forEach((t, i) => {
          if (TABS[i][0] === key) t.setAttribute("aria-current", "page"); else t.removeAttribute("aria-current");
        });
        render();
        window.scrollTo(0, 0);
      },
    }, label)));
  const atEnd = () => tabs.classList.toggle("at-end", tabs.scrollLeft + tabs.clientWidth >= tabs.scrollWidth - 4);
  tabs.addEventListener("scroll", atEnd, { passive: true });
  requestAnimationFrame(() => {
    atEnd();
    tabs.querySelector('[aria-current="page"]')?.scrollIntoView({ inline: "nearest", block: "nearest" });
  });
  const bar = h("div", { class: "publish", hidden: true, role: "status" });
  panel = h("main", { class: "panel wrap", id: "panel" });
  app.replaceChildren(
    h("header", { class: "top" },
      h("div", { class: "wrap top__inner" },
        h("a", { class: "wordmark", href: "/", target: "_blank", rel: "noopener" }, h("b", {}, "Mireille"), " ", h("span", {}, "Martin")),
        h("span", { class: "top__label label" }, "Administration"),
        h("span", { class: "top__links" },
          h("a", { href: "/", target: "_blank", rel: "noopener", class: "linkish" },
            h("span", { class: "long" }, "Voir le site ↗"), h("span", { class: "short" }, "Site ↗")),
          h("button", { type: "button", class: "linkish", onclick: async () => {
            if (!(await leaveOk())) return;
            await call("POST", "logout").catch(() => {});
            showLogin();
          } }, h("span", { class: "long" }, "Se déconnecter"), h("span", { class: "short" }, "Quitter")))),
      h("div", { class: "wrap" }, tabs),
      bar),
    panel);
  publish.mount(bar);
  // hauteur réelle de l'en-tête (le bandeau de publication la change) pour ce qui colle dessous
  const top = app.querySelector(".top");
  new ResizeObserver(() => document.documentElement.style.setProperty("--top-h", `${top.offsetHeight}px`)).observe(top);
}

function render() {
  const draw = PANELS[state.tab] || PANELS.oeuvres;
  panel.replaceChildren();
  draw(panel);
}

function head(title, lede, ...actions) {
  return h("div", { class: "panel__head" },
    h("div", {}, h("h1", {}, title), lede ? h("p", { class: "panel__lede" }, lede) : null),
    actions.length ? h("div", { class: "panel__actions" }, actions) : null);
}

/* =============================================================== séries

   L'administration ne connaît que des « séries ». Sur la page Œuvres, certaines sont
   regroupées sous une même section (Peintures, Encres de Chine) : cette section est
   gérée en coulisse. Une série créée ici devient sa propre section, avec son bouton
   de filtre ; sa présentation est le texte affiché sous son nom. */

const dimsLabel = (w) => (w.dimensions.length ? w.dimensions.map((d) => `${d} cm`).join(" · ") : "");

/** Les séries, dans l'ordre de la page Œuvres. */
function seriesList() {
  const s = D("series");
  return s.families.flatMap((f) => s.groups.filter((g) => g.family === f.key));
}

/** Une série seule dans sa section : sa présentation est celle de la section. */
function isSolo(doc, g) {
  return doc.groups.filter((x) => x.family === g.family).length === 1;
}

function seriesIntro(g) {
  const s = D("series");
  const f = s.families.find((x) => x.key === g.family);
  return isSolo(s, g) ? f?.lede || "" : g.note || "";
}

function seriesOptions() {
  return seriesList().map((g) => ({ value: g.name, label: g.name }));
}

function slugify(t) {
  return String(t || "").normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/œ/gi, "oe").replace(/æ/gi, "ae")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "serie";
}

/** Ajoute une série (et sa section) à une copie de series.json. */
function addSeries(doc, { name, intro = "", tall = false }) {
  let key = slugify(name).slice(0, 50);
  const taken = new Set(doc.families.map((f) => f.key));
  for (let i = 2; taken.has(key); i++) key = `${slugify(name).slice(0, 46)}-${i}`;
  doc.families.push({ key, title: name, lede: intro, medium: "" });
  doc.groups.push({ name, family: key, note: "", tall });
}

function nameTaken(name, except) {
  return D("series").groups.some((g) => g !== except && g.name.toLowerCase() === name.toLowerCase());
}

/**
 * Que devient une œuvre (ou toutes celles d'une série) qui quitte sa série ?
 * Renvoie le nom de la série d'accueil, « __delete__ », ou null si l'on annule.
 */
function chooseFate({ title, text, exclude, ok = "Confirmer" }) {
  return new Promise((resolve) => {
    const DELETE = "__delete__";
    const choices = select([
      { value: "", label: "— Choisir —" },
      { group: "La déplacer dans la série…", options: seriesOptions().filter((o) => o.value !== exclude) },
      { group: "Ou bien", options: [{ value: DELETE, label: "La supprimer du site" }] },
    ], "");
    const warn = h("p", { class: "form-error", role: "alert" });
    const okBtn = button(ok, () => {
      if (!choices.value) { warn.textContent = "Choisissez ce que devient l'œuvre."; return; }
      d.close("yes");
    }, "btn");
    const d = h("dialog", { class: "modal" },
      h("h2", {}, title),
      h("p", {}, text),
      field("Que faire de l'œuvre ?", choices,
        "Une œuvre appartient toujours à une série : sans série, elle ne pourrait pas s'afficher sur le site."),
      warn,
      h("div", { class: "modal__actions" }, button("Annuler", () => d.close("no"), "btn btn--ghost"), okBtn));
    choices.addEventListener("change", () => {
      okBtn.className = choices.value === DELETE ? "btn btn--danger" : "btn";
      warn.textContent = "";
    });
    d.addEventListener("close", () => { d.remove(); resolve(d.returnValue === "yes" ? choices.value : null); });
    document.body.append(d);
    d.showModal();
  });
}

/** Applique ce choix aux œuvres d'une copie de works.json. */
function moveOrDelete(doc, slugs, fate) {
  const set = new Set(slugs);
  if (fate === "__delete__") {
    doc.works = doc.works.filter((w) => !set.has(w.slug));
    return;
  }
  const moving = doc.works.filter((w) => set.has(w.slug)).map((w) => ({ ...w, group: fate }));
  doc.works = doc.works.filter((w) => !set.has(w.slug));
  for (const w of moving) insertInGroup(doc.works, w, (x) => x.group);
}

/* =============================================================== œuvres */

function workRow(w, featured, back) {
  return h("li", {},
    h("button", { type: "button", class: `row${state.highlight === w.file ? " row--new" : ""}`, onclick: () => editWork(w.slug, { back }) },
      thumbImg(w.file),
      h("span", { class: "row__main" },
        h("span", { class: "row__title" }, w.title, w.note ? h("span", { class: "row__ideo" }, w.note) : null),
        h("span", { class: "row__meta" }, [w.technique, dimsLabel(w)].filter(Boolean).join(" · "))),
      featured ? h("span", { class: "tag" }, "Accueil") : null,
      h("span", { class: "row__go", "aria-hidden": "true" }, "›")));
}

function reorderWorks(box, g, items) {
  reorder(box, items.map((w) => ({ ...w, thumb: w.file })), (w) => w.title,
    (order) => save("works", (doc) => {
      const slots = doc.works.map((w, i) => (w.group === g.name ? i : -1)).filter((i) => i >= 0);
      const bySlug = new Map(doc.works.map((w) => [w.slug, w]));
      slots.forEach((slot, k) => { doc.works[slot] = bySlug.get(order[k].slug); });
    }, `ordre de la série « ${g.name} »`));
}

function panelWorks(root) {
  const works = D("works").works;
  const featured = new Set(D("home").featured);
  const search = input("", { type: "search", placeholder: "Rechercher une œuvre par son titre", "aria-label": "Rechercher" });
  const listRoot = h("div", {});

  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const blocks = [];
    for (const g of seriesList()) {
      const items = works.filter((w) => w.group === g.name && (!q || w.title.toLowerCase().includes(q)));
      if (q && !items.length) continue;
      const box = h("section", { class: "group-box" });
      box.append(
        h("div", { class: "group-box__head" },
          h("h2", {}, g.name, h("span", { class: "count" }, String(items.length))),
          items.length > 1 && !q ? button("Changer l'ordre", () => reorderWorks(box, g, items), "btn btn--small btn--ghost") : null),
        items.length
          ? h("ul", { class: "rows" }, items.map((w) => workRow(w, featured.has(w.slug))))
          : h("p", { class: "empty" }, "Aucune œuvre dans cette série pour l'instant."));
      blocks.push(box);
    }
    listRoot.replaceChildren(...(blocks.length ? blocks : [h("p", { class: "empty" }, "Aucune œuvre ne correspond à cette recherche.")]));
  };
  search.addEventListener("input", draw);
  draw();

  root.append(
    head("Œuvres", `${works.length} œuvres au catalogue, rangées par série. Touchez une œuvre pour la modifier.`,
      button("+ Ajouter une œuvre", () => editWork(null))),
    h("div", { class: "searchbar" }, search),
    listRoot);
}

function dimsEditor(dims) {
  const rows = dims.map((d) => {
    const [a, b] = d.split("×").map((x) => x.trim());
    return { a, b };
  });
  const box = h("div", { class: "dims" });
  const draw = () => {
    box.replaceChildren(...rows.map((r, i) => {
      const a = input(r.a, { inputmode: "decimal", "aria-label": "Largeur en centimètres", class: "dims__n", placeholder: "60" });
      const b = input(r.b, { inputmode: "decimal", "aria-label": "Hauteur en centimètres", class: "dims__n", placeholder: "80" });
      a.addEventListener("input", () => { r.a = a.value; });
      b.addEventListener("input", () => { r.b = b.value; });
      return h("div", { class: "dims__row" }, a, h("span", {}, "×"), b, h("span", { class: "dims__unit" }, "cm"),
        h("button", { type: "button", class: "icon-btn", "aria-label": "Retirer ce format",
          onclick: () => { rows.splice(i, 1); state.dirty = true; draw(); } }, "✕"));
    }), button("+ Ajouter un format", () => { rows.push({ a: "", b: "" }); draw(); box.querySelectorAll(".dims__n")[rows.length * 2 - 2]?.focus(); }, "btn btn--small btn--ghost"));
  };
  draw();
  return {
    el: box,
    get() {
      const out = [];
      for (const r of rows) {
        const a = String(r.a || "").trim();
        const b = String(r.b || "").trim();
        if (!a && !b) continue;
        if (!/^\d+([.,]\d+)?$/.test(a) || !/^\d+([.,]\d+)?$/.test(b)) {
          throw new Error("Chaque format demande une largeur et une hauteur en chiffres (par exemple 60 et 80).");
        }
        out.push(`${a.replace(".", ",")} × ${b.replace(".", ",")}`);
      }
      return out;
    },
  };
}

function insertInGroup(list, item, groupOf) {
  let at = -1;
  list.forEach((x, i) => { if (groupOf(x) === groupOf(item)) at = i; });
  if (at < 0) list.push(item); else list.splice(at + 1, 0, item);
}

/**
 * Fiche d'une œuvre. opts.back : où revenir (par défaut la rubrique courante),
 * opts.group : série proposée pour une nouvelle œuvre.
 */
function editWork(slug, opts = {}) {
  const back = opts.back || render;
  const works = D("works").works;
  const orig = slug ? works.find((w) => w.slug === slug) : null;
  const w = orig ? clone(orig) : { title: "", group: opts.group || "", technique: "Acrylique sur toile", dimensions: [], note: "", short: "", description: "", file: "" };
  const home = D("home");
  panel.replaceChildren();
  window.scrollTo(0, 0);

  const title = input(w.title, { required: true });
  const picker = imagePicker({ kind: "work", name: () => title.value, current: w.file || null });
  const NEW = "__nouvelle__";
  const group = select([{ value: "", label: "— Choisir une série —" }, ...seriesOptions(),
    { value: NEW, label: "+ Créer une nouvelle série…" }], w.group);
  const newName = input("", { placeholder: "Par exemple : Équinoxe" });
  const newIntro = textarea("", { rows: 2, placeholder: "Facultatif : quelques mots affichés sous le nom de la série" });
  const newBox = h("div", { class: "subform", hidden: true },
    field("Nom de la nouvelle série", newName),
    field("Présentation (facultatif)", newIntro));
  group.addEventListener("change", () => { newBox.hidden = group.value !== NEW; if (!newBox.hidden) newName.focus(); });

  const techniques = [...new Set(works.map((x) => x.technique))];
  const listId = id("tech");
  const technique = input(w.technique, { list: listId });
  const dims = dimsEditor(w.dimensions);
  const note = input(w.note || "", { maxlength: 12, class: "input--short" });
  const description = textarea(w.description || "", { rows: 4 });
  const short = input(w.short || "", { maxlength: 60 });
  const feat = checkbox("Montrer cette œuvre dans « Un choix d'œuvres » sur la page d'accueil", orig && home.featured.includes(orig.slug));
  const err = h("p", { class: "form-error", role: "alert" });
  const saveBtn = h("button", { type: "button", class: "btn" }, orig ? "Enregistrer et publier" : "Ajouter l'œuvre au site");

  saveBtn.addEventListener("click", () => withSaving(saveBtn, err, async () => {
    const upload = await picker.ready();
    const t = title.value.trim();
    if (!t) throw new Error("Indiquez le titre de l'œuvre.");
    if (!orig && !upload) throw new Error("Ajoutez la photographie de l'œuvre.");
    if (!group.value) throw new Error("Choisissez la série de l'œuvre.");
    if (!technique.value.trim()) throw new Error("Indiquez la technique (par exemple : Acrylique sur toile).");
    let groupName = group.value;
    const names = ["works", "home"];
    let newSeries = null;
    if (groupName === NEW) {
      groupName = newName.value.trim();
      if (!groupName) throw new Error("Donnez un nom à la nouvelle série.");
      if (nameTaken(groupName)) throw new Error(`La série « ${groupName} » existe déjà : choisissez-la dans la liste.`);
      newSeries = { name: groupName, intro: newIntro.value.trim() };
      names.unshift("series");
    }
    const data = {
      ...w,
      title: t,
      group: groupName,
      technique: technique.value.trim(),
      dimensions: dims.get(),
      note: note.value.trim() || null,
      short: short.value.trim() || null,
      description: description.value.trim(),
      file: upload ? upload.file : w.file,
    };
    const wantFeat = feat.input.checked;
    // une œuvre nouvelle n'a pas encore de référence : le serveur résout « file:… »
    const key = orig ? orig.slug : `file:${data.file}`;
    await save(names, (c) => {
      if (newSeries) addSeries(c.series, newSeries);
      const list = c.works.works;
      if (orig) {
        const i = list.findIndex((x) => x.slug === orig.slug);
        if (orig.group === data.group) list[i] = data;
        else { list.splice(i, 1); insertInGroup(list, data, (x) => x.group); }
      } else {
        insertInGroup(list, data, (x) => x.group);
      }
      if (!wantFeat) c.home.featured = c.home.featured.filter((s) => s !== key);
      else if (!c.home.featured.includes(key)) c.home.featured.push(key);
    }, orig ? `œuvre modifiée « ${t} »` : `œuvre ajoutée « ${t} »`, upload ? [upload] : []);
    toast(orig ? "Œuvre enregistrée." : "Œuvre ajoutée. Elle sera sur le site dans une minute.");
    state.highlight = data.file;
    back();
    // retour à la liste, sur l'œuvre qui vient d'être enregistrée
    requestAnimationFrame(() => $(".row--new")?.scrollIntoView({ block: "center" }));
    setTimeout(() => { state.highlight = null; }, 0);
  }));

  const form = h("div", { class: "card card--edit" },
    picker.el,
    field("Titre", title),
    field("Série", group),
    newBox,
    field("Technique", technique),
    h("datalist", { id: listId }, techniques.map((t) => h("option", { value: t }))),
    h("div", { class: "field" }, h("p", { class: "field-label" }, "Formats (largeur × hauteur, en cm)"), dims.el,
      h("p", { class: "hint" }, "Ajoutez une ligne par format disponible. Laissez vide si le format n'est pas précisé.")),
    field("Caractère chinois (facultatif)", note, "Pour les Carrégraphies : l'idéogramme affiché à côté du titre."),
    field("Texte de présentation (facultatif)", description, "Quelques lignes affichées sur la page de l'œuvre."),
    feat.el,
    h("details", { class: "more" }, h("summary", {}, "Option avancée"),
      field("Titre court sur les vignettes", short, "Si le titre est long, une version courte pour la grille des œuvres. Sinon, laissez vide.")),
    err,
    h("div", { class: "actions" }, saveBtn,
      button("Annuler", async () => { if (await leaveOk()) back(); }, "btn btn--ghost"),
      orig ? h("a", { class: "linkish", href: `/oeuvres/${orig.slug}/`, target: "_blank", rel: "noopener" }, "Voir sur le site ↗") : null),
    orig ? h("div", { class: "danger-zone" },
      button("Supprimer cette œuvre", async () => {
        if (!(await dialog({
          title: `Supprimer « ${orig.title} » ?`,
          text: "L'œuvre et sa page disparaîtront du site. Cette action ne se défait pas depuis l'administration.",
          ok: "Supprimer", danger: true,
        }))) return;
        try {
          await save("works", (doc) => { doc.works = doc.works.filter((x) => x.slug !== orig.slug); }, `œuvre supprimée « ${orig.title} »`);
          toast("Œuvre supprimée.");
          back();
        } catch (e) { if (!e.handled) err.textContent = explain(e); }
      }, "btn btn--danger-ghost")) : null);
  watchDirty(form);

  panel.append(
    h("p", {}, button(opts.back ? "← Retour à la série" : "← Toutes les œuvres", async () => { if (await leaveOk()) back(); }, "linkish back")),
    head(orig ? orig.title : "Nouvelle œuvre", orig ? `Série : ${orig.group}` : "Remplissez la fiche, puis ajoutez l'œuvre au site."),
    form);
}

/* ------------------------------------------------------- rubrique Séries */

function panelSeries(root) {
  const works = D("works").works;
  const count = (name) => works.filter((w) => w.group === name).length;
  const newBox = h("div", {});

  const newForm = () => {
    const name = input("", { placeholder: "Par exemple : Équinoxe" });
    const intro = textarea("", { rows: 3 });
    const tall = checkbox("Vignettes hautes et étroites", false, "Pour des œuvres très verticales, comme les kakémonos.");
    const err = h("p", { class: "form-error", role: "alert" });
    const btn = h("button", { type: "button", class: "btn" }, "Créer la série");
    btn.addEventListener("click", () => withSaving(btn, err, async () => {
      const nm = name.value.trim();
      if (!nm) throw new Error("Donnez un nom à la série.");
      if (nameTaken(nm)) throw new Error(`Une série s'appelle déjà « ${nm} ».`);
      await save("series", (doc) => addSeries(doc, { name: nm, intro: intro.value.trim(), tall: tall.input.checked }), `série ajoutée « ${nm} »`);
      toast("Série créée. Ajoutez-y des œuvres depuis la rubrique Œuvres, ou ici même.");
      render();
    }));
    const form = h("div", { class: "card card--edit" },
      h("h2", {}, "Nouvelle série"),
      field("Nom de la série", name),
      field("Présentation (facultatif)", intro, "Quelques mots affichés sous le nom de la série, sur la page Œuvres."),
      tall.el, err,
      h("div", { class: "actions" }, btn, button("Annuler", async () => { if (await leaveOk()) render(); }, "btn btn--ghost")));
    watchDirty(form);
    newBox.replaceChildren(form);
    name.focus();
  };

  root.append(
    head("Séries", "Les séries de la page Œuvres. Touchez une série pour voir ses œuvres, la renommer ou la supprimer.",
      button("+ Nouvelle série", newForm)),
    newBox,
    h("section", { class: "card" }, h("ul", { class: "rows" }, seriesList().map((g) => {
      const n = count(g.name);
      const intro = seriesIntro(g);
      return h("li", {}, h("button", { type: "button", class: "row", onclick: () => seriesDetail(g.name) },
        h("span", { class: "row__main" },
          h("span", { class: "row__title" }, g.name),
          h("span", { class: "row__meta" }, `${n} œuvre${n > 1 ? "s" : ""}${intro ? " · " + (intro.length > 90 ? intro.slice(0, 90) + "…" : intro) : ""}`)),
        h("span", { class: "row__go", "aria-hidden": "true" }, "›")));
    }))));
}

function seriesDetail(name) {
  const g = D("series").groups.find((x) => x.name === name);
  if (!g) { render(); return; }
  const again = () => seriesDetail(g.name);
  const items = D("works").works.filter((w) => w.group === g.name);
  const featured = new Set(D("home").featured);
  panel.replaceChildren();
  window.scrollTo(0, 0);

  // --- nom et présentation
  const nm = input(g.name);
  const intro = textarea(seriesIntro(g), { rows: 3 });
  const tall = checkbox("Vignettes hautes et étroites", g.tall, "Pour des œuvres très verticales, comme les kakémonos.");
  const err = h("p", { class: "form-error", role: "alert" });
  const btn = h("button", { type: "button", class: "btn" }, "Enregistrer et publier");
  btn.addEventListener("click", () => withSaving(btn, err, async () => {
    const newName = nm.value.trim();
    if (!newName) throw new Error("La série doit avoir un nom.");
    if (nameTaken(newName, g)) throw new Error(`Une série s'appelle déjà « ${newName} ».`);
    await save(["series", "works"], (c) => {
      const grp = c.series.groups.find((x) => x.name === g.name);
      const fam = c.series.families.find((f) => f.key === grp.family);
      const solo = isSolo(c.series, grp);
      grp.name = newName;
      grp.tall = tall.input.checked;
      if (solo) { fam.title = newName; fam.lede = intro.value.trim(); } else grp.note = intro.value.trim();
      // les œuvres suivent le nouveau nom, dans le même enregistrement
      for (const w of c.works.works) if (w.group === g.name) w.group = newName;
    }, `série modifiée « ${newName} »`);
    toast("Série enregistrée.");
    seriesDetail(newName);
  }));
  const editCard = h("section", { class: "card card--edit" },
    field("Nom de la série", nm),
    field("Présentation", intro, "Affichée sous le nom de la série, sur la page Œuvres."),
    tall.el, err,
    h("div", { class: "actions" }, btn));
  watchDirty(editCard);

  // --- les œuvres de la série
  const listBox = h("div", {});
  const worksCard = h("section", { class: "card" },
    h("div", { class: "group-box__head" },
      h("h2", {}, "Les œuvres", h("span", { class: "count" }, String(items.length))),
      h("span", { class: "head-btns" },
        items.length > 1 ? button("Changer l'ordre", () => reorderWorks(listBox, g, items), "btn btn--small btn--ghost") : null,
        button("+ Ajouter une œuvre", async () => { if (await leaveOk()) editWork(null, { group: g.name, back: again }); }, "btn btn--small"))),
    listBox);
  listBox.append(items.length
    ? h("ul", { class: "rows" }, items.map((w) => h("li", { class: "row-with-action" },
      workRow(w, featured.has(w.slug), again).firstChild,
      button("Retirer", async () => {
        const fate = await chooseFate({
          title: `Retirer « ${w.title} » de la série ?`,
          text: `L'œuvre ne fera plus partie de « ${g.name} ».`,
          exclude: g.name,
        });
        if (!fate) return;
        try {
          await save("works", (doc) => moveOrDelete(doc, [w.slug], fate),
            fate === "__delete__" ? `œuvre supprimée « ${w.title} »` : `« ${w.title} » déplacée dans « ${fate} »`);
          toast(fate === "__delete__" ? "Œuvre supprimée." : `Œuvre déplacée dans « ${fate} ».`);
          again();
        } catch (e) { if (!e.handled) toast(explain(e), "err"); }
      }, "btn btn--small btn--ghost"))))
    : h("p", { class: "empty" }, "Aucune œuvre dans cette série pour l'instant."));

  // --- suppression
  const danger = h("div", { class: "danger-zone" }, button("Supprimer cette série", async () => {
    let fate = null;
    if (items.length) {
      if (seriesList().length < 2) { toast("C'est la seule série : elle ne peut pas être supprimée.", "err"); return; }
      fate = await chooseFate({
        title: `Supprimer la série « ${g.name} » ?`,
        text: `Elle contient ${items.length} œuvre${items.length > 1 ? "s" : ""}. Que deviennent-elles ?`,
        exclude: g.name, ok: "Supprimer la série",
      });
      if (!fate) return;
    } else if (!(await dialog({ title: `Supprimer la série « ${g.name} » ?`, text: "Elle ne contient aucune œuvre.", ok: "Supprimer", danger: true }))) {
      return;
    }
    try {
      await save(["series", "works"], (c) => {
        if (fate) moveOrDelete(c.works, items.map((w) => w.slug), fate);
        c.series.groups = c.series.groups.filter((x) => x.name !== g.name);
        // une section qui n'a plus de série disparaît avec elle
        c.series.families = c.series.families.filter((f) => c.series.groups.some((x) => x.family === f.key));
      }, `série supprimée « ${g.name} »`);
      toast("Série supprimée.");
      render();
    } catch (e) { if (!e.handled) toast(explain(e), "err"); }
  }, "btn btn--danger-ghost"));

  panel.append(
    h("p", {}, button("← Toutes les séries", async () => { if (await leaveOk()) render(); }, "linkish back")),
    head(g.name, `${items.length} œuvre${items.length > 1 ? "s" : ""}`),
    editCard, worksCard, danger);
}

/* ================================================================ accueil */

function panelHome(root) {
  const works = D("works").works;
  const home = clone(D("home"));
  const bySlug = new Map(works.map((w) => [w.slug, w]));
  const opts = seriesList().map((g) => ({
    group: g.name,
    options: works.filter((w) => w.group === g.name).map((w) => ({ value: w.slug, label: w.title })),
  })).filter((g) => g.options.length);
  const heroPreview = h("div", { class: "hero-preview" });
  const hero = select(opts, home.hero);
  const drawHero = () => heroPreview.replaceChildren(bySlug.get(hero.value) ? thumbImg(bySlug.get(hero.value).file, "hero-preview__img") : "");
  hero.addEventListener("change", () => { home.hero = hero.value; drawHero(); });
  drawHero();

  const list = h("ol", { class: "reorder" });
  const drawList = () => {
    list.replaceChildren(...home.featured.map((slug, i) => {
      const w = bySlug.get(slug);
      if (!w) return "";
      return h("li", {}, thumbImg(w.file), h("span", { class: "reorder__label" }, w.title),
        h("span", { class: "reorder__btns" },
          h("button", { type: "button", class: "icon-btn", "aria-label": "Monter", disabled: i === 0,
            onclick: () => { [home.featured[i - 1], home.featured[i]] = [home.featured[i], home.featured[i - 1]]; state.dirty = true; drawList(); } }, "↑"),
          h("button", { type: "button", class: "icon-btn", "aria-label": "Descendre", disabled: i === home.featured.length - 1,
            onclick: () => { [home.featured[i + 1], home.featured[i]] = [home.featured[i], home.featured[i + 1]]; state.dirty = true; drawList(); } }, "↓"),
          h("button", { type: "button", class: "icon-btn", "aria-label": "Retirer de l'accueil",
            onclick: () => { home.featured.splice(i, 1); state.dirty = true; drawList(); } }, "✕")));
    }));
    if (!home.featured.length) list.append(h("li", { class: "empty" }, "Aucune œuvre choisie : l'accueil montrera les premières du catalogue."));
  };
  drawList();
  const add = select([{ value: "", label: "+ Ajouter une œuvre à la sélection…" }, ...opts], "");
  add.addEventListener("change", () => {
    if (add.value && !home.featured.includes(add.value)) { home.featured.push(add.value); state.dirty = true; drawList(); }
    add.value = "";
  });
  const err = h("p", { class: "form-error", role: "alert" });
  const btn = h("button", { type: "button", class: "btn" }, "Enregistrer et publier");
  btn.addEventListener("click", () => withSaving(btn, err, async () => {
    await save("home", (c) => { c.hero = home.hero; c.featured = home.featured; }, "page d'accueil");
    toast("Page d'accueil enregistrée.");
    render();
  }));
  const card = h("div", { class: "card card--edit" },
    h("h2", {}, "L'œuvre en grand"),
    field("Œuvre affichée en haut de la page d'accueil", hero), heroPreview,
    h("h2", {}, "« Un choix d'œuvres »"),
    h("p", { class: "hint" }, "Les œuvres présentées sur la page d'accueil, dans cet ordre. Huit tombent juste sur la grille."),
    list, add, err,
    h("div", { class: "actions" }, btn));
  watchDirty(card);
  root.append(head("Page d'accueil", "Ce qui est montré en premier aux visiteurs."), card);
}

/* ============================================================= démarche */

/**
 * Champ de texte « comme sur le site » : on écrit d'un seul tenant, Entrée commence un
 * nouveau paragraphe, et deux boutons transforment la ligne en cours en intertitre ou
 * en citation. Le contenu est relu en blocs (paragraphe / intertitre / citation) au
 * moment d'enregistrer ; le collage se fait toujours en texte brut.
 */
function richEditor(blocks, { headings = true, quotes = true, label = "Texte" } = {}) {
  const TAG = { p: "P", h: "H2", quote: "BLOCKQUOTE" };
  const ed = h("div", { class: "rich", contenteditable: "true", role: "textbox", "aria-multiline": "true", "aria-label": label, spellcheck: "true" });
  const fill = (list) => {
    ed.replaceChildren();
    for (const b of list.length ? list : [{ type: "p", text: "" }]) {
      const el = document.createElement(TAG[b.type] || "P");
      if (b.text) el.textContent = b.text; else el.append(document.createElement("br"));
      ed.append(el);
    }
  };
  fill(blocks);

  /** Le bloc (enfant direct du champ) où se trouve le curseur. */
  const current = () => {
    const sel = window.getSelection();
    let n = sel && sel.rangeCount ? sel.anchorNode : null;
    if (!n || !ed.contains(n)) return null;
    while (n && n.parentNode !== ed) n = n.parentNode;
    return n;
  };
  const caretAtEnd = (el) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  };
  const setType = (type) => {
    ed.focus();
    let blk = current();
    if (!blk) { blk = ed.lastChild; }
    if (!blk) return;
    const el = document.createElement(TAG[type]);
    if (blk.nodeType === 3) el.textContent = blk.textContent;
    else while (blk.firstChild) el.append(blk.firstChild);
    if (!el.textContent) el.append(document.createElement("br"));
    blk.replaceWith(el);
    caretAtEnd(el);
    state.dirty = true;
    sync();
  };

  const tools = [["p", "Paragraphe"]];
  if (headings) tools.push(["h", "Intertitre"]);
  if (quotes) tools.push(["quote", "Citation"]);
  const btns = tools.map(([type, text]) => {
    const b = h("button", { type: "button", class: "rich__tool", "aria-pressed": "false" }, text);
    b.addEventListener("mousedown", (ev) => ev.preventDefault()); // garder le curseur dans le texte
    b.addEventListener("click", () => setType(type));
    b.dataset.type = type;
    return b;
  });
  const sync = () => {
    if (!ed.isConnected && !ed.dataset.fresh) { document.removeEventListener("selectionchange", sync); return; }
    delete ed.dataset.fresh;
    const blk = current();
    const t = blk?.nodeName === "H2" ? "h" : blk?.nodeName === "BLOCKQUOTE" ? "quote" : "p";
    for (const b of btns) b.setAttribute("aria-pressed", String(Boolean(blk) && b.dataset.type === t));
  };
  ed.dataset.fresh = "1"; // pas encore dans la page au premier appel
  document.addEventListener("selectionchange", sync);

  ed.addEventListener("focus", () => { try { document.execCommand("defaultParagraphSeparator", false, "p"); } catch { /* */ } });
  // Entrée au bout d'un intertitre ou d'une citation : on repart sur un paragraphe
  ed.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" || ev.shiftKey || ev.isComposing) return;
    const blk = current();
    if (!blk || (blk.nodeName !== "H2" && blk.nodeName !== "BLOCKQUOTE")) return;
    ev.preventDefault();
    const p = document.createElement("p");
    p.append(document.createElement("br"));
    blk.after(p);
    caretAtEnd(p);
    state.dirty = true;
    sync();
  });
  ed.addEventListener("paste", (ev) => {
    ev.preventDefault();
    const text = (ev.clipboardData || window.clipboardData).getData("text/plain");
    const parts = text.replace(/\r\n?/g, "\n").split(/\n\s*\n/);
    // un seul paragraphe collé : insertion simple ; plusieurs : autant de paragraphes
    if (parts.length === 1) { document.execCommand("insertText", false, parts[0].replace(/\n/g, " ")); return; }
    const blk = current();
    let anchor = blk;
    parts.forEach((part, i) => {
      const clean = part.replace(/\s+/g, " ").trim();
      if (!clean) return;
      if (i === 0 && anchor && anchor.nodeType === 1) { document.execCommand("insertText", false, clean); return; }
      const p = document.createElement("p");
      p.textContent = clean;
      if (anchor) anchor.after(p); else ed.append(p);
      anchor = p;
    });
    if (anchor) caretAtEnd(anchor);
    state.dirty = true;
  });

  const get = () => {
    const out = [];
    for (const n of ed.childNodes) {
      const raw = n.nodeType === 3 ? n.textContent : n.innerText ?? n.textContent;
      const type = n.nodeName === "H2" || /^H[1-6]$/.test(n.nodeName) ? "h" : n.nodeName === "BLOCKQUOTE" ? "quote" : "p";
      if (type === "p") {
        for (const line of String(raw || "").split(/\n+/)) {
          const text = line.replace(/\s+/g, " ").trim();
          if (text) out.push({ type, text });
        }
      } else {
        const text = String(raw || "").replace(/\s+/g, " ").trim();
        if (text) out.push({ type, text });
      }
    }
    return out;
  };

  const el = h("div", { class: "rich-wrap" },
    tools.length > 1 ? h("div", { class: "rich__bar", role: "toolbar", "aria-label": "Mise en forme" },
      h("span", { class: "rich__hint" }, "La ligne en cours :"), btns) : null,
    ed);
  return { el, get, focus: () => { ed.focus(); caretAtEnd(ed.lastChild || ed); } };
}

function textCard(title, lede, editor, extra, onSave) {
  const err = h("p", { class: "form-error", role: "alert" });
  const btn = h("button", { type: "button", class: "btn" }, "Enregistrer et publier");
  btn.addEventListener("click", () => withSaving(btn, err, async () => {
    if (!editor.get().length) throw new Error("Le texte est vide.");
    await onSave();
    toast("Texte enregistré.");
    render();
  }));
  const card = h("section", { class: "card card--edit" }, h("h2", {}, title), lede ? h("p", { class: "hint" }, lede) : null,
    editor.el, extra, err, h("div", { class: "actions" }, btn));
  watchDirty(card);
  return card;
}

/** Formulaire d'une critique : nouvelle (index null) ou existante. */
function critiqueForm(c, index, onCancel) {
  const author = input(c?.author || "", { autocomplete: "off" });
  const role = input(c?.role || "", { placeholder: "Par exemple : historienne de l'art" });
  const title = input(c?.title || "", { placeholder: "Facultatif" });
  const text = richEditor(c?.blocks || [], { headings: false, label: "Texte de la critique" });
  const err = h("p", { class: "form-error", role: "alert" });
  const btn = h("button", { type: "button", class: "btn" }, c ? "Enregistrer et publier" : "Publier la critique");
  btn.addEventListener("click", () => withSaving(btn, err, async () => {
    if (!author.value.trim()) throw new Error("Indiquez l'auteur de la critique.");
    const blocks = text.get();
    if (!blocks.length) throw new Error("Le texte de la critique est vide.");
    const data = { title: title.value, author: author.value, role: role.value, blocks };
    await save("critiques", (doc) => {
      if (index == null) doc.critiques.push(data); else doc.critiques[index] = data;
    }, index == null ? `critique ajoutée (${author.value.trim()})` : `critique modifiée (${author.value.trim()})`);
    toast(c ? "Critique enregistrée." : "Critique publiée.");
    render();
  }));
  const form = h("div", { class: c ? "card card--edit card--nested" : "" },
    c ? h("h3", {}, "Modifier la critique") : null,
    field("Auteur", author),
    field("Qualité de l'auteur (facultatif)", role, "Affichée après le nom, dans la signature."),
    field("Titre (facultatif)", title),
    h("div", { class: "field" }, h("p", { class: "field-label" }, "Texte"), text.el,
      h("p", { class: "hint" }, "Collez ou tapez le texte ; Entrée commence un nouveau paragraphe.")),
    err,
    h("div", { class: "actions" }, btn,
      onCancel ? button("Annuler", async () => { if (await leaveOk()) onCancel(); }, "btn btn--ghost") : null),
    c ? h("div", { class: "danger-zone" }, button("Supprimer cette critique", async () => {
      if (!(await dialog({ title: "Supprimer cette critique ?", text: `Le texte de ${c.author} disparaîtra de la page Démarche.`, ok: "Supprimer", danger: true }))) return;
      try {
        await save("critiques", (doc) => { doc.critiques.splice(index, 1); }, `critique supprimée (${c.author})`);
        toast("Critique supprimée.");
        render();
      } catch (e) { if (!e.handled) err.textContent = explain(e); }
    }, "btn btn--danger-ghost")) : null);
  watchDirty(form);
  return form;
}

function panelDemarche(root) {
  const dem = richEditor(D("demarche").blocks, { label: "Texte de la démarche" });
  const rec = richEditor(D("recit").blocks, { label: "Texte du récit" });
  const sig = input(D("recit").signature || "");
  const crits = D("critiques").critiques;

  const critList = h("ul", { class: "rows" }, crits.map((c, i) => {
    const edit = h("div", {});
    const excerpt = c.title || (c.blocks[0]?.text || "").slice(0, 80) + "…";
    return h("li", {}, h("button", { type: "button", class: "row", onclick: () => edit.replaceChildren(critiqueForm(c, i, () => edit.replaceChildren())) },
      h("span", { class: "row__main" },
        h("span", { class: "row__title" }, [c.author, c.role].filter(Boolean).join(", ")),
        h("span", { class: "row__meta" }, excerpt)),
      h("span", { class: "row__go", "aria-hidden": "true" }, "›")), edit);
  }));
  const listBox = h("div", {}, critList);

  root.append(
    head("Démarche", "Les textes de la page Démarche."),
    textCard("La démarche", "Le texte principal, écrit à la première personne. Écrivez-le comme dans un document : Entrée commence un nouveau paragraphe.", dem, null,
      () => save("demarche", (doc) => { doc.blocks = dem.get(); }, "texte de la démarche")),
    h("section", { class: "card" },
      h("h2", {}, "Critiques"),
      h("p", { class: "hint" }, crits.length
        ? "Affichées sous la démarche, dans cet ordre. Touchez une critique pour la modifier."
        : "Aucune critique pour l'instant."),
      listBox,
      crits.length > 1 ? h("div", { class: "actions" }, button("Changer l'ordre", () => reorder(listBox, crits.map((c, i) => ({ ...c, i })), (c) => c.author,
        (order) => save("critiques", (doc) => { const old = doc.critiques; doc.critiques = order.map((o) => old[o.i]); }, "ordre des critiques")), "btn btn--small btn--ghost")) : null),
    h("section", { class: "card card--edit" },
      h("h2", {}, "Ajouter une critique"),
      h("p", { class: "hint" }, "Un article, un texte de catalogue, un mot de critique : il s'ajoutera à la suite des autres."),
      critiqueForm(null, null, null)),
    textCard("Récit", "« Mireille, aller et retour », le texte d'Annette Pharamond.", rec,
      field("Signature", sig, "Affichée en bas du récit, précédée d'un tiret."),
      () => save("recit", (doc) => { doc.blocks = rec.get(); doc.signature = sig.value; }, "récit")));
}

/* ============================================================ expositions */

const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const thisMonth = () => new Date().toISOString().slice(0, 7);

function expoForm(x, where, index, box) {
  const [y0, m0] = (x?.sort || thisMonth()).split("-");
  const title = input(x?.title || "");
  const venue = input(x?.venue || "", { placeholder: "Par exemple : Espace UAP" });
  const city = input(x?.city || "", { placeholder: "Par exemple : Rouen" });
  const month = select(MONTHS.map((m, i) => ({ value: String(i + 1).padStart(2, "0"), label: m[0].toUpperCase() + m.slice(1) })), m0);
  const year = input(y0, { inputmode: "numeric", maxlength: 4, class: "input--short", "aria-label": "Année" });
  const suggest = () => `${MONTHS[Number(month.value) - 1][0].toUpperCase()}${MONTHS[Number(month.value) - 1].slice(1)} ${year.value}`;
  const when = input(x?.when || suggest());
  let touched = Boolean(x);
  when.addEventListener("input", () => { touched = true; });
  const auto = () => { if (!touched) when.value = suggest(); };
  month.addEventListener("change", auto);
  year.addEventListener("input", auto);
  const solo = checkbox("Exposition personnelle", x?.solo, "Marquée d'un filet rouge sur le site.");
  const upcoming = checkbox("À venir", where ? where === "upcoming" : false,
    "Les expositions à venir s'affichent en tête de la page Expositions et sur la page d'accueil. Décochez une fois l'exposition passée.");
  const err = h("p", { class: "form-error", role: "alert" });
  const btn = h("button", { type: "button", class: "btn" }, "Enregistrer et publier");
  btn.addEventListener("click", () => withSaving(btn, err, async () => {
    if (!title.value.trim()) throw new Error("Indiquez le titre de l'exposition.");
    if (!/^(19|20)\d{2}$/.test(year.value.trim())) throw new Error("Indiquez l'année sur quatre chiffres.");
    const data = { sort: `${year.value.trim()}-${month.value}`, when: when.value, title: title.value, venue: venue.value, city: city.value, solo: solo.input.checked };
    const to = upcoming.input.checked ? "upcoming" : "exhibitions";
    await save("exhibitions", (c) => {
      if (x) c[where].splice(index, 1);
      if (x && where === to) c[to].splice(index, 0, data);
      else if (to === "upcoming") { c.upcoming.push(data); c.upcoming.sort((a, b) => a.sort.localeCompare(b.sort)); }
      else c.exhibitions.unshift(data);
    }, x ? `exposition modifiée « ${title.value.trim()} »` : `exposition ajoutée « ${title.value.trim()} »`);
    toast("Exposition enregistrée.");
    render();
  }));
  const form = h("div", { class: "card card--edit card--nested" },
    h("h3", {}, x ? "Modifier l'exposition" : "Nouvelle exposition"),
    field("Titre", title),
    field("Lieu (facultatif)", venue),
    field("Ville (facultatif)", city),
    h("div", { class: "field" }, h("p", { class: "field-label" }, "Début de l'exposition"),
      h("div", { class: "inline" }, month, year),
      h("p", { class: "hint" }, "Sert à classer les expositions par date.")),
    field("Dates affichées", when, "Écrites telles quelles sur le site, par exemple « Mai – juin 2026 »."),
    solo.el, upcoming.el, err,
    h("div", { class: "actions" }, btn, button("Annuler", async () => { if (await leaveOk()) render(); }, "btn btn--ghost")),
    x ? h("div", { class: "danger-zone" }, button("Supprimer cette exposition", async () => {
      if (!(await dialog({ title: `Supprimer « ${x.title} » ?`, ok: "Supprimer", danger: true }))) return;
      try {
        await save("exhibitions", (c) => { c[where].splice(index, 1); }, `exposition supprimée « ${x.title} »`);
        render();
      } catch (e) { if (!e.handled) err.textContent = explain(e); }
    }, "btn btn--danger-ghost")) : null);
  watchDirty(form);
  box.replaceChildren(form);
  if (!x) title.focus();
}

function expoRow(x, where, index) {
  const edit = h("div", {});
  const past = where === "upcoming" && x.sort < thisMonth();
  return h("li", {},
    h("button", { type: "button", class: "row", onclick: () => expoForm(x, where, index, edit) },
      h("span", { class: `row__rule${x.solo ? " is-solo" : ""}`, "aria-hidden": "true" }),
      h("span", { class: "row__main" },
        h("span", { class: "row__title" }, x.title),
        h("span", { class: "row__meta" }, [x.when, [x.venue, x.city].filter(Boolean).join(", ")].filter(Boolean).join(" — "))),
      x.solo ? h("span", { class: "tag" }, "Personnelle") : null,
      h("span", { class: "row__go", "aria-hidden": "true" }, "›")),
    past ? h("p", { class: "notice" }, "Cette exposition semble passée. ",
      button("La classer dans les expositions passées", async () => {
        try {
          await save("exhibitions", (c) => { const [e] = c.upcoming.splice(index, 1); c.exhibitions.unshift(e); }, `exposition passée « ${x.title} »`);
          render();
        } catch (e) { if (!e.handled) toast(explain(e), "err"); }
      }, "linkish")) : null,
    edit);
}

function panelExpos(root) {
  const ex = D("exhibitions");
  const newBox = h("div", {});
  const years = new Map();
  ex.exhibitions.map((x, i) => ({ x, i })).sort((a, b) => b.x.sort.localeCompare(a.x.sort))
    .forEach((o) => { const y = o.x.sort.slice(0, 4); if (!years.has(y)) years.set(y, []); years.get(y).push(o); });

  root.append(
    head("Expositions", `${ex.exhibitions.length} expositions passées${ex.upcoming.length ? `, ${ex.upcoming.length} à venir` : ""}.`,
      button("+ Ajouter une exposition", () => expoForm(null, null, null, newBox))),
    newBox,
    h("section", { class: "card" }, h("h2", {}, "À venir"),
      ex.upcoming.length
        ? h("ul", { class: "rows" }, ex.upcoming.map((x, i) => expoRow(x, "upcoming", i)))
        : h("p", { class: "empty" }, "Aucune exposition annoncée. L'accueil montre alors les trois dernières.")),
    h("section", { class: "card" }, h("h2", {}, "Passées"),
      [...years].map(([y, items]) => h("div", { class: "year" }, h("h3", { class: "label" }, y),
        h("ul", { class: "rows" }, items.map((o) => expoRow(o.x, "exhibitions", o.i)))))));
  panelViews(root);
}

/* ------------------------------------------------------ vues d'accrochage */

function viewsGroups() {
  const out = [];
  for (const v of D("views").views) {
    let g = out.find((x) => x.caption === v.caption);
    if (!g) out.push(g = { caption: v.caption, items: [] });
    g.items.push(v);
  }
  return out;
}

function viewsUploader(caption, onDone) {
  const status = h("p", { class: "picker__status", role: "status" });
  const fileInput = h("input", { type: "file", accept: "image/*", multiple: true, class: "sr", id: id("views") });
  const label = h("label", { class: "btn btn--small", for: fileInput.id }, "+ Ajouter des photos");
  fileInput.addEventListener("change", async () => {
    const files = [...fileInput.files];
    fileInput.value = "";
    if (!files.length) return;
    const cap = caption();
    if (!cap) { status.className = "picker__status is-err"; status.textContent = "Indiquez d'abord la légende."; return; }
    label.classList.add("is-disabled");
    const uploads = [];
    try {
      for (const [k, f] of files.entries()) {
        status.className = "picker__status";
        status.textContent = `Préparation de la photo ${k + 1} sur ${files.length}…`;
        const p = await prepare(f);
        status.textContent = `Envoi de la photo ${k + 1} sur ${files.length}…`;
        const up = await call("POST", "upload", { params: { kind: "view", name: cap }, blob: p.blob });
        rememberThumb({ ...up, preview: URL.createObjectURL(p.blob) });
        uploads.push(up);
      }
      status.textContent = "Publication…";
      await onDone(cap, uploads.map((u) => ({ file: u.file, files: u.files })));
      toast(uploads.length > 1 ? "Photos ajoutées." : "Photo ajoutée.");
      render();
    } catch (err) {
      if (!err.handled) { status.className = "picker__status is-err"; status.textContent = explain(err); }
    } finally {
      label.classList.remove("is-disabled");
    }
  });
  return h("div", { class: "uploader" }, label, fileInput, status);
}

function panelViews(root) {
  const groups = viewsGroups();
  const newBox = h("div", {});
  const newGroup = () => {
    const cap = input("", { placeholder: "Par exemple : « Less is more », Espace UAP, Rouen, mai 2026" });
    newBox.replaceChildren(h("div", { class: "card card--edit card--nested" },
      h("h3", {}, "Nouveau groupe de photos"),
      field("Légende", cap, "Le nom de l'exposition, le lieu, la date. Elle s'affiche au-dessus des photos."),
      viewsUploader(() => cap.value.trim(), (c, uploads) => save("views", (d) => {
        d.views.unshift(...uploads.map((u) => ({ caption: c, file: u.file })));
      }, `vues ajoutées « ${c} »`, uploads)),
      h("div", { class: "actions" }, button("Annuler", () => newBox.replaceChildren(), "btn btn--ghost"))));
    cap.focus();
  };

  root.append(h("section", { class: "card" },
    h("div", { class: "group-box__head" }, h("h2", {}, "Vues d'accrochage"),
      button("+ Nouveau groupe de photos", newGroup, "btn btn--small")),
    h("p", { class: "hint" }, "Les photographies d'expositions, regroupées par légende, en bas de la page Expositions."),
    newBox,
    groups.map((g) => {
      const capEdit = h("div", {});
      return h("div", { class: "views-group" },
        h("div", { class: "group-box__head" }, h("h3", {}, g.caption),
          button("Modifier la légende", () => {
            const cap = input(g.caption);
            const err = h("p", { class: "form-error", role: "alert" });
            const btn = h("button", { type: "button", class: "btn btn--small" }, "Enregistrer");
            btn.addEventListener("click", () => withSaving(btn, err, async () => {
              if (!cap.value.trim()) throw new Error("La légende ne peut pas être vide.");
              await save("views", (d) => { for (const v of d.views) if (v.caption === g.caption) v.caption = cap.value; }, `légende « ${cap.value.trim()} »`);
              render();
            }));
            capEdit.replaceChildren(h("div", { class: "subform" }, field("Légende", cap), err,
              h("div", { class: "actions" }, btn, button("Annuler", () => capEdit.replaceChildren(), "btn btn--small btn--ghost"))));
            cap.focus();
          }, "btn btn--small btn--ghost")),
        capEdit,
        h("div", { class: "views-grid" }, g.items.map((v) => h("figure", {},
          thumbImg(v.file),
          h("button", { type: "button", class: "icon-btn views-grid__del", "aria-label": "Supprimer cette photo",
            onclick: async () => {
              if (!(await dialog({ title: "Supprimer cette photo ?", text: g.caption, ok: "Supprimer", danger: true }))) return;
              try {
                await save("views", (d) => { d.views = d.views.filter((x) => x.file !== v.file); }, `vue supprimée « ${g.caption} »`);
                render();
              } catch (e) { if (!e.handled) toast(explain(e), "err"); }
            } }, "✕")))),
        viewsUploader(() => g.caption, (c, uploads) => save("views", (d) => {
          let at = -1;
          d.views.forEach((x, i) => { if (x.caption === c) at = i; });
          d.views.splice(at + 1, 0, ...uploads.map((u) => ({ caption: c, file: u.file })));
        }, `vues ajoutées « ${c} »`, uploads)));
    })));
}

/* ============================================================ livre d'or */

function panelGold(root) {
  const entries = D("gold").entries;
  const newBox = h("div", {});
  const listBox = h("div", {});

  const form = (index, box) => {
    const t = textarea(index == null ? "" : entries[index], { rows: 4 });
    const where = index == null ? checkbox("Placer en tête du livre d'or", true) : null;
    const err = h("p", { class: "form-error", role: "alert" });
    const btn = h("button", { type: "button", class: "btn" }, "Enregistrer et publier");
    btn.addEventListener("click", () => withSaving(btn, err, async () => {
      if (!t.value.trim()) throw new Error("Le mot est vide.");
      await save("gold", (c) => {
        if (index != null) c.entries[index] = t.value;
        else if (where.input.checked) c.entries.unshift(t.value);
        else c.entries.push(t.value);
      }, index == null ? "livre d'or : mot ajouté" : "livre d'or : mot modifié");
      toast("Enregistré.");
      render();
    }));
    const f = h("div", { class: "card card--edit card--nested" },
      field(index == null ? "Nouveau mot" : "Modifier le mot", t, "Recopiez le mot tel qu'il a été écrit, sans guillemets."),
      where?.el, err,
      h("div", { class: "actions" }, btn, button("Annuler", async () => { if (await leaveOk()) render(); }, "btn btn--ghost")),
      index != null ? h("div", { class: "danger-zone" }, button("Supprimer ce mot", async () => {
        if (!(await dialog({ title: "Supprimer ce mot du livre d'or ?", ok: "Supprimer", danger: true }))) return;
        try {
          await save("gold", (c) => { c.entries.splice(index, 1); }, "livre d'or : mot supprimé");
          render();
        } catch (e) { if (!e.handled) err.textContent = explain(e); }
      }, "btn btn--danger-ghost")) : null);
    watchDirty(f);
    box.replaceChildren(f);
    t.focus();
  };

  listBox.append(h("ul", { class: "rows" }, entries.map((text, i) => {
    const edit = h("div", {});
    return h("li", {}, h("button", { type: "button", class: "row", onclick: () => form(i, edit) },
      h("span", { class: "row__main" }, h("span", { class: "row__quote" }, text)),
      h("span", { class: "row__go", "aria-hidden": "true" }, "›")), edit);
  })));

  root.append(
    head("Livre d'or", `${entries.length} mots de visiteurs.`, button("+ Ajouter un mot", () => form(null, newBox))),
    newBox,
    h("div", { class: "actions" }, button("Changer l'ordre", () => reorder(listBox, entries.map((t, i) => ({ t, i })), (e) => e.t.length > 110 ? e.t.slice(0, 110) + "…" : e.t,
      (order) => save("gold", (c) => { const old = c.entries; c.entries = order.map((o) => old[o.i]); }, "livre d'or : ordre")), "btn btn--small btn--ghost")),
    listBox);
}

/* ============================================================ coordonnées */

function panelContact(root) {
  const s = D("site");
  const email = input(s.email, { type: "email", inputmode: "email" });
  const phone = input(s.phone, { type: "tel", inputmode: "tel", placeholder: "Laisser vide pour ne pas l'afficher" });
  const insta = input(s.instagram, { placeholder: "nom du compte, sans @" });
  const credits = input(s.credits_photo);
  const err = h("p", { class: "form-error", role: "alert" });
  const btn = h("button", { type: "button", class: "btn" }, "Enregistrer et publier");
  btn.addEventListener("click", () => withSaving(btn, err, async () => {
    await save("site", (c) => { Object.assign(c, { email: email.value, phone: phone.value, instagram: insta.value, credits_photo: credits.value }); }, "coordonnées");
    toast("Coordonnées enregistrées.");
    render();
  }));
  const card = h("div", { class: "card card--edit" },
    field("Adresse e-mail affichée", email, "Visible sur la page Contact et en bas de chaque page."),
    field("Téléphone", phone, "Affiché sur la page Contact seulement s'il est rempli."),
    field("Instagram", insta),
    field("Crédit photographique", credits, "Le nom du photographe des œuvres, en bas de chaque page."),
    err, h("div", { class: "actions" }, btn));
  watchDirty(card);
  root.append(head("Coordonnées", "Les informations de contact publiées sur le site."), card);
}

/* ==================================================================== aide */

function passwordCard() {
  const cur = passwordInput({ autocomplete: "current-password", id: "pw-current" });
  const pw1 = passwordInput({ autocomplete: "new-password", id: "pw-new" });
  const pw2 = passwordInput({ autocomplete: "new-password", id: "pw-new2" });
  const err = h("p", { class: "form-error", role: "alert" });
  const btn = h("button", { type: "button", class: "btn" }, "Changer mon mot de passe");
  btn.addEventListener("click", () => withSaving(btn, err, async () => {
    if (!cur.inp.value) throw new Error("Indiquez votre mot de passe actuel.");
    if (pw1.inp.value.length < 8) throw new Error("Le nouveau mot de passe doit faire au moins 8 caractères.");
    if (pw1.inp.value !== pw2.inp.value) throw new Error("Les deux nouveaux mots de passe ne sont pas identiques.");
    await call("POST", "password", { json: { current: cur.inp.value, password: pw1.inp.value } });
    for (const x of [cur, pw1, pw2]) x.inp.value = "";
    state.dirty = false;
    toast("Mot de passe changé. Les autres appareils devront se reconnecter.");
  }));
  const card = h("section", { class: "card card--edit" },
    h("h2", {}, "Changer mon mot de passe"),
    h("p", { class: "hint" }, `Pour le compte ${state.email}. Les autres appareils connectés à ce compte seront déconnectés.`),
    h("div", { class: "field" }, h("label", { for: "pw-current" }, "Mot de passe actuel"), cur.el),
    h("div", { class: "field" }, h("label", { for: "pw-new" }, "Nouveau mot de passe"), pw1.el,
      h("p", { class: "hint" }, "Au moins 8 caractères. Une petite phrase facile à retenir fait un excellent mot de passe.")),
    h("div", { class: "field" }, h("label", { for: "pw-new2" }, "Le nouveau, une seconde fois"), pw2.el),
    err, h("div", { class: "actions" }, btn),
    h("p", { class: "hint", style: "margin-top:var(--space-5)" },
      "Mot de passe oublié ? Sur la page de connexion, « Mot de passe oublié ? » envoie un lien par e-mail pour en choisir un nouveau."));
  watchDirty(card);
  return card;
}

function panelHelp(root) {
  root.append(head("Aide", null), h("div", { class: "card prose-admin" },
    h("h2", {}, "Comment ça marche"),
    h("p", {}, "Chaque bouton « Enregistrer » publie la modification. Le site est reconstruit en entier et mis en ligne d'un bloc, en une minute environ : un bandeau en haut de cette page indique quand c'est fait."),
    h("p", {}, "Pendant cette minute, le site en ligne reste tel qu'il était. Il n'est jamais à moitié à jour, et si quelque chose se passait mal, il resterait simplement dans son état précédent."),
    h("h2", {}, "Ajouter une œuvre"),
    h("p", {}, "Rubrique Œuvres, bouton « Ajouter une œuvre ». Choisissez la photo (depuis le téléphone, on peut aussi la prendre directement), remplissez le titre, la série, la technique et les formats, puis « Ajouter l'œuvre au site »."),
    h("p", {}, "Pour une nouvelle série, choisissez « Créer une nouvelle série… » tout en bas de la liste des séries, ou passez par la rubrique Séries."),
    h("h2", {}, "Les séries"),
    h("p", {}, "La rubrique Séries montre chaque série avec toutes ses œuvres. On peut y renommer une série, en retirer une œuvre (il faut alors dire dans quelle série la ranger, ou la supprimer) ou supprimer la série."),
    h("h2", {}, "Les photos"),
    h("p", {}, "Une photo bien droite, cadrée au plus près de la toile, en lumière du jour. Elle est réduite et préparée automatiquement : inutile de la retoucher."),
    h("h2", {}, "En cas de souci"),
    h("p", {}, "Rien de ce qui est fait ici ne peut casser le site : les informations sont vérifiées avant d'être publiées, et chaque version est conservée. Léo peut revenir en arrière sur n'importe quelle modification.")),
  passwordCard());
}

const PANELS = {
  oeuvres: panelWorks,
  series: panelSeries,
  accueil: panelHome,
  demarche: panelDemarche,
  expositions: panelExpos,
  livre: panelGold,
  coordonnees: panelContact,
  aide: panelHelp,
};

/* ============================================================== démarrage */

async function start() {
  app.replaceChildren(h("p", { class: "admin-loading label" }, "Chargement du contenu…"));
  try {
    await loadContent();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    app.replaceChildren(h("main", { class: "auth" }, h("div", { class: "auth__card" },
      h("h1", {}, "Chargement impossible"), h("p", {}, explain(err)),
      button("Réessayer", start))));
    return;
  }
  shell();
  render();
}

(async function boot() {
  const hash = new URLSearchParams(location.hash.slice(1));
  const invite = hash.get("invitation") || hash.get("reinitialisation");
  if (invite) return showSetup(invite, hash.has("reinitialisation"));
  try {
    const s = await call("GET", "session");
    if (!s.authenticated) return showLogin();
    state.email = s.email;
    state.mail = s.mail;
    await start();
  } catch (err) {
    showLogin(explain(err));
  }
})();
