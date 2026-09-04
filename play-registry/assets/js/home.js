// 首页：推荐游戏 + Prompt 复制。完整列表在 games.html。
(function () {
  "use strict";
  var LIMIT = 4;
  var SKIP = { "device-control": 1 };
  var grid = document.getElementById("rec-grid");
  var allGames = [];
  var recGames = [];
  var ICONS = ["⚡", "🎯", "🔥", "💧", "🚪", "⚖️", "📏", "🦶", "💫", "🎮", "🧩", "⏳"];

  function t(key, vars) {
    try {
      if (window.SiteI18n && window.SiteI18n.t) return window.SiteI18n.t(key, vars);
    } catch (_) {}
    var text = key;
    if (vars) text = String(text).replace(/\{(\w+)\}/g, function (_, k) {
      return vars[k] == null ? "" : String(vars[k]);
    });
    return text;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function iconFor(id) {
    var h = 0;
    for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return ICONS[h % ICONS.length];
  }

  function cardHtml(g) {
    return '<article class="game-card game-card-compact">'
      + '<div class="game-card-head">'
      + '<div class="game-icon">' + iconFor(g.id) + "</div>"
      + '<div style="flex:1;min-width:0;">'
      + '<div class="game-title">' + esc(g.title || g.id) + "</div>"
      + '<div class="game-id">' + esc(g.id) + "</div>"
      + "</div></div>"
      + '<p class="game-desc">' + esc(g.description || t("noDesc")) + "</p>"
      + '<div class="game-card-foot">'
      + '<span class="badge ver">v' + esc(g.version || "0.0.0") + "</span>"
      + '<button class="play-link" type="button" data-launch="' + esc(g.id) + '">' + t("launch") + "</button>"
      + "</div></article>";
  }

  function pick(games) {
    var rec = games.filter(function (g) { return !SKIP[g.id]; }).slice(0, LIMIT);
    return rec.length ? rec : games.slice(0, LIMIT);
  }

  function updateStats(games) {
    var capSet = Object.create(null), devSet = Object.create(null);
    games.forEach(function (g) {
      (g.devices || []).forEach(function (d) {
        devSet[d.id] = 1;
        (d.capabilities || []).forEach(function (c) { capSet[c] = 1; });
      });
    });
    var elG = document.getElementById("stat-games");
    var elD = document.getElementById("stat-devices");
    var elC = document.getElementById("stat-caps");
    if (elG) elG.textContent = games.length;
    if (elD) elD.textContent = Object.keys(devSet).length;
    if (elC) elC.textContent = Object.keys(capSet).length;
  }

  function render() {
    if (!grid) return;
    if (!recGames.length) {
      grid.innerHTML = '<div class="empty-state"><p>' + t("registryFail") + "</p></div>";
      return;
    }
    grid.innerHTML = recGames.map(cardHtml).join("");
  }

  function applyRegistry(data) {
    var games = data.games || [];
    games.forEach(function (g) {
      g._path = g.path || ("games/" + g.id + "/index.html");
      g._launchUrl = "undersilicon://play/" + encodeURIComponent(new URL(g._path, location.href).href);
    });
    allGames = games;
    recGames = pick(games);
    updateStats(games);
    render();
  }

  fetch("registry.json")
    .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then(applyRegistry)
    .catch(function (err) {
      if (!grid) return;
      grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1;">'
        + '<p style="color:var(--warn);">' + t("registryFail") + "</p>"
        + "<p>" + esc(err.message || err) + "</p></div>";
    });

  if (grid) {
    grid.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-launch]");
      if (!btn || !window.PlayLauncher) return;
      var g = allGames.find(function (x) { return x.id === btn.getAttribute("data-launch"); });
      if (g) window.PlayLauncher.open(g, btn);
    });
  }

  var cancelBtn = document.getElementById("modal-cancel");
  if (cancelBtn && window.PlayLauncher) {
    cancelBtn.addEventListener("click", function () { window.PlayLauncher.closeModal(); });
  }

  document.addEventListener("site-locale-change", render);

  document.querySelectorAll(".copy-btn[data-copy-target]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var el = document.querySelector(btn.getAttribute("data-copy-target"));
      if (!el) return;
      var text = el.textContent, old = btn.textContent;
      var done = function () {
        btn.textContent = t("copied");
        btn.classList.add("copied");
        setTimeout(function () { btn.textContent = old; btn.classList.remove("copied"); }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(function () {});
      } else {
        var ta = document.createElement("textarea");
        ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select();
        try { document.execCommand("copy"); done(); } catch (_) {}
        document.body.removeChild(ta);
      }
    });
  });
})();
