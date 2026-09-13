/* TaoLe's Blog — 主题交互 */
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
})();
