/* 桃的博客 — 主题交互
 *
 * 结构说明（改之前先看这段）：
 *   持久模块  —— 整站只初始化一次，PJAX 换页不重建
 *                主题切换 / 滚动监听 / 音乐播放器 / 边缘收起
 *   页面级模块 —— 每次导航后重新初始化（initPage）
 *                随机背景 / 彩蛋 / TOC / 代码复制 / 板块筛选 / 入场动画
 *   PJAX      —— 拦截站内链接，只替换 body，保留 #music-player 实例，
 *                这样切页时 <audio> 不被销毁，音乐就不会断。
 *                任一步失败都退回整页导航，不会白屏。
 */
(function () {
  "use strict";

  var doc = document;

  /* ================= 共享引用（换页后需刷新） ================= */
  var header = null;
  var toTop = null;
  var tocPop = null;      // 文章页有，其它页为 null
  var player = null;      // #music-player，持久，只在首次拿一次
  var musicApi = null;    // { save() } 供 PJAX 导航前落盘进度
  var pageEgg = null;     // 当前页彩蛋数据（initPageBg 里填）
  var updateEdge = null;  // initEdge 里赋值，initPage 会调用
  var tocSync = null;     // TOC 滚动同步函数，换页时解绑旧的

  /* ================= 持久模块 ================= */

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

  /* ---------- 滚动：顶部分离线 / 阅读进度 / 返回顶部 ---------- */
  function onScroll() {
    var y = window.pageYOffset || doc.documentElement.scrollTop;
    if (!header) header = doc.querySelector(".site-header");
    if (!toTop) toTop = doc.querySelector(".to-top");
    if (header) header.classList.toggle("is-stuck", y > 8);
    if (toTop) toTop.classList.toggle("show", y > 420);

    var bar = doc.querySelector(".progress-bar");
    if (bar) {
      var h = doc.documentElement.scrollHeight - window.innerHeight;
      bar.style.width = (h > 0 ? (y / h) * 100 : 0) + "%";
    }
  }
  window.addEventListener("scroll", onScroll, { passive: true });

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

  /* ---------- 边缘控件自动收起（滚动隐藏 / 热区唤出） ----------
     滚过 120px：html.edge-hidden → 顶栏上移出屏、左右贴边控件推出屏幕；
     鼠标进入该侧热区：对应控件加 .is-peek 滑回；移出 2s 由上面的定时器收回；
     回到顶部（scrollY ≤ 8）才自动展开顶栏。
     热区就是控件自身的盒子（体积不变，只位移内部元素）。 */
  function initEdge() {
    // 只要求「能悬停」。原先还要求 pointer: fine，但触摸屏笔记本上
    // 媒体查询常不可靠（有触控板却报 coarse），判定为假就整套静默失效，
    // 表现为「改了样式但页面没变」。这里放宽 + 加运行时兜底。
    var canHover = window.matchMedia("(hover: hover)");
    var sawMouse = false;

    function edgeAllowed() {
      if (sawMouse) return true;          // 真收到过鼠标事件，无条件启用
      return canHover.matches;
    }

    updateEdge = function () {
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
    };

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
  }

  /* ---------- 音乐播放器（持久：PJAX 不会替换它，audio 因此不被销毁） ---------- */
  function initMusic() {
    player = doc.getElementById("music-player");
    if (!player) return;

    var tracks = [];
    try { tracks = JSON.parse(player.getAttribute("data-tracks")) || []; } catch (err) { tracks = []; }

    // 音量：0~1，默认 0.6（主题配置 music.volume 可调）
    var volume = parseFloat(player.getAttribute("data-volume"));
    if (!isFinite(volume) || volume < 0) volume = 0.6;
    if (volume > 1) volume = 1;

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

    // 给 PJAX 用：换页前手动落盘（PJAX 不触发 pagehide）
    musicApi = { save: function () { saveState(true); } };

    function load(i, force) {
      var next = (i + tracks.length) % tracks.length;
      // 同一首歌不重复赋 src —— 重复赋值会让浏览器丢弃已缓冲的数据重新拉流
      var same = !force && next === index && !!audio.getAttribute("src");
      index = next;
      if (!same) audio.src = tracks[index].src;
      if (titleEl) titleEl.textContent = tracks[index].title;
      return !same;
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
    audio.volume = volume;
    load(resume ? saved.i : 0, true);

    // 恢复上次进度：play 事件可能早于 metadata 就绪（duration 还是 NaN），
    // 所以多个事件都挂，等条件满足时执行一次。
    //
    // 切页后"卡一下"的主因就在这儿：切页必然重建 audio 元素、重新拉流，
    // 此时若还没缓冲够就 currentTime= 跳进度，浏览器会**丢掉已有缓冲重新请求**，
    // 多等一个来回。所以正在播放却只有 metadata 时先忍住，等 canplay 再跳。
    var restored = false;
    function tryRestore() {
      if (!resume || restored) return;
      if (!isFinite(audio.duration) || audio.duration <= 0) return;
      if (!audio.paused && audio.readyState < 3) return; // < HAVE_FUTURE_DATA

      restored = true;
      var t = Math.min(saved.t, Math.max(audio.duration - 1, 0));
      // 差不到半秒就不折腾了，白跳一次还多一次缓冲
      if (t > 0.5) audio.currentTime = t;
    }
    audio.addEventListener("loadedmetadata", tryRestore);
    audio.addEventListener("canplay", tryRestore);
    audio.addEventListener("canplaythrough", tryRestore);
    audio.addEventListener("play", tryRestore);
    audio.addEventListener("playing", tryRestore);

    // 离开页面时保存最新状态（pagehide 在部分场景不触发，补 visibilitychange）
    window.addEventListener("pagehide", function () { saveState(true); });
    doc.addEventListener("visibilitychange", function () {
      if (doc.visibilityState === "hidden") saveState(true);
    });

    // 自动播放：上次在播 / 首次访问 → 尝试响；被浏览器拦则等首次交互。
    //
    // 顺序很关键：先恢复进度再播。若先 play 再 seek，浏览器会先缓冲 0 附近、
    // 跳走后丢弃这段再缓冲一次 —— 听感就是"响了一下 → 卡一下 → 跳回去"。
    var wantPlay = resume ? !!saved.p : true;

    function startPlay() {
      if (!wantPlay || !tracks.length) return;
      audio.play().catch(function () {
        // 自动播放被拦或加载失败：等首次交互再试
        var kick = function () {
          audio.play().catch(function () {});
          window.removeEventListener("pointerdown", kick);
          window.removeEventListener("keydown", kick);
        };
        window.addEventListener("pointerdown", kick);
        window.addEventListener("keydown", kick);
      });
    }

    var started = false;
    var startTimer = 0;
    function startOnce() {
      if (started) return;
      started = true;
      if (startTimer) clearTimeout(startTimer);
      startPlay();
    }

    if (resume && saved.t > 0.5) {
      // 等 tryRestore 把进度跳好（canplay 时已就绪）再开声
      audio.addEventListener("canplay", startOnce);
      // 兜底：网络慢时别一直静音
      startTimer = setTimeout(startOnce, 3000);
    } else {
      startOnce();
    }
  }

  /* ================= 页面级模块（每次导航后重跑） ================= */

  /* ---------- 首页随机背景 ---------- */
  function initPageBg() {
    var root = doc.documentElement;
    var box = doc.getElementById("page-bg");

    // 先清掉上一页残留的背景状态
    root.classList.remove("has-page-bg");
    root.style.removeProperty("--page-bg-image");
    root.style.removeProperty("--page-bg-veil");
    root.style.removeProperty("--egg-image");
    root.style.removeProperty("--egg-veil");
    pageEgg = null;

    if (!box) return;

    var LIST = [];
    var EGG = null;
    try { LIST = JSON.parse(box.getAttribute("data-list")) || []; } catch (e) { LIST = []; }
    try {
      var rawEgg = box.getAttribute("data-egg");
      EGG = rawEgg ? JSON.parse(rawEgg) : null;
    } catch (e) { EGG = null; }
    if (!LIST.length) return;

    /* 每次进入首页都重新抽一张 —— 不写 localStorage / sessionStorage */
    var pick = LIST[Math.floor(Math.random() * LIST.length)];
    pageEgg = EGG;

    root.classList.add("has-page-bg");
    root.style.setProperty("--page-bg-image", 'url("' + pick.src + '")');
    root.style.setProperty("--page-bg-veil", String(pick.veil));

    if (EGG) {
      root.style.setProperty("--egg-image", 'url("' + EGG.src + '")');
      root.style.setProperty("--egg-veil", String(EGG.veil));
    }

    /* 预加载完成再淡入，避免"先空白后跳图" */
    function ready() { box.classList.add("is-ready"); }
    function fail() { root.classList.remove("has-page-bg"); }

    var probe = new Image();
    probe.onload = ready;
    probe.onerror = fail;
    probe.src = pick.src;
    if (probe.complete && probe.naturalWidth) ready();

    /* 彩蛋图不在关键路径上，但一旦触发就要立刻可见。
       等主背景就绪后的空闲时段静默预载，避免第 10 次点击时背景空一帧 */
    if (EGG) {
      var preloadEgg = function () {
        var img = new Image();
        img.decoding = "async";
        img.src = EGG.src;
      };
      if (window.requestIdleCallback) {
        window.requestIdleCallback(preloadEgg, { timeout: 3000 });
      } else {
        setTimeout(preloadEgg, 1200);
      }
    }

    window.__PAGE_BG__ = { list: LIST, pick: pick, egg: EGG };
  }

  /* ---------- 彩蛋：连点头像卡片，切换卡片背景 ---------- */
  function initEgg() {
    var card = doc.querySelector(".hero-side");
    if (!card || !pageEgg || !pageEgg.clicks) return;
    if (card.getAttribute("data-egg-bound") === "1") return;
    card.setAttribute("data-egg-bound", "1");

    var need = pageEgg.clicks;
    var hits = 0;
    var chain = null;
    var loaded = false;

    // 图片就绪后再加 class，避免切换瞬间背景空白
    function revealEgg() { card.classList.add("is-egg"); }

    (function armEgg() {
      var img = new Image();
      img.onload = function () { loaded = true; };
      img.src = pageEgg.src;
    })();

    card.addEventListener("click", function () {
      if (card.classList.contains("is-egg")) return;

      hits++;

      // 两次点击间隔超过 900ms 视为断链，重新计数
      if (chain) clearTimeout(chain);
      chain = setTimeout(function () {
        hits = 0;
        chain = null;
      }, 900);

      if (hits >= need) {
        hits = 0;
        clearTimeout(chain);
        chain = null;

        if (loaded) {
          revealEgg();
        } else {
          // 少见：图还没下完就被点到 10 次，等它到位再切换
          var img = new Image();
          img.onload = function () { loaded = true; revealEgg(); };
          img.onerror = revealEgg;
          img.src = pageEgg.src;
        }
      }
    });
  }

  /* ---------- 目录 TOC（文章页右侧弹出） ---------- */
  function initToc() {
    var tocBox = doc.querySelector("#toc-list");
    var body = doc.querySelector(".post-body");
    if (!tocBox || !body) return;

    var heads = body.querySelectorAll("h2, h3");
    if (!heads.length || !tocPop) {
      if (tocPop) tocPop.style.display = "none";
      return;
    }

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
    tocSync = syncToc;
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
    var handle = tocPop.querySelector(".toc-handle");
    if (handle) {
      handle.addEventListener("click", function () {
        if (tocPop.classList.contains("is-open")) {
          tocPop.classList.remove("is-open");
        } else {
          tocOpen();
        }
      });
    }
  }

  /* ---------- 代码块复制按钮 ---------- */
  function initCodeCopy() {
    Array.prototype.forEach.call(doc.querySelectorAll("figure.highlight"), function (fig) {
      if (fig.querySelector(".copy-btn")) return;
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
  }

  /* ---------- 板块筛选 ---------- */
  function initTopicFilter() {
    var filterBar = doc.querySelector("#topic-filter");
    if (!filterBar) return;

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
  function initReveal() {
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
  }

  /* ---------- 锚点定位（含 PJAX 换页后） ---------- */

  var flashTimer = null;

  // hash 可能是 percent-encoded 的中文（#%E7%BC%96%E7%A8%8B），
  // 拿它去调 querySelector 会直接抛 SyntaxError，只能解码后 getElementById。
  function hashTarget(hash) {
    if (!hash || hash === "#") return null;
    var raw = hash.charAt(0) === "#" ? hash.slice(1) : hash;
    if (!raw) return null;
    var id = raw;
    try { id = decodeURIComponent(raw); } catch (e) { /* 非法转义就按原样找 */ }
    return doc.getElementById(id) || doc.getElementById(raw);
  }

  // 落点闪一下边框，确认真的跳到位了
  function flashTarget(el) {
    if (!el || !el.classList.contains("topic-card")) return;
    if (flashTimer) { clearTimeout(flashTimer); flashTimer = null; }
    var on = doc.querySelectorAll(".topic-card.is-target");
    Array.prototype.forEach.call(on, function (n) { n.classList.remove("is-target"); });
    void el.offsetWidth; // 强制重排，否则同一个元素连点两次动画不会重播
    el.classList.add("is-target");
    flashTimer = setTimeout(function () {
      el.classList.remove("is-target");
      flashTimer = null;
    }, 1700);
  }

  function scrollToHash(hash) {
    var el = hashTarget(hash);
    if (!el) return false;
    var hdr = doc.querySelector(".site-header");
    // 顶栏是 sticky 的，落到目标上时得把它的高度补回来
    var offset = (hdr ? hdr.getBoundingClientRect().height : 68) + 16;
    var y = el.getBoundingClientRect().top +
      (window.pageYOffset || doc.documentElement.scrollTop) - offset;
    // 必须是 instant：behavior:"auto" 会跟随 html 上的 scroll-behavior:smooth，
    // 首屏加载期间的平滑滚动会被打断，落点就偏了（实测偏 130px+）
    window.scrollTo({ top: Math.max(0, y), behavior: "instant" });
    flashTarget(el);
    return true;
  }

  /* ---------- 评论（Utterances + 本机管理态） ---------- */
  function initComments() {
    var host = doc.getElementById("comments-utterances");
    if (!host) return;

    var repo = host.getAttribute("data-repo");
    var issueTerm = host.getAttribute("data-issue-term") || "pathname";
    var theme = host.getAttribute("data-theme") || "github-light";
    var label = host.getAttribute("data-label") || "";
    var admin = host.getAttribute("data-admin") || "";
    var localKey = host.getAttribute("data-local-admin-key") || "taole-admin";
    var issueUrl = host.getAttribute("data-issue-url") || location.pathname;

    // 1) 加载 Utterances 脚本。Utterances 内部会用 pathname 创建/查询 Issue
    var s = doc.createElement("script");
    s.src = "https://utteranc.es/client.js";
    s.setAttribute("repo", repo);
    s.setAttribute("issue-term", issueTerm);
    s.setAttribute("theme", theme);
    if (label) s.setAttribute("label", label);
    s.setAttribute("crossorigin", "anonymous");
    s.async = true;
    host.appendChild(s);

    // 2) 构造"在 GitHub 上管理"的直达链接。
    //    Utterances 创建的 issue 标题是文章标题；body 里带 URL 路径。
    //    GitHub 搜索语法 in:title 支持中英文 + URL 片段；用 is:issue 限定类型。
    var manageLink = doc.getElementById("comments-manage");
    var hint = doc.getElementById("comments-admin-hint");

    function buildSearch() {
      var q = "is:issue " + repo.split("/")[1] + " " + issueUrl;
      return "https://github.com/" + repo + "/issues?q=" + encodeURIComponent(q);
    }
    function buildRepoIssues() {
      // 备用：先列所有评论 issue（按 label 过滤）
      return "https://github.com/" + repo + "/issues?q=is%3Aissue+" +
             (label ? "label%3A" + encodeURIComponent(label) : "");
    }

    function isLocalAdmin() {
      try { return localStorage.getItem(localKey) === "1"; } catch (e) { return false; }
    }

    function showManage() {
      if (!manageLink) return;
      // 本机管理态：精确搜索当前文章的 issue；
      // 非本机（或未登录仓库写权限）：只显示一个温和的"在 GitHub 上管理"入口
      manageLink.setAttribute("href", isLocalAdmin() ? buildSearch() : buildRepoIssues());
      manageLink.hidden = false;
    }

    if (manageLink) showManage();
    if (hint) hint.hidden = !isLocalAdmin();

    // 3) 监听 Utterances iframe 的 postMessage，识别当前登录用户。
    //    官方从 v0.x 起就发 {type:"signin", user:{login:...}}，origin 固定为 utteranc.es。
    var me = null;
    window.addEventListener("message", function (ev) {
      if (ev.origin !== "https://utteranc.es") return;
      var data;
      try { data = typeof ev.data === "string" ? JSON.parse(ev.data) : ev.data; } catch (e) { return; }
      if (!data || data.type !== "signin" || !data.user) return;
      me = (data.user.login || "").toLowerCase();
      // 命中的就是仓库 owner → 把整个评论区标成"作者本人"，让所有人能看到这是站长在说话
      if (admin && me === admin.toLowerCase()) {
        host.setAttribute("data-signed-in", "owner");
      }
      // 登录后顺便把"管理评论"链接指向这篇文章对应的 issue（精确搜索）
      if (manageLink && isLocalAdmin()) {
        manageLink.setAttribute("href", buildSearch());
      }
    });
  }

  /* ---------- 每次导航后重跑 ---------- */
  function initPage() {
    header = doc.querySelector(".site-header");
    toTop = doc.querySelector(".to-top");
    // 上一页的 TOC 滚动监听要解绑，否则旧闭包一直跑（还引用已移除的节点）
    if (tocSync) {
      window.removeEventListener("scroll", tocSync);
      tocSync = null;
    }
    tocPop = doc.getElementById("toc-pop");

    initPageBg();
    initEgg();
    initToc();
    initComments();
    initCodeCopy();
    initTopicFilter();
    initReveal();

    onScroll();
    if (updateEdge) updateEdge();

    // PJAX 换页不触发浏览器的原生锚点跳转，得自己补一次
    if (location.hash) scrollToHash(location.hash);
  }

  /* ================= PJAX：切页不重建文档，音乐不断 ================= */

  function initPjax() {
    if (!window.history || !window.history.pushState || !window.fetch) return;
    if (location.protocol === "file:") return;

    var busy = false;
    var supportsRel = window.DOMParser && "replaceChildren" in document.body;

    function isInternal(a) {
      if (!a || !a.getAttribute) return false;
      var href = a.getAttribute("href");
      if (!href) return false;
      if (href.charAt(0) === "#") return false;
      if (a.target && a.target !== "" && a.target !== "_self") return false;
      if (a.hasAttribute("download")) return false;
      var rel = a.getAttribute("rel");
      if (rel && /\bexternal\b/.test(rel)) return false;
      if (a.origin !== location.origin) return false;
      // 带扩展名的资源不是页面（atom.xml / *.pdf / *.zip / *.mp3 …）。
      // 接管了就会拿 DOMParser 按 HTML 去解析 XML，然后把整个 body 换掉，
      // 访客看到的就是一个空白页 —— 这类链接一律交给浏览器默认行为。
      var tail = a.pathname.slice(a.pathname.lastIndexOf("/") + 1);
      if (tail && tail.indexOf(".") !== -1 && !/\.html?$/i.test(tail)) return false;
      // 同页（仅 hash 变化）交给浏览器默认行为
      if (a.pathname === location.pathname && a.search === location.search) return false;
      return true;
    }

    doc.addEventListener("click", function (e) {
      if (!supportsRel) return;
      if (e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      var a = e.target.closest("a");
      if (!isInternal(a)) return;
      e.preventDefault();
      go(a.href, false);
    });

    // 页面上当前挂着的文档是哪个（不含 hash）。
    // 点击 <a href="#锚点"> 也会触发 popstate，但那只是同文档内的位置变化，
    // 不能当成换页 —— 否则会对同一个页面再跑一遍 PJAX（fetch + 重建 body），
    // 结果就是目录/锚点跳转变成瞬移（PJAX 里用的是 instant 定位），
    // 而且 fetch 一失败还会 location.href 整页重载，音乐直接断。
    var docKey = location.pathname + location.search;

    function sameDoc() {
      return location.pathname + location.search === docKey;
    }

    window.addEventListener("popstate", function (e) {
      // 同文档（只是 hash 变了）：交给浏览器原生锚点行为，它是平滑的
      if (sameDoc()) {
        doc.documentElement.classList.remove("is-pjaxing");
        flashTarget(hashTarget(location.hash));
        return;
      }
      var y = (e.state && e.state.y) ? e.state.y : 0;
      go(location.href, true, y);
    });

    function go(url, isPop, restoreY) {
      if (busy) return;
      busy = true;
      doc.documentElement.classList.add("is-pjaxing");

      // PJAX 不会触发 pagehide，这里手动把音乐进度落盘
      if (musicApi && musicApi.save) musicApi.save();

      fetch(url, { credentials: "same-origin" })
        .then(function (r) {
          if (!r.ok) throw new Error("HTTP " + r.status);
          // 不是 HTML 就别换页（比如误接了 /atom.xml），交给整页导航
          var ct = r.headers.get("content-type") || "";
          if (ct.indexOf("text/html") === -1) throw new Error("not html: " + ct);
          return r.text();
        })
        .then(function (html) {
          swap(html, url, isPop, restoreY);
          busy = false;
          doc.documentElement.classList.remove("is-pjaxing");
        })
        .catch(function () {
          busy = false;
          doc.documentElement.classList.remove("is-pjaxing");
          location.href = url; // 任何异常都退回整页导航
        });
    }

    function swap(html, url, isPop, restoreY) {
      var next = new DOMParser().parseFromString(html, "text/html");
      if (!next || !next.body) { location.href = url; return; }

      // 新文档里的播放器丢掉，保留现有实例 —— audio 不重建，声音就不断
      var dup = next.querySelector("#music-player");
      if (dup) dup.remove();

      var keep = doc.getElementById("music-player");
      if (keep) keep.remove();

      var frag = doc.createDocumentFragment();
      Array.prototype.forEach.call(next.body.childNodes, function (node) {
        // script 跳过：theme.js 已在运行，插进来的脚本不会执行也没必要
        if (node.nodeType === 1 && node.tagName === "SCRIPT") return;
        frag.appendChild(doc.importNode(node, true));
      });

      doc.body.replaceChildren(frag);
      if (keep) doc.body.appendChild(keep);

      if (next.title) doc.title = next.title;
      var desc = next.querySelector('meta[name="description"]');
      var curDesc = doc.querySelector('meta[name="description"]');
      if (desc && curDesc) curDesc.setAttribute("content", desc.getAttribute("content") || "");

      if (!isPop) {
        // 记下当前滚动位置，供后退时恢复
        history.replaceState({ pjax: true, y: window.pageYOffset }, "", location.href);
        history.pushState({ pjax: true, y: 0 }, "", url);
      }

      // 基线跟着换页走：上面 popstate 里的 sameDoc() 靠它判断
      // 「hash 变了」还是「换页了」，不更新的话第二次切页起就会误判
      docKey = location.pathname + location.search;

      initPage();
      // initPage 里已经按 hash 定位过就别再拉回顶部
      if (!location.hash || !hashTarget(location.hash)) {
        // 同样必须 instant，否则 PJAX 换页会肉眼可见地「滑」回顶部
        window.scrollTo({ top: isPop ? (restoreY || 0) : 0, behavior: "instant" });
      }
    }
  }

  /* ================= 启动 ================= */
  initMusic();
  initEdge();
  initPage();
  initPjax();

  // 同页换 hash 的滚动交给浏览器（smooth），这里只补一下落点高亮。
  // PJAX 走 pushState，不会触发 hashchange，所以不会和上面重复。
  window.addEventListener("hashchange", function () {
    flashTarget(hashTarget(location.hash));
  });
})();
