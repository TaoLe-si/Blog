'use strict';

/**
 * 给 atom.xml 挂上 XSL 样式表，顺手把时间戳换成站点时区。
 *
 * 起因：hexo-generator-feed 只吐裸 XML，浏览器打开会直接摊出源码
 * （Chrome 的提示是「没有定义样式的 xml」）。访客点侧栏那个 RSS 图标
 * 就会以为站点坏了。挂上 xml-stylesheet 后浏览器渲染成正常列表页。
 *
 * 实现走 hexo.route 包装，而不是直接改 public/atom.xml，原因：
 *   after_generate 过滤器跑在 _routerRefresh 之后、**写盘之前**
 *   （见 hexo/dist/hexo/index.js 的 _generate → execFilter('after_generate')，
 *   真正落盘在 console/generate.js 里）。所以在过滤器里读文件会读到上一次的产物
 *   —— 增量构建时"碰巧能用"，hexo clean 之后就直接失效，非常难查。
 *   包在路由上，generate / deploy / server 三条路都必然生效。
 *
 * 另外包装的是路由内容而不是 fork 一份插件模板（feed.template）：
 * 模板抄一份就和插件版本脱钩了，插件升级会静默丢改动。
 */

const fs = require('fs');
const path = require('path');

const STYLESHEET = 'atom.xsl'; // 放在 source/atom.xsl，构建后是 public/atom.xsl

/** 求某个时刻在指定时区相对 UTC 的分钟偏移（含夏令时） */
function tzOffsetMinutes(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(date).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});

  // hour12:false 在部分环境下会把午夜给成 "24"
  let hour = parseInt(parts.hour, 10);
  if (hour === 24) hour = 0;

  const asIfUtc = Date.UTC(
    parseInt(parts.year, 10),
    parseInt(parts.month, 10) - 1,
    parseInt(parts.day, 10),
    hour,
    parseInt(parts.minute, 10),
    parseInt(parts.second, 10)
  );

  // 抹掉毫秒再比，避免出现小数分钟
  return Math.round((asIfUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

/** 2026-09-12T16:30:00.000Z + Asia/Shanghai → 2026-09-13T00:30:00+08:00 */
function toOffsetIso(iso, timeZone) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;

  let off;
  try {
    off = tzOffsetMinutes(d, timeZone);
  } catch (e) {
    return iso; // 时区名认不出来（node 没带全 ICU），保持原样
  }
  if (!isFinite(off)) return iso;

  const shifted = new Date(d.getTime() + off * 60000);
  const sign = off < 0 ? '-' : '+';
  const abs = Math.abs(off);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');

  return shifted.toISOString().replace(/\.\d{3}Z$/, '') + sign + hh + ':' + mm;
}

// 只认严格 UTC 形式。页面上的日期是 substring(xslt, 1, 10) 取出来的，
// 不换成站点时区的话，晚上 8 点后发的文章日期会少一天。
// 而带偏移的值不能重复平移，否则每构建一次就往后挪一天。
const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function transform(xml, opts) {
  let out = xml;

  if (opts.timeZone && opts.timeZone !== 'UTC') {
    out = out.replace(/<(published|updated)>([^<]+)<\/\1>/g, function (whole, tag, iso) {
      const v = iso.trim();
      if (!UTC_ISO.test(v)) return whole;
      return '<' + tag + '>' + toOffsetIso(v, opts.timeZone) + '</' + tag + '>';
    });
  }

  // 已经挂过就别重复插
  if (out.indexOf('xml-stylesheet') === -1) {
    const pi = '<?xml-stylesheet type="text/xsl" href="' + opts.href + '"?>';
    const decl = out.match(/^\s*<\?xml[^>]*\?>\s*/);
    out = decl ? decl[0] + pi + '\n' + out.slice(decl[0].length) : pi + '\n' + out;
  }

  return out;
}

function readStream(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (d) => chunks.push(Buffer.from(d)));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}

hexo.extend.filter.register('after_generate', function () {
  const feedName = (hexo.config.feed && hexo.config.feed.path) || 'atom.xml';

  const current = hexo.route.get(feedName);
  if (!current) return;

  const opts = {
    href: (hexo.config.root || '/') + STYLESHEET,
    timeZone: hexo.config.timezone || 'UTC'
  };

  // 查 source/ 而不是 public/ —— 这个时点产物还没落盘，查 public 会误报
  if (!fs.existsSync(path.join(hexo.source_dir, STYLESHEET))) {
    hexo.log.warn('[feed-stylesheet] 找不到 source/%s，浏览器打开还会是裸 XML', STYLESHEET);
  }

  // 包一层：原本的 route 数据（生成器给的裸 XML）读出来改完再交出去
  hexo.route.set(feedName, function () {
    return readStream(current).then((xml) => transform(xml, opts));
  });

  hexo.log.info('[feed-stylesheet] %s 已挂上 %s（时区 %s）', feedName, opts.href, opts.timeZone);
});
