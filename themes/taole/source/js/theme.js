/* 桃的博客 — 主题交互 */
(function () {
  "use strict";

  var doc = document;

  /* ---------- 主题切换 ---------- */
  function currentTheme() {
    var t = doc.documentElement.getAttribute("data-theme");
    if (t) return t;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function applyTheme(theme, persist) {
    doc.documentElement.setAttribute("data-theme", theme);
    if (persist) {
      try { localStorage.setItem("blog-theme", theme); } catch (e) {}
    }
    var btn = doc.querySelector(".theme-toggle");
    if (btn) {
      btn.setAttribute("aria-label", theme === "dark" ? "切换到浅色模式" : "切换到深色模式");
      btn.title = theme === "dark" ? "浅色模式" : "深色模式";
    }
  }

  applyTheme(currentTheme(), false);

  doc.addEventListener("click", function (e) {
    var btn = e.target.closest(".theme-toggle");
    if (!btn) return;
    applyTheme(currentTheme() === "dark" ? "light" : "dark", true);
  });

  /* ---------- 顶部分离阴影 / 移动端菜单 / 返回顶部 ---------- */
  var header = doc.querySelector(".site-header");
  var toTop = doc.querySelector(".to-top");

  function onScroll() {
    var y = window.pageYOffset || doc.documentElement.scrollTop;
    if (header) header.classList.toggle("is-stuck", y > 8);
    if (toTop) toTop.classList.toggle("show", y > 420);

    var bar = doc.querySelector(".progress-bar");
    if (bar) {
      var h = doc.documentElement.scrollHeight - window.innerHeight;
      bar.style.width = (h > 0 ? (y / h) * 100 : 0) + "%";
    }
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  doc.addEventListener("click", function (e) {
    if (e.target.closest(".to-top")) {
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    if (e.target.closest(".nav-toggle")) {
      var nav = doc.querySelector(".nav-links");
      if (nav) nav.classList.toggle("open");
    }
  });

  /* ---------- 目录 TOC（文章页自动生成） ---------- */
  var tocBox = doc.querySelector("#toc-list");
  var body = doc.querySelector(".post-body");

  if (tocBox && body) {
    var heads = body.querySelectorAll("h2, h3");
    if (heads.length) {
      var html = "";
      var n = 0;
      Array.prototype.forEach.call(heads, function (h) {
        if (!h.id) {
          n++;
          h.id = "sec-" + n;
        }
        html += '<li class="toc-' + h.tagName.toLowerCase() + '">' +
          '<a href="#' + h.id + '">' + h.textContent.replace(/#$/, "").trim() + "</a></li>";
      });
      tocBox.innerHTML = html;

      var links = tocBox.querySelectorAll("a");
      var targets = Array.prototype.map.call(links, function (a) {
        return doc.getElementById(a.getAttribute("href").slice(1));
      });

      function syncToc() {
        var idx = 0;
        for (var i = 0; i < targets.length; i++) {
          if (targets[i] && targets[i].getBoundingClientRect().top <= 140) idx = i;
        }
        Array.prototype.forEach.call(links, function (a, i) {
          a.classList.toggle("active", i === idx);
        });
      }
      window.addEventListener("scroll", syncToc, { passive: true });
      syncToc();
    } else {
      var card = doc.querySelector(".toc-card");
      if (card) card.style.display = "none";
    }
  }

  /* ---------- 代码块复制按钮 ---------- */
  Array.prototype.forEach.call(doc.querySelectorAll("figure.highlight"), function (fig) {
    var btn = doc.createElement("button");
    btn.className = "copy-btn";
    btn.type = "button";
    btn.textContent = "复制";
    btn.addEventListener("click", function () {
      var code = fig.querySelector(".code pre") || fig.querySelector("pre");
      var text = code ? code.innerText : "";
      var done = function () {
        btn.textContent = "已复制";
        setTimeout(function () { btn.textContent = "复制"; }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done);
      } else {
        done();
      }
    });
    fig.appendChild(btn);
  });

  /* ---------- 板块筛选 ---------- */
  var filterBar = doc.querySelector("#topic-filter");
  if (filterBar) {
    var grid = doc.querySelector("#topic-grid");
    var cards = grid ? grid.querySelectorAll(".topic-card") : [];
    var counter = doc.querySelector("#topic-count");

    filterBar.addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-filter]");
      if (!btn) return;

      Array.prototype.forEach.call(filterBar.querySelectorAll("button"), function (b) {
        b.classList.toggle("active", b === btn);
      });

      var key = btn.getAttribute("data-filter");
      var shown = 0;
      Array.prototype.forEach.call(cards, function (c) {
        var hit = key === "all" || c.getAttribute("data-topic") === key;
        c.style.display = hit ? "" : "none";
        if (hit) shown++;
      });
      if (counter) counter.textContent = "共 " + shown + " 个";
    });
  }

  /* ---------- 入场动画 ---------- */
  var items = doc.querySelectorAll(".reveal");
  if (items.length && "IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          en.target.classList.add("in");
          io.unobserve(en.target);
        }
      });
    }, { rootMargin: "0px 0px -8% 0px" });
    Array.prototype.forEach.call(items, function (el) { io.observe(el); });
  } else {
    Array.prototype.forEach.call(items, function (el) { el.classList.add("in"); });
  }

  /* ---------- 左侧音乐进度条 ---------- */
  var player = doc.getElementById("music-player");
  if (player) {
    var tracks = [];
    try { tracks = JSON.parse(player.getAttribute("data-tracks")) || []; } catch (err) { tracks = []; }

    var audio = player.querySelector(".music-audio");
    var rail = player.querySelector(".music-rail");
    var fill = player.querySelector(".music-rail-fill");
    var titleEl = player.querySelector(".music-title");
    var playBtn = player.querySelector(".music-play");
    var prevBtn = player.querySelector(".music-prev");
    var nextBtn = player.querySelector(".music-next");
    var timeEl = player.querySelector(".music-time");

    var index = 0;
    var touching = false;
    var PAUSE_KEY = "music-user-paused";

    function fmt(sec) {
      if (!isFinite(sec)) return "0:00";
      sec = Math.max(0, Math.round(sec));
      return Math.floor(sec / 60) + ":" + ("0" + (sec % 60)).slice(-2);
    }

    function load(i) {
      index = (i + tracks.length) % tracks.length;
      audio.src = tracks[index].src;
      if (titleEl) titleEl.textContent = tracks[index].title;
    }

    function paintProgress() {
      var pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
      fill.style.height = pct + "%";
      timeEl.textContent = fmt(touching ? audio.currentTime : audio.currentTime);
    }

    function toggle() {
      if (player.classList.contains("is-playing")) {
        audio.pause();
        try { localStorage.setItem(PAUSE_KEY, "1"); } catch (e) {}
      } else {
        try { localStorage.removeItem(PAUSE_KEY); } catch (e) {}
        audio.play().catch(function () { /* 自动播放被拦或加载失败，忽略 */ });
      }
    }

    audio.addEventListener("play", function () { player.classList.add("is-playing"); });
    audio.addEventListener("pause", function () { player.classList.remove("is-playing"); });
    audio.addEventListener("ended", function () { load(index + 1); audio.play().catch(function () {}); });
    audio.addEventListener("timeupdate", paintProgress);
    audio.addEventListener("loadedmetadata", paintProgress);

    playBtn.addEventListener("click", toggle);
    prevBtn.addEventListener("click", function () {
      var wasPlaying = player.classList.contains("is-playing");
      load(index - 1);
      if (wasPlaying) audio.play().catch(function () {});
    });
    nextBtn.addEventListener("click", function () {
      var wasPlaying = player.classList.contains("is-playing");
      load(index + 1);
      if (wasPlaying) audio.play().catch(function () {});
    });

    // 点竖条任意位置跳转进度
    rail.addEventListener("click", function (e) {
      if (!audio.duration) return;
      var rect = rail.getBoundingClientRect();
      // 从下往上：底部 = 0，顶部 = 全曲
      var ratio = 1 - (e.clientY - rect.top) / rect.height;
      audio.currentTime = Math.min(Math.max(ratio, 0), 1) * audio.duration;
    });

    // 触屏：点竖条切换控件显示
    rail.addEventListener("touchstart", function () {
      player.classList.add("is-touch");
    }, { passive: true });
    doc.addEventListener("touchstart", function (e) {
      if (player.classList.contains("is-touch") && !player.contains(e.target)) {
        player.classList.remove("is-touch");
      }
    }, { passive: true });

    // 把手：触屏开关浮层，桌面直接播放/暂停
    var handle = player.querySelector(".music-handle");
    if (handle) {
      handle.addEventListener("click", function () {
        if (window.matchMedia("(hover: none)").matches) {
          player.classList.toggle("is-touch");
        } else {
          toggle();
        }
      });
    }

    load(0);

    // 进入自动播放：被浏览器拦截时，等用户第一次交互立刻开播
    var wantAuto = true;
    try { wantAuto = !localStorage.getItem(PAUSE_KEY); } catch (e) {}
    if (wantAuto && tracks.length) {
      audio.play().catch(function () {
        var kick = function () {
          audio.play().catch(function () {});
          window.removeEventListener("pointerdown", kick);
          window.removeEventListener("keydown", kick);
        };
        window.addEventListener("pointerdown", kick);
        window.addEventListener("keydown", kick);
      });
    }
  }
})();
