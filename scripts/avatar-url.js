'use strict';

/**
 * 头像地址解析：theme.avatar 优先，留空则从 theme.social.github 推 GitHub 头像。
 *
 * 用法（EJS）：avatar_url()  → 默认 128px；avatar_url(256) → 指定像素。
 *
 * GitHub 头像直链形如 https://github.com/<user>.png?size=128，
 * 会 302 到 avatars.githubusercontent.com，浏览器直接当图片用。
 * 模板里请配套 width/height 属性，避免加载完成时顶栏跳一下。
 */

hexo.extend.helper.register('avatar_url', function (size) {
  const t = this.theme || {};
  const px = parseInt(size, 10) > 0 ? parseInt(size, 10) : 128;

  // 主题里显式配了就用它（本地文件或完整 URL 都走 url_for）
  if (t.avatar) return this.url_for(t.avatar);

  const gh = (t.social && t.social.github) || '';
  const m = String(gh).match(/github\.com\/([^/?#]+)/i);
  if (m) return 'https://github.com/' + m[1] + '.png?size=' + px;

  // 兜底：主题内置头像
  return this.url_for('/images/avatar.jpg');
});
