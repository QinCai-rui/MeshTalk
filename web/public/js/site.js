/* MeshTalk site behaviour: theme, mobile nav, copy feedback, docs scrollspy,
   latest release, and control-server status. */
(function () {
  "use strict";
  var root = document.documentElement;

  /* ---- theme (light default, dark opt-in) ---- */
  var STORAGE = "mt-theme";
  var toggle = document.getElementById("theme-toggle");

  function isDark() { return root.classList.contains("dark"); }
  function syncTheme() {
    var dark = isDark();
    if (toggle) {
      var label = dark ? "Switch to light theme" : "Switch to dark theme";
      toggle.setAttribute("aria-pressed", String(dark));
      toggle.setAttribute("aria-label", label);
      toggle.setAttribute("title", label);
    }
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", dark ? "#0a1120" : "#f4f1e8");
  }
  if (toggle) {
    toggle.addEventListener("click", function () {
      var dark = isDark();
      root.classList.toggle("dark", !dark);
      try { localStorage.setItem(STORAGE, dark ? "light" : "dark"); } catch (e) {}
      syncTheme();
    });
  }
  syncTheme();

  /* ---- mobile nav ---- */
  var navToggle = document.getElementById("nav-toggle");
  var nav = document.getElementById("site-nav");
  if (navToggle && nav) {
    navToggle.addEventListener("click", function () {
      var open = nav.classList.toggle("is-open");
      navToggle.setAttribute("aria-expanded", String(open));
    });
    nav.addEventListener("click", function (e) {
      if (e.target.closest("a")) {
        nav.classList.remove("is-open");
        navToggle.setAttribute("aria-expanded", "false");
      }
    });
  }

  /* ---- copy command blocks, with visible feedback ---- */
  document.querySelectorAll("[data-copy]").forEach(function (el) {
    el.addEventListener("click", function () {
      var text = el.getAttribute("data-copy");
      var feedback = el.querySelector(".cmd__feedback");
      function done() {
        el.classList.add("is-copied");
        if (feedback) feedback.hidden = false;
        window.clearTimeout(el._copyTimer);
        el._copyTimer = window.setTimeout(function () {
          el.classList.remove("is-copied");
          if (feedback) feedback.hidden = true;
        }, 1400);
      }
      function fallback() {
        try {
          var ta = document.createElement("textarea");
          ta.value = text;
          ta.setAttribute("readonly", "");
          ta.style.position = "fixed";
          ta.style.top = "-1000px";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          ta.remove();
          done();
        } catch (e) {}
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, fallback);
      } else {
        fallback();
      }
    });
  });

  /* ---- docs scrollspy ---- */
  var docNav = document.querySelector(".doc-nav");
  if (docNav && "IntersectionObserver" in window) {
    var links = Array.prototype.slice.call(docNav.querySelectorAll("a[href^='#']"));
    var sections = links
      .map(function (a) { return document.querySelector(a.getAttribute("href")); })
      .filter(Boolean);
    if (sections.length) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) {
            links.forEach(function (a) {
              a.classList.toggle("is-active", a.getAttribute("href") === "#" + en.target.id);
            });
          }
        });
      }, { rootMargin: "-20% 0px -70% 0px" });
      sections.forEach(function (s) { io.observe(s); });
    }
  }

  /* ---- latest release ---- */
  var REPO = "https://api.github.com/repos/QinCai-rui/MeshTalk/releases/latest";
  var tagEls = document.querySelectorAll("[data-version]");
  if (tagEls.length) {
    fetch(REPO)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.tag_name) return;
        tagEls.forEach(function (el) { el.textContent = d.tag_name; });
        document.querySelectorAll("[data-release-link]").forEach(function (a) {
          a.setAttribute("href", "https://github.com/QinCai-rui/MeshTalk/releases/tag/" + d.tag_name);
        });
      })
      .catch(function () {});
  }

  /* ---- control-server status ---- */
  var statusGrid = document.querySelector("[data-status]");
  if (statusGrid) {
    var SERVER_PROXY = "/api/health";
    var DIRECT = "https://meshtalk-control.qincai.xyz/health";

    function dot(id, state) {
      var el = document.getElementById(id);
      if (el) el.className = "dot dot--" + state;
    }
    function fill(prefix, data) {
      ["status", "rooms", "connections", "endpoint"].forEach(function (k) {
        var el = document.getElementById(prefix + "-field-" + k);
        if (el) el.textContent = (data && data[k] != null) ? data[k] : "-";
      });
    }
    function err(prefix, msg) {
      var el = document.getElementById(prefix + "-error");
      if (el) { el.textContent = msg; el.hidden = false; }
    }

    (async function () {
      var serverOnline = false;
      var allowOrigin = null;

      dot("server-dot", "loading");
      try {
        var r = await fetch(SERVER_PROXY + "?url=" + encodeURIComponent(DIRECT.replace("/health", "")), { cache: "no-store" });
        var d = await r.json();
        if (!r.ok) throw new Error(d.error || "HTTP " + r.status);
        serverOnline = true;
        allowOrigin = (d.cors && d.cors.allowOrigin) || null;
        dot("server-dot", "ok");
        var s = document.getElementById("server-status");
        if (s) s.textContent = "Online";
        fill("server", d);
      } catch (e) {
        dot("server-dot", "error");
        var s2 = document.getElementById("server-status");
        if (s2) s2.textContent = "Offline / unreachable";
        err("server", String(e && e.message ? e.message : e));
      }

      dot("client-dot", "loading");
      try {
        var r2 = await fetch(DIRECT, { cache: "no-store", mode: "cors" });
        var d2 = await r2.json();
        if (!r2.ok) throw new Error("HTTP " + r2.status);
        dot("client-dot", "ok");
        var c = document.getElementById("client-status");
        if (c) c.textContent = "Online";
        fill("client", Object.assign({}, d2, { endpoint: DIRECT }));
      } catch (e2) {
        dot("client-dot", "error");
        var c2 = document.getElementById("client-status");
        if (c2) c2.textContent = "Offline / unreachable";
        err("client", String(e2 && e2.message ? e2.message : e2));
        var v = document.getElementById("client-verdict");
        if (v) {
          if (serverOnline) {
            var allowed = allowOrigin === "*" || allowOrigin === window.location.origin;
            v.textContent = allowed
              ? "The control server is reachable through this site but not directly from your browser: your network likely blocks it."
              : "The control server is online, but it does not allow cross-origin requests from this site. The direct check is likely CORS-blocked.";
          } else {
            v.textContent = "Both checks failed, so the control server is likely down.";
          }
          v.hidden = false;
        }
      }
    })();
  }
})();
