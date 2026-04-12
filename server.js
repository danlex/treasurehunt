#!/usr/bin/env node
// Local review server for Treasure Hunt.
// - Serves review.html at /
// - Exposes state at /api/state
// - POST /api/like/:id   → moves item to posts.json, commits and pushes to GitHub Pages, updates preferences
// - POST /api/dislike/:id → moves item to rejected.json, updates preferences (no push — local only)

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3737);
const HOST = '127.0.0.1';

const FILES = {
  queue:       path.join(ROOT, 'queue.json'),
  posts:       path.join(ROOT, 'posts.json'),
  rejected:    path.join(ROOT, 'rejected.json'),
  preferences: path.join(ROOT, 'preferences.json'),
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const readJson  = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const writeJson = (p, d) => fs.writeFileSync(p, JSON.stringify(d, null, 2) + '\n');

function bump(bucket, key, field) {
  if (!bucket[key]) bucket[key] = { likes: 0, dislikes: 0 };
  bucket[key][field] += 1;
}

function applyLearning(item, verdict) {
  const prefs = readJson(FILES.preferences);
  const field = verdict === 'like' ? 'likes' : 'dislikes';
  bump(prefs.categories, item.category, field);
  (item.tags || []).forEach(t => bump(prefs.tags, t, field));
  if (item.source) bump(prefs.sources, item.source, field);
  prefs.totals[field] = (prefs.totals[field] || 0) + 1;
  prefs.lastUpdated = new Date().toISOString();
  writeJson(FILES.preferences, prefs);
}

function gitPush(msg) {
  const cmd =
    `node build.js && ` +
    `git add posts.json preferences.json queue.json index.html sitemap.xml feed.xml robots.txt posts/ && ` +
    `git -c user.email="danlex@users.noreply.github.com" -c user.name="danlex" commit -m ${JSON.stringify(msg)} && ` +
    `git push`;
  try {
    execSync(cmd, { cwd: ROOT, stdio: 'pipe' });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.stderr || e.message || e) };
  }
}

function sendJson(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendFile(res, rel) {
  const ext = path.extname(rel).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  try {
    const data = fs.readFileSync(path.join(ROOT, rel));
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

const SAFE_STATICS = new Set(['review.html', 'favicon.svg']);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const { pathname } = url;

  // CORS for same-origin use — tight anyway because we bind 127.0.0.1
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
    return res.end();
  }

  if (req.method === 'GET' && pathname === '/') {
    return sendFile(res, 'review.html');
  }
  if (req.method === 'GET' && SAFE_STATICS.has(pathname.slice(1))) {
    return sendFile(res, pathname.slice(1));
  }
  if (req.method === 'GET' && pathname === '/api/state') {
    try {
      return sendJson(res, 200, {
        queue:       readJson(FILES.queue),
        posts:       readJson(FILES.posts),
        rejected:    readJson(FILES.rejected),
        preferences: readJson(FILES.preferences),
      });
    } catch (e) {
      return sendJson(res, 500, { error: String(e) });
    }
  }

  const m = pathname.match(/^\/api\/(like|dislike)\/([\w-]+)$/);
  if (req.method === 'POST' && m) {
    const [, action, id] = m;
    try {
      const queue = readJson(FILES.queue);
      const idx = queue.findIndex(it => it.id === id);
      if (idx < 0) return sendJson(res, 404, { error: 'not in queue' });
      const [item] = queue.splice(idx, 1);
      writeJson(FILES.queue, queue);

      if (action === 'like') {
        const posts = readJson(FILES.posts);
        posts.unshift({ ...item, publishedAt: new Date().toISOString() });
        writeJson(FILES.posts, posts);
        applyLearning(item, 'like');
        const push = gitPush(`Publish: ${item.title}`);
        return sendJson(res, 200, { ok: true, action, published: push.ok, error: push.error || null });
      } else {
        const rejected = readJson(FILES.rejected);
        rejected.unshift({ ...item, rejectedAt: new Date().toISOString() });
        writeJson(FILES.rejected, rejected);
        applyLearning(item, 'dislike');
        return sendJson(res, 200, { ok: true, action });
      }
    } catch (e) {
      return sendJson(res, 500, { error: String(e) });
    }
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Treasure Hunt review  →  http://${HOST}:${PORT}\n`);
});
