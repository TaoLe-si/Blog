'use strict';

/**
 * 给 CSS/JS 加内容指纹，解决「改完样式，用户浏览器还在用旧文件」。
 *
 * 背景：GitHub Pages 对静态资源下发 `Cache-Control: max-age=600`，
 * 而 <link>/<script> 的 URL 一直是 /css/style.css，内容变了 URL 没变，
 * 于是浏览器在 10 分钟内继续用本地缓存 —— 表现就是「我明明部署了，但页面没变」。
 *
 * 用法：模板里把 url_for('/css/style.css') 换成 asset_url('/css/style.css')，
 * 输出形如 /Blog/css/style.css?v=9f3a1b2c。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const memo = new Map(); // abs -> { mtimeMs, size, hash }

function contentHash(abs) {
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch (e) {
    return 'miss';
  }

  const hit = memo.get(abs);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.hash;

  let hash = '0';
  try {
    hash = crypto.createHash('md5').update(fs.readFileSync(abs)).digest('hex').slice(0, 8);
  } catch (e) {
    hexo.log.warn('[asset_url] 读取失败 %s: %s', abs, e.message);
  }

  memo.set(abs, { mtimeMs: stat.mtimeMs, size: stat.size, hash });
  return hash;
}

hexo.extend.helper.register('asset_url', function (p) {
  const raw = String(p);

  // 外链 / data URI / 已带 query 的，原样放行
  if (/^(https?:)?\/\//.test(raw) || raw.indexOf('data:') === 0 || raw.indexOf('?') >= 0) {
    return raw;
  }

  const rel = raw.replace(/^\//, '');
  const abs = path.join(hexo.theme_dir, 'source', rel);
  const h = contentHash(abs);

  // 文件不存在时不加 query，避免 ?v=miss 污染
  if (h === 'miss') {
    hexo.log.warn('[asset_url] 主题资源不存在: %s', abs);
    return this.url_for(raw);
  }

  return this.url_for(raw) + '?v=' + h;
});
