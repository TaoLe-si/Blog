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

  /* ---------- 目录 TOC（文章页右侧弹出） ---------- */
  var tocBox = doc.querySelector("#toc-list");
  var body = doc.querySelector(".post-body");

  if (tocBox && body) {
    var heads = body.querySelectorAll("h2, h3");
    var tocPop = doc.getElementById("toc-pop");
    if (heads.length && tocPop) {
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

      // 与音乐卡片一致的弹出驻留：移出 2 秒后收起
      var tocTimer = null;
      function tocOpen() {
        if (tocTimer) { clearTimeout(tocTimer); tocTimer = null; }
        tocPop.classList.add("is-open", "is-peek");
      }
      function tocCloseLater() {
        if (tocTimer) clearTimeout(tocTimer);
        tocTimer = setTimeout(function () {
          tocPop.classList.remove("is-open", "is-peek");
          tocTimer = null;
        }, 2000);
      }
      tocPop.addEventListener("mouseenter", tocOpen);
      tocPop.addEventListener("mouseleave", tocCloseLater);
      tocPop.querySelector(".toc-handle").addEventListener("click", function () {
        if (tocPop.classList.contains("is-open")) {
          tocPop.classList.remove("is-open");
        } else {
          tocOpen();
        }
      });
    } else if (tocPop) {
      tocPop.style.display = "none";
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
    var STATE_KEY = "music-state";
    var lastSave = 0;

    function fmt(sec) {
      if (!isFinite(sec)) return "0:00";
      sec = Math.max(0, Math.round(sec));
      return Math.floor(sec / 60) + ":" + ("0" + (sec % 60)).slice(-2);
    }

    function saveState(force) {
      var now = Date.now();
      if (!force && now - lastSave < 1000) return;
      lastSave = now;
      try {
        localStorage.setItem(STATE_KEY, JSON.stringify({
          i: index,
          t: audio.currentTime || 0,
          p: !audio.paused
        }));
      } catch (e) {}
    }

    function load(i) {
      index = (i + tracks.length) % tracks.length;
      audio.src = tracks[index].src;
      if (titleEl) titleEl.textContent = tracks[index].title;
    }

    function paintProgress() {
      var pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
      fill.style.height = pct + "%";
      if (timeEl) timeEl.textContent = fmt(audio.currentTime);
    }

    function toggle() {
      if (player.classList.contains("is-playing")) {
        audio.pause();
      } else {
        audio.play().catch(function () { /* 自动播放被拦或加载失败，忽略 */ });
      }
    }

    audio.addEventListener("play", function () { player.classList.add("is-playing"); saveState(true); });
    audio.addEventListener("pause", function () { player.classList.remove("is-playing"); saveState(true); });
    audio.addEventListener("ended", function () { load(index + 1); audio.play().catch(function () {}); });
    audio.addEventListener("timeupdate", function () { paintProgress(); saveState(false); });
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

    // 点竖条任意位置跳转进度（从上往下：顶部 = 0，底部 = 全曲）
    rail.addEventListener("click", function (e) {
      if (!audio.duration) return;
      var rect = rail.getBoundingClientRect();
      var ratio = (e.clientY - rect.top) / rect.height;
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

    // 浮层驻留：鼠标离开播放器区域 2 秒后收起（移到浮层上不消失）
    var hideTimer = null;
    function openFlyout() {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      player.classList.add("is-open", "is-peek");
    }
    function scheduleClose() {
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(function () {
        player.classList.remove("is-open", "is-peek");
        hideTimer = null;
      }, 2000);
    }
    player.addEventListener("mouseenter", openFlyout);
    player.addEventListener("mouseleave", scheduleClose);

    // 恢复上次播放状态（跨页面续播），否则从头开始
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(STATE_KEY) || "null"); } catch (e) { saved = null; }

    var resume = saved && saved.i < tracks.length && saved.t > 0;
    load(resume ? saved.i : 0);

    // 恢复上次进度：play 事件可能早于 metadata 就绪（duration 还是 NaN），
    // 所以三个事件都挂，等 duration 可用时执行一次
    var restored = false;
    function tryRestore() {
      if (resume && !restored && isFinite(audio.duration) && audio.duration > 0) {
        restored = true;
        audio.currentTime = Math.min(saved.t, Math.max(audio.duration - 1, 0));
      }
    }
    audio.addEventListener("loadedmetadata", tryRestore);
    audio.addEventListener("canplay", tryRestore);
    audio.addEventListener("play", tryRestore);

    // 离开页面时保存最新状态
    window.addEventListener("pagehide", function () { saveState(true); });

    // 自动播放：上次在播 / 首次访问 → 尝试直接响；被浏览器拦则等首次交互
    var wantPlay = resume ? !!saved.p : true;
    if (wantPlay && tracks.length) {
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

  /* ---------- 彩蛋：连点头像卡片，切换卡片背景 ---------- */
  var pageBg = window.__PAGE_BG__;
  var eggCard = doc.querySelector(".hero-side");

  if (pageBg && pageBg.egg && eggCard) {
    var eggNeed = pageBg.egg.clicks;
    var eggHits = 0;
    var eggChain = null;
    var eggLoaded = false;

    // 图片就绪后再加 class，避免切换瞬间背景空白
    function revealEgg() {
      eggCard.classList.add("is-egg");
    }

    function armEgg() {
      if (eggLoaded) return;
      var img = new Image();
      img.onload = function () { eggLoaded = true; };
      img.src = pageBg.egg.src;
    }
    armEgg();

    eggCard.addEventListener("click", function () {
      if (eggCard.classList.contains("is-egg")) return;

      eggHits++;

      // 两次点击间隔超过 900ms 视为断链，重新计数
      if (eggChain) clearTimeout(eggChain);
      eggChain = setTimeout(function () {
        eggHits = 0;
        eggChain = null;
      }, 900);

      if (eggHits >= eggNeed) {
        eggHits = 0;
        clearTimeout(eggChain);
        eggChain = null;

        if (eggLoaded) {
          revealEgg();
        } else {
          // 少见：图还没下完就被点到 10 次，等它到位再切换
          var img = new Image();
          img.onload = function () { eggLoaded = true; revealEgg(); };
          img.onerror = revealEgg;
          img.src = pageBg.egg.src;
        }
      }
    });
  }
  /* ---------- 边缘控件自动收起（滚动隐藏 / 热区唤出） ----------
     滚过 120px：html.edge-hidden → 顶栏上移出屏、左右贴边控件推出屏幕；
     鼠标进入该侧热区：对应控件加 .is-peek 滑回；移出 2s 由上面的定时器收回；
     回到顶部（scrollY ≤ 8）才自动展开顶栏。
     热区就是控件自身的盒子（体积不变，只位移内部元素）。 */

  // 只要求「能悬停」。原先还要求 pointer: fine，但触摸屏笔记本上
  // 媒体查询常不可靠（有触控板却报 coarse），判定为假就整套静默失效，
  // 表现为「改了样式但页面没变」。这里放宽 + 加运行时兜底。
  var canHover = window.matchMedia("(hover: hover)");
  var sawMouse = false;

  function edgeAllowed() {
    if (sawMouse) return true;          // 真收到过鼠标事件，无条件启用
    return canHover.matches;
  }

  function updateEdge() {
    if (!edgeAllowed()) {
      doc.documentElement.classList.remove("edge-hidden");
      if (player) player.classList.remove("is-peek");
      if (tocPop) tocPop.classList.remove("is-peek");
      return;
    }

    var y = window.pageYOffset || doc.documentElement.scrollTop;
    var hidden = doc.documentElement.classList.contains("edge-hidden");
    var want = hidden;

    // 滞后带：往下滑过 120px 才收，回到 8px 以内才展开（中间区间维持原状）
    if (y <= 8) want = false;
    else if (y > 120) want = true;
    // 移动端菜单展开时不收顶栏，否则菜单会跟着一起飞走
    if (doc.querySelector(".nav-links.open")) want = false;

    if (want === hidden) return;
    doc.documentElement.classList.toggle("edge-hidden", want);

    if (want) {
      // 滚动时鼠标可能已经停在热区里，mouseenter 不会再触发，这里补判一次
      Array.prototype.forEach.call([player, tocPop], function (el) {
        if (!el) return;
        var on = false;
        try { on = el.matches(":hover"); } catch (e) { on = false; }
        el.classList.toggle("is-peek", on);
      });
    } else {
      if (player) player.classList.remove("is-peek");
      if (tocPop) tocPop.classList.remove("is-peek");
    }
  }

  // 运行时兜底：只要真的移动了鼠标，就启用（媒体查询骗人也不怕）。
  // 用 mousemove 而非 pointermove，且只认首次，之后解绑。
  function onFirstMouse(e) {
    // 触屏浏览器会合成 mousemove，用 sourceCapabilities 排除
    if (e && e.sourceCapabilities && e.sourceCapabilities.firesTouchEvents) return;
    sawMouse = true;
    doc.removeEventListener("mousemove", onFirstMouse);
    updateEdge();
  }
  doc.addEventListener("mousemove", onFirstMouse, { passive: true });

  // 媒体查询状态变化时重算（如外接鼠标插拔）
  if (canHover.addEventListener) canHover.addEventListener("change", updateEdge);
  else if (canHover.addListener) canHover.addListener(updateEdge);

  window.addEventListener("scroll", updateEdge, { passive: true });
  window.addEventListener("resize", updateEdge);
  updateEdge();

  // 排查用：控制台输入 __EDGE__ 可看当前判定
  window.__EDGE__ = function () {
    return {
      canHover: canHover.matches,
      sawMouse: sawMouse,
      edgeAllowed: edgeAllowed(),
      edgeHidden: doc.documentElement.classList.contains("edge-hidden"),
      scrollY: Math.round(window.pageYOffset || doc.documentElement.scrollTop),
    };
  };
})();
