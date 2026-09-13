'use strict';

/**
 * 把 node_modules/katex/dist 里的 CSS + 字体拷进站点，
 * 保证预渲染 HTML 和样式、字体是同一版本。
 */
const fs = require('fs');
const path = require('path');

hexo.extend.generator.register('katex-assets', () => {
  const dist = path.join(hexo.base_dir, 'node_modules', 'katex', 'dist');
  const css = path.join(dist, 'katex.min.css');
  const fontDir = path.join(dist, 'fonts');
  const out = [];

  if (!fs.existsSync(css)) {
    hexo.log.error('[katex-assets] 找不到 %s', css);
    return out;
  }

  out.push({
    path: 'css/katex/katex.min.css',
    data: () => fs.createReadStream(css),
  });

  if (fs.existsSync(fontDir)) {
    for (const name of fs.readdirSync(fontDir)) {
      out.push({
        path: 'css/katex/fonts/' + name,
        data: () => fs.createReadStream(path.join(fontDir, name)),
      });
    }
  }

  return out;
});
