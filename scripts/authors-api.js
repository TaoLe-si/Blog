'use strict';

/**
 * 多作者登记 + 静态 JSON API。
 *
 * 数据源：source/_data/authors.yml
 * 文章 front-matter 的 author 可以是登记 id、GitHub 登录名、或 GitHub URL。
 * 不写（Hexo 会填上 config.author）则落到 default。
 *
 * 生成：
 *   api/authors.json
 *   api/authors/<id>.json
 */

const RESERVED = new Set(['default', 'authors', 'people']);

function githubLogin(input) {
  if (input == null) return '';
  const s = String(input).trim();
  if (!s) return '';
  const url = s.match(/github\.com\/([^/?#]+)/i);
  if (url) return url[1];
  if (/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(s)) return s;
  return '';
}

function githubUrl(login) {
  return login ? 'https://github.com/' + login : '';
}

function githubAvatar(login, size) {
  const px = parseInt(size, 10) > 0 ? parseInt(size, 10) : 128;
  return login ? 'https://github.com/' + login + '.png?size=' + px : '';
}

function safeId(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function themeCfg(hexo) {
  return (hexo.theme && hexo.theme.config) || {};
}

function rawRegistry(hexo, locals) {
  const data =
    (locals && locals.data) ||
    (hexo.locals && typeof hexo.locals.get === 'function' && hexo.locals.get('data')) ||
    {};
  return data.authors || {};
}

function registeredPeople(raw) {
  const people = {};
  if (!raw || typeof raw !== 'object') return people;
  const nested = raw.people || raw.authors;
  const src = nested && typeof nested === 'object' && !Array.isArray(nested) ? nested : raw;
  Object.keys(src).forEach((key) => {
    if (RESERVED.has(key)) return;
    const row = src[key];
    if (!row || typeof row !== 'object') return;
    people[key] = row;
  });
  return people;
}

function withRoot(hexo, p) {
  if (!p) return '';
  if (/^(https?:)?\/\//i.test(p) || p.indexOf('data:') === 0) return p;
  const root = String(hexo.config.root || '/').replace(/\/$/, '');
  return (root + '/' + String(p).replace(/^\//, '')).replace(/\/{2,}/g, '/');
}

function pack(id, row, hexo) {
  const t = themeCfg(hexo);
  const login = githubLogin(row.github || row.url || '') || githubLogin(id);
  const name = row.name || hexo.config.author || login || id;
  const avatar =
    row.avatar ||
    githubAvatar(login, 128) ||
    (t.avatar ? withRoot(hexo, t.avatar) : '') ||
    withRoot(hexo, '/images/avatar.jpg');
  return {
    id,
    name,
    github: login,
    url: row.url || githubUrl(login),
    avatar,
    bio: row.bio != null ? String(row.bio) : '',
  };
}

function siteFallback(hexo) {
  const t = themeCfg(hexo);
  const login = githubLogin(t.social && t.social.github) || 'TaoLe-si';
  return pack(safeId(login) || 'taole', {
    name: hexo.config.author || '桃',
    github: login,
    bio: t.bio || '',
  }, hexo);
}

function catalog(hexo, locals) {
  const raw = rawRegistry(hexo, locals);
  const people = registeredPeople(raw);
  const byId = {};
  const byGithub = {};
  const byName = {};

  Object.keys(people).forEach((id) => {
    const a = pack(id, people[id], hexo);
    byId[id] = a;
    if (a.github) byGithub[a.github.toLowerCase()] = a;
    if (a.name) byName[a.name] = a;
  });

  const fallback = siteFallback(hexo);
  const defaultId =
    (typeof raw.default === 'string' && raw.default) ||
    (byId.taole && 'taole') ||
    fallback.id;
  if (!byId[defaultId]) {
    byId[defaultId] = Object.assign({}, fallback, { id: defaultId });
    if (byId[defaultId].github) byGithub[byId[defaultId].github.toLowerCase()] = byId[defaultId];
    byName[byId[defaultId].name] = byId[defaultId];
  }

  return { defaultId, byId, byGithub, byName, fallback };
}

function resolve(rawAuthor, hexo, locals) {
  const cat = catalog(hexo, locals);
  const key = rawAuthor == null ? '' : String(rawAuthor).trim();
  const siteName = String(hexo.config.author || '').trim();

  if (!key || key === siteName) return Object.assign({}, cat.byId[cat.defaultId]);
  if (cat.byId[key]) return Object.assign({}, cat.byId[key]);

  const login = githubLogin(key);
  if (login && cat.byGithub[login.toLowerCase()]) {
    return Object.assign({}, cat.byGithub[login.toLowerCase()]);
  }
  if (cat.byName[key]) return Object.assign({}, cat.byName[key]);

  if (login) {
    return pack(safeId(login) || login, { name: login, github: login }, hexo);
  }

  const id = safeId(key) || 'author';
  return pack(id, { name: key }, hexo);
}

function publicAuthor(a, extra) {
  const out = {
    id: a.id,
    name: a.name,
    github: a.github,
    url: a.url,
    avatar: a.avatar,
  };
  if (a.bio) out.bio = a.bio;
  return Object.assign(out, extra || {});
}

function postRecord(hexo, post) {
  const cats = post.categories
    ? post.categories.toArray().map((c) => c.name)
    : [];
  const rel = String(post.path || '').replace(/\\/g, '/').replace(/index\.html$/, '');
  const path = withRoot(hexo, rel);
  const site = String(hexo.config.url || '').replace(/\/$/, '');
  const root = String(hexo.config.root || '/').replace(/\/$/, '');
  const suffix = root && path.indexOf(root) === 0 ? path.slice(root.length) : path;
  return {
    title: post.title,
    path,
    url: site + (suffix.charAt(0) === '/' ? suffix : '/' + suffix),
    date: post.date ? post.date.toISOString() : '',
    categories: cats,
  };
}

hexo.extend.helper.register('author_of', function (page) {
  const locals = this.site || {};
  return resolve(page && page.author, hexo, locals);
});

hexo.extend.helper.register('default_author', function () {
  const locals = this.site || {};
  const cat = catalog(hexo, locals);
  return Object.assign({}, cat.byId[cat.defaultId]);
});

hexo.extend.generator.register('authors-api', function (locals) {
  const cat = catalog(hexo, locals);
  const buckets = {};

  Object.keys(cat.byId).forEach((id) => {
    buckets[id] = { author: cat.byId[id], posts: [] };
  });

  locals.posts.sort('date', -1).forEach((post) => {
    const a = resolve(post.author, hexo, locals);
    if (!buckets[a.id]) buckets[a.id] = { author: a, posts: [] };
    buckets[a.id].posts.push(postRecord(hexo, post));
  });

  const list = Object.keys(buckets)
    .map((id) => {
      const b = buckets[id];
      return publicAuthor(b.author, { posts: b.posts.length });
    })
    .sort((x, y) => x.id.localeCompare(y.id));

  const index = {
    version: 1,
    default: cat.defaultId,
    authors: list,
  };

  const routes = [
    { path: 'api/authors.json', data: JSON.stringify(index, null, 2) + '\n' },
  ];

  Object.keys(buckets).forEach((id) => {
    if (!/^[a-z0-9_-]+$/i.test(id)) return;
    const b = buckets[id];
    const body = publicAuthor(b.author, {
      default: id === cat.defaultId,
      posts: b.posts,
    });
    routes.push({
      path: 'api/authors/' + id + '.json',
      data: JSON.stringify(body, null, 2) + '\n',
    });
  });

  return routes;
});
