<?xml version="1.0" encoding="UTF-8"?>
<!--
  atom.xml 的浏览器样式表。

  Hexo 生成的 atom.xml 缺 xml-stylesheet 处理指令，浏览器直接打开就摊出裸 XML
  （Chrome 会提示「没有定义样式的 xml」）。这个文件由 scripts/feed-stylesheet.js
  在 after_generate 阶段挂到 atom.xml 上，把订阅源渲染成一个正常的列表页。

  注意：XSLT 1.0，浏览器只支持这一版。不要用 2.0 的语法。
  输出走 method="html"，所以结果会被当 HTML 解析，样式才能照常生效。

  另：文章正文在 feed 里是 CDATA 包着的 HTML 源码，XSLT 拿到的是一整段文本，
  没法还原成节点树，所以这里只列标题+日期，不做摘要。想要摘要去正文页。
-->
<xsl:stylesheet version="1.0"
                xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
                xmlns:atom="http://www.w3.org/2005/Atom"
                exclude-result-prefixes="atom">

  <xsl:output method="html" encoding="UTF-8" indent="yes" omit-xml-declaration="yes"/>

  <xsl:template match="/">
    <html lang="zh-CN">
      <head>
        <meta charset="UTF-8"/>
        <meta name="viewport" content="width=device-width, initial-scale=1"/>
        <meta name="robots" content="noindex"/>
        <title>订阅源 · <xsl:value-of select="atom:feed/atom:title"/></title>
        <style>
          :root {
            color-scheme: light dark;
            --bg: #fbfaf9; --card: #ffffff; --text: #1b1a19;
            --soft: #55504b; --mute: #8d8781; --line: #e8e4e1;
            --accent: #5b5bd6; --softbg: rgba(91, 91, 214, .08);
          }
          @media (prefers-color-scheme: dark) {
            :root {
              --bg: #12111a; --card: #1c1a29; --text: #efedf8;
              --soft: #b6b1cb; --mute: #817c98; --line: #2e2b40;
              --accent: #8f8ff0; --softbg: rgba(143, 143, 240, .12);
            }
          }
          * { box-sizing: border-box; }
          body {
            margin: 0; background: var(--bg); color: var(--text);
            font: 16px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI",
                  "PingFang SC", "Microsoft YaHei", sans-serif;
            -webkit-font-smoothing: antialiased;
          }
          a { color: inherit; text-decoration: none; }
          .wrap { max-width: 720px; margin: 0 auto; padding: 64px 24px 96px; }

          .chip {
            display: inline-block; padding: 4px 10px; border-radius: 999px;
            font-size: 12px; font-weight: 600; letter-spacing: .1em;
            text-transform: uppercase; color: var(--accent); background: var(--softbg);
          }
          h1 { font-size: 30px; line-height: 1.25; letter-spacing: -.02em; margin: 18px 0 6px; }
          .sub { margin: 0; color: var(--soft); }
          .tip { margin: 24px 0 0; color: var(--mute); font-size: 14px; }

          .row { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-top: 18px; }
          .url {
            flex: 1 1 260px; min-width: 0; padding: 10px 14px;
            border: 1px solid var(--line); border-radius: 10px; background: var(--card);
            color: var(--mute); overflow-wrap: anywhere;
            font: 13px/1.5 ui-monospace, Consolas, Menlo, monospace;
          }
          .btn {
            flex: none; padding: 10px 18px; border-radius: 10px;
            background: var(--accent); color: #fff; font-size: 14px; font-weight: 600;
          }

          .list { list-style: none; margin: 44px 0 0; padding: 0; border-top: 1px solid var(--line); }
          .list li {
            display: flex; align-items: baseline; gap: 16px;
            padding: 16px 4px; border-bottom: 1px solid var(--line);
          }
          .d {
            flex: none; order: -1; width: 96px; color: var(--mute);
            font: 13px/1.6 ui-monospace, Consolas, Menlo, monospace;
          }
          .t { flex: 1 1 auto; min-width: 0; font-size: 17px; font-weight: 600; letter-spacing: -.01em; }
          .t:hover { color: var(--accent); }
          .tags { flex: none; color: var(--mute); font-size: 12px; }
          .ft { margin-top: 28px; color: var(--mute); font-size: 13px; }

          @media (max-width: 520px) {
            h1 { font-size: 24px; }
            .list li { flex-wrap: wrap; gap: 4px; }
            .d { order: -1; width: auto; }
            .tags { display: none; }
          }
        </style>
      </head>

      <body>
        <div class="wrap">
          <header>
            <span class="chip">Atom 订阅源</span>
            <h1><xsl:value-of select="atom:feed/atom:title"/></h1>
            <xsl:if test="atom:feed/atom:subtitle">
              <p class="sub"><xsl:value-of select="atom:feed/atom:subtitle"/></p>
            </xsl:if>

            <p class="tip">
              这是给 RSS 阅读器用的文件，不是页面坏了。把下面这个地址填进你的阅读器；
              或者直接往下看，共 <xsl:value-of select="count(atom:feed/atom:entry)"/> 篇。
            </p>

            <div class="row">
              <code class="url"><xsl:value-of select="atom:feed/atom:link[@rel='self']/@href"/></code>
              <a class="btn" href="{string(atom:feed/atom:link[not(@rel)]/@href)}">回到博客</a>
            </div>
          </header>

          <ol class="list">
            <xsl:for-each select="atom:feed/atom:entry">
              <li>
                <a class="t" href="{string(atom:link/@href)}">
                  <xsl:choose>
                    <xsl:when test="string-length(atom:title) = 0">(无标题)</xsl:when>
                    <xsl:otherwise><xsl:value-of select="atom:title"/></xsl:otherwise>
                  </xsl:choose>
                </a>
                <span class="d">
                  <xsl:value-of select="substring(atom:published, 1, 10)"/>
                </span>
                <xsl:if test="atom:category">
                  <span class="tags">
                    <xsl:for-each select="atom:category">
                      <xsl:if test="position() &gt; 1"> · </xsl:if><xsl:value-of select="@term"/>
                    </xsl:for-each>
                  </span>
                </xsl:if>
              </li>
            </xsl:for-each>
          </ol>

          <p class="ft">
            最近更新：
            <xsl:value-of select="substring(atom:feed/atom:updated, 1, 10)"/>
            <xsl:text> </xsl:text>
            <xsl:value-of select="substring(atom:feed/atom:updated, 12, 5)"/>
          </p>
        </div>
      </body>
    </html>
  </xsl:template>

</xsl:stylesheet>
