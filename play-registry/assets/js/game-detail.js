// 游戏介绍页：从 registry.json 渲染介绍，并复用 PlayLauncher 在本页启动。
(function () {
  "use strict";

  var root = document.getElementById("detail-content");
  var currentGame = null;
  var ICONS = ["⚡", "🎯", "🔥", "💧", "🚪", "⚖️", "📏", "🦶", "💫", "🎮", "🧩", "⏳"];

  function t(key, vars) {
    try {
      if (window.SiteI18n && window.SiteI18n.t) return window.SiteI18n.t(key, vars);
    } catch (_) {}
    var text = key;
    if (vars) {
      text = String(text).replace(/\{(\w+)\}/g, function (_, k) {
        return vars[k] == null ? "" : String(vars[k]);
      });
    }
    return text;
  }

  function isEn() {
    try {
      return !!(window.SiteI18n && window.SiteI18n.isEn && window.SiteI18n.isEn());
    } catch (_) {
      return false;
    }
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function iconFor(id) {
    var h = 0;
    var s = String(id || "");
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return ICONS[h % ICONS.length];
  }

  function gameIdFromLocation() {
    var path = location.pathname || "";
    var marker = "/games/";
    var idx = path.lastIndexOf(marker);
    if (idx >= 0 && path.slice(-5) === ".html") {
      return decodeURIComponent(path.slice(idx + marker.length, path.length - 5));
    }
    return new URLSearchParams(location.search).get("id");
  }

  function registryUrl() {
    if (location.protocol === "file:") return "registry.json";
    return "/registry.json";
  }

  function fmtSize(bytes) {
    if (!bytes) return "";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1048576).toFixed(2) + " MB";
  }

  function loc(g) {
    var m = g.manifest || {};
    var pack = (isEn() && m.i18n && m.i18n.en) || {};
    return {
      title: pack.title || g.title || g.id,
      description: pack.description || g.description || "",
      howTo: pack.howTo || m.howTo || "",
      devices: pack.devices || {},
      params: pack.params || {},
      paramDescriptions: pack.paramDescriptions || {},
      paramUnits: pack.paramUnits || {},
    };
  }

  function authorOf(g) {
    return g.author || g.authorName || (g.source === "builtin" ? t("platformAuthor") : t("unknownAuthor"));
  }

  function prepareGame(g) {
    g._path = g.path || ("games/" + g.id + "/index.html");
    try {
      g._launchUrl = "undersilicon://play/" + encodeURIComponent(new URL(g._path, location.href).href);
    } catch (_) {
      g._launchUrl = "";
    }
    return g;
  }

  function deviceHtml(devices, labels) {
    if (!devices.length) {
      return '<p class="detail-empty">' + esc(t("introNoDevices")) + "</p>";
    }
    return '<ul class="detail-device-list">' + devices.map(function (d) {
      var req = d.required ? '<span class="badge required">' + esc(t("required")) + "</span>" : '<span class="badge">' + esc(t("optional")) + "</span>";
      var caps = (d.capabilities || []).map(function (c) {
        return '<span class="badge">' + esc(c) + "</span>";
      }).join("");
      return '<li class="detail-device">'
        + '<div class="detail-device-head">'
        + "<strong>" + esc(labels[d.id] || d.label || d.id) + "</strong>"
        + req
        + "</div>"
        + (caps ? '<div class="detail-device-caps">' + caps + "</div>" : "")
        + "</li>";
    }).join("") + "</ul>";
  }

  function stepsHtml(howTo) {
    var raw = String(howTo || t("introHowToFallback")).split(/\n+/).map(function (line) {
      return line.replace(/^\d+\.\s*/, "").trim();
    }).filter(Boolean);
    if (!raw.length) raw = [t("introHowToFallback")];
    return "<ol class=\"detail-list\">" + raw.map(function (line) {
      return "<li>" + esc(line) + "</li>";
    }).join("") + "</ol>";
  }

  function paramsHtml(params, L) {
    if (!params.length) {
      return '<p class="detail-empty">' + esc(t("introNoParams")) + "</p>";
    }
    return '<ul class="detail-param-list">' + params.map(function (p) {
      var unitText = L.paramUnits[p.key] || p.unit;
      var unit = unitText ? '<span class="detail-param-unit">' + esc(unitText) + "</span>" : "";
      var descText = L.paramDescriptions[p.key] || p.description;
      var desc = descText ? '<div class="detail-param-desc">' + esc(descText) + "</div>" : "";
      return '<li class="detail-param">'
        + '<div class="detail-param-head"><strong>' + esc(L.params[p.key] || p.label || p.key) + "</strong>" + unit + "</div>"
        + desc
        + "</li>";
    }).join("") + "</ul>";
  }

  function metaRows(g) {
    var rows = [
      [t("introGameId"), g.id],
      [t("introVersion"), g.version || (g.manifest && g.manifest.version) || "—"],
      [t("introSource"), g.source === "builtin" ? t("introSourceBuiltin") : t("introSourceCommunity")],
    ];
    if (g.size) rows.push([t("introSize"), fmtSize(g.size)]);
    if (g.sha256) rows.push(["SHA-256", g.sha256.slice(0, 16) + "…"]);
    return '<dl class="detail-meta">' + rows.map(function (row) {
      return "<div><dt>" + esc(row[0]) + "</dt><dd>" + esc(row[1]) + "</dd></div>";
    }).join("") + "</dl>";
  }

  function render(g) {
    if (!root) return;
    if (!g) {
      root.innerHTML = '<div class="empty-state">' + esc(t("introMissing")) + "</div>";
      document.title = t("introTitle");
      return;
    }
    var L = loc(g);
    var devices = g.devices || (g.manifest && g.manifest.devices) || [];
    var params = g.params || (g.manifest && g.manifest.params) || [];
    document.title = L.title + " · " + t("brand");
    root.innerHTML =
      '<section class="detail-hero">'
        + '<div class="detail-hero-top">'
          + '<div class="game-icon detail-icon">' + iconFor(g.id) + "</div>"
          + '<div class="detail-hero-copy">'
            + '<p class="eyebrow">' + esc(t("introEyebrow")) + "</p>"
            + "<h1>" + esc(L.title) + "</h1>"
            + '<p class="detail-lead">' + esc(L.description || t("noDesc")) + "</p>"
          + "</div>"
        + "</div>"
        + '<div class="detail-byline">'
          + "<span>" + esc(t("introAuthor")) + "</span><strong>" + esc(authorOf(g)) + "</strong>"
          + "<span>·</span><span class=\"badge ver\">v" + esc(g.version || (g.manifest && g.manifest.version) || "—") + "</span>"
        + "</div>"
        + '<div class="detail-actions">'
          + '<button class="btn btn-primary" type="button" data-launch="' + esc(g.id) + '">' + esc(t("startPlay")) + "</button>"
          + '<button class="btn btn-ghost" type="button" data-cache="' + esc(g.id) + '">' + esc(t("cache")) + "</button>"
          + '<a class="btn btn-ghost" href="games.html">' + esc(t("introBack")) + "</a>"
        + "</div>"
      + "</section>"
      + '<div class="detail-grid">'
        + '<section class="detail-card">'
          + "<h2>" + esc(t("introNeed")) + "</h2>"
          + deviceHtml(devices, L.devices)
        + "</section>"
        + '<section class="detail-card">'
          + "<h2>" + esc(t("introHow")) + "</h2>"
          + stepsHtml(L.howTo)
        + "</section>"
        + '<section class="detail-card">'
          + "<h2>" + esc(t("introParams")) + "</h2>"
          + paramsHtml(params, L)
        + "</section>"
        + '<section class="detail-card">'
          + "<h2>" + esc(t("introSafety")) + "</h2>"
          + "<p>" + esc(t("introSafetyBody")) + "</p>"
        + "</section>"
        + '<section class="detail-card detail-card-wide">'
          + "<h2>" + esc(t("introInfo")) + "</h2>"
          + metaRows(g)
        + "</section>"
      + "</div>";
  }

  function bind() {
    if (!root) return;
    root.addEventListener("click", function (e) {
      if (!currentGame || !window.PlayLauncher) return;
      var cacheBtn = e.target.closest("[data-cache]");
      if (cacheBtn) {
        window.PlayLauncher.cache(currentGame, cacheBtn);
        return;
      }
      var launchBtn = e.target.closest("[data-launch]");
      if (launchBtn) window.PlayLauncher.open(currentGame, launchBtn);
    });
    var cancelBtn = document.getElementById("modal-cancel");
    if (cancelBtn && window.PlayLauncher) {
      cancelBtn.addEventListener("click", function () { window.PlayLauncher.closeModal(); });
    }
    document.addEventListener("site-locale-change", function () { render(currentGame); });
  }

  function load() {
    if (!root) return;
    var id = gameIdFromLocation();
    if (!id) {
      render(null);
      return;
    }
    fetch(registryUrl())
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        var g = (data.games || []).find(function (x) { return x.id === id; });
        if (!g) throw new Error(t("introNotFound"));
        currentGame = prepareGame(g);
        render(currentGame);
      })
      .catch(function (err) {
        root.innerHTML = '<div class="empty-state">' + esc(err.message || err) + "</div>";
      });
  }

  bind();
  load();
})();
