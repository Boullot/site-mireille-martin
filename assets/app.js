/* Mireille Martin — comportements du site.
   Aucune dépendance. Tout dégrade proprement si le script ne se charge pas. */

(function () {
  "use strict";

  /* ---------------------------------------------------------- thème
     Une seule source de vérité : l'attribut data-theme sur <html>.
     Absent = on suit le réglage système (la media query du CSS s'applique). */
  var root = document.documentElement;
  var toggle = document.getElementById("theme");

  function systemPrefersDark() {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  if (toggle) {
    toggle.addEventListener("click", function () {
      var current = root.getAttribute("data-theme") ||
        (systemPrefersDark() ? "dark" : "light");
      var next = current === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try { localStorage.setItem("mm-theme", next); } catch (e) { /* mode privé */ }
      syncThemeColor();
    });
  }

  /* La barre d'état de Safari suit <meta name="theme-color">. Il y en a deux, une par
     media query : si le thème est forcé, les deux doivent porter la couleur choisie,
     sinon la barre reste sombre au-dessus d'une page claire (ou l'inverse). */
  function syncThemeColor() {
    var forced = root.getAttribute("data-theme");
    document.querySelectorAll('meta[name="theme-color"]').forEach(function (m) {
      var dark = forced ? forced === "dark" : /dark/.test(m.getAttribute("media") || "");
      m.setAttribute("content", dark ? "#131210" : "#f5f2ea");
    });
  }
  syncThemeColor();

  /* ------------------------------------------------------ menu mobile */
  var navToggle = document.getElementById("navtoggle");
  var nav = document.getElementById("nav");
  if (navToggle && nav) {
    var setNav = function (open) {
      nav.setAttribute("data-open", String(open));
      navToggle.setAttribute("aria-expanded", String(open));
      navToggle.setAttribute("aria-label", open ? "Fermer le menu" : "Ouvrir le menu");
      root.classList.toggle("nav-open", open);
    };
    navToggle.addEventListener("click", function () {
      setNav(nav.getAttribute("data-open") !== "true");
    });
    nav.addEventListener("click", function (ev) {
      if (ev.target.closest("a")) setNav(false);
    });
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && nav.getAttribute("data-open") === "true") {
        setNav(false);
        navToggle.focus();
      }
    });
    window.matchMedia("(min-width: 861px)").addEventListener("change", function (mq) {
      if (mq.matches) setNav(false);
    });
    // retour arrière depuis le cache : le menu ne doit pas réapparaître ouvert
    window.addEventListener("pageshow", function () { setNav(false); });
  }

  /* --------------------------------------------------- filtres séries */
  var filters = document.querySelectorAll(".filter");
  if (filters.length) {
    var sections = document.querySelectorAll("section[data-series]");
    filters.forEach(function (btn) {
      btn.addEventListener("click", function () {
        var key = btn.dataset.filter;
        filters.forEach(function (b) {
          b.setAttribute("aria-pressed", String(b === btn));
        });
        sections.forEach(function (s) {
          s.hidden = !(key === "all" || s.dataset.series === key);
        });
        if (key !== "all") {
          var target = document.querySelector('section[data-series="' + key + '"]');
          if (target) {
            var y = target.getBoundingClientRect().top + window.scrollY - 80;
            window.scrollTo({ top: y, behavior: reduceMotion() ? "auto" : "smooth" });
          }
        }
        try { history.replaceState(null, "", key === "all" ? location.pathname : "?serie=" + key); }
        catch (e) { /* file:// */ }
      });
    });
    var pre = new URLSearchParams(location.search).get("serie");
    if (pre) {
      var b = document.querySelector('.filter[data-filter="' + CSS.escape(pre) + '"]');
      if (b) b.click();
    }
  }

  function reduceMotion() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  /* ------------------------------------------------- visionneuse œuvre */
  var zoom = document.querySelector(".zoom");
  if (zoom && typeof HTMLDialogElement === "function") {
    var dlg = document.createElement("dialog");
    dlg.className = "lightbox";
    dlg.innerHTML =
      '<button class="lightbox__close" type="button" aria-label="Fermer">' +
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 5l14 14M19 5L5 19"/></svg></button>' +
      '<div class="lightbox__inner"><div class="lightbox__img"></div>' +
      '<div class="lightbox__bar"><span class="label"></span>' +
      '<span class="label lightbox__hint">Échap pour fermer</span></div></div>';
    document.body.appendChild(dlg);

    zoom.style.cursor = "zoom-in";
    zoom.addEventListener("click", function () {
      var img = new Image();
      img.src = zoom.dataset.full;
      if (zoom.dataset.srcset) { img.srcset = zoom.dataset.srcset; img.sizes = "96vw"; }
      img.alt = zoom.dataset.caption || "";
      var slot = dlg.querySelector(".lightbox__img");
      slot.textContent = "";
      slot.appendChild(img);
      dlg.querySelector(".lightbox__bar .label").textContent = zoom.dataset.caption || "";
      dlg.showModal();
    });
    dlg.querySelector(".lightbox__close").addEventListener("click", function () { dlg.close(); });
    dlg.addEventListener("click", function (ev) {
      if (ev.target === dlg || ev.target.closest(".lightbox__img")) dlg.close();
    });
  }

  /* ------------------------------------------------ formulaire contact */
  var form = document.getElementById("contact-form");
  if (form) {
    var status = document.getElementById("form-status");
    var select = document.getElementById("work");
    var wanted = new URLSearchParams(location.search).get("oeuvre");
    if (wanted && select) {
      var opt = select.querySelector('option[value="' + CSS.escape(wanted) + '"]');
      if (opt) {
        select.value = wanted;
        var subject = document.getElementById("subject");
        if (subject) subject.value = "acquisition";
        var msg = document.getElementById("message");
        if (msg && !msg.value) {
          msg.value = "Bonjour,\n\nJe suis intéressé·e par l'œuvre « " +
            opt.textContent.split(" — ")[0] + " ». Pourriez-vous m'indiquer son prix et sa disponibilité ?\n\nAvec mes remerciements,\n";
        }
      }
    }

    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      status.textContent = "";
      status.removeAttribute("data-state");

      var data = Object.fromEntries(new FormData(form).entries());
      if (data.website) return;                 // pot de miel
      if (!data.name || !data.email || !data.message) {
        status.setAttribute("data-state", "err");
        status.textContent = "Merci de renseigner votre nom, votre e-mail et votre message.";
        return;
      }

      var btn = form.querySelector('button[type="submit"]');
      btn.disabled = true;
      var initial = btn.textContent;
      btn.textContent = "Envoi…";

      fetch(form.action, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data)
      }).then(function (r) {
        if (!r.ok) throw new Error(String(r.status));
        form.reset();
        status.setAttribute("data-state", "ok");
        status.textContent = "Message envoyé. Mireille vous répondra directement.";
      }).catch(function () {
        status.setAttribute("data-state", "err");
        var body = encodeURIComponent(
          data.message + "\n\n— " + data.name + " (" + data.email + ")" +
          (data.work ? "\nŒuvre : " + data.work : ""));
        var subj = encodeURIComponent("Site — " + (data.subject || "message"));
        status.innerHTML = 'L\'envoi automatique a échoué. ' +
          '<a href="mailto:' + form.dataset.email + '?subject=' + subj + '&body=' + body +
          '" style="border-bottom:1px solid currentColor">Ouvrir votre logiciel de messagerie</a>.';
      }).finally(function () {
        btn.disabled = false;
        btn.textContent = initial;
      });
    });
  }
})();
