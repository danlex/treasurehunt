#!/usr/bin/env node
// Local review server for Treasure Hunt.
// - Serves review.html at /
// - Exposes state at /api/state
// - POST /api/like/:id   → moves item to posts.json, commits and pushes to GitHub Pages, updates preferences
// - POST /api/dislike/:id → moves item to rejected.json, updates preferences (no push — local only)

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const classifier = require('./classifier');
const { composeHTML } = require('./presentations/composer');
const bg = require('./presentations/bg');
const media = require('./presentations/media');
const tts = require('./presentations/tts');
const { alignPhrases } = require('./presentations/sync');
const { composeTweet, intentUrl } = require('./tweet');
const xPost = require('./x-post');
const tweetChat = require('./tweet-chat');

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
  '.mp4':  'video/mp4',
};

const PRES_DIR = path.join(ROOT, 'presentations');
const RENDER_DIR = path.join(PRES_DIR, 'renders');
const renderJobs = new Map(); // id → { status, error, videoPath, startedAt, finishedAt }
let renderLock = null;        // { id } — only one hyperframes render at a time

function findItem(id) {
  for (const key of ['queue', 'posts', 'rejected']) {
    const arr = readJson(FILES[key]);
    const hit = arr.find(it => it.id === id);
    if (hit) return { item: hit, bucket: key };
  }
  return null;
}

async function renderVideo(id, item) {
  const job = { status: 'rendering', stage: 'starting', error: null, videoPath: null, startedAt: Date.now(), finishedAt: null };
  renderJobs.set(id, job);
  renderLock = { id };

  try {
    if (!fs.existsSync(RENDER_DIR)) fs.mkdirSync(RENDER_DIR, { recursive: true });

    job.stage = 'tts';
    let audioRel = null, audioDuration = null, ttsScript = null;
    try {
      const r = await tts.synthesize(item);
      audioRel = r.rel;
      audioDuration = r.durationSec;
      ttsScript = r.script;
    } catch (e) {
      console.error('tts failed:', e.message);
    }

    // Split the spoken script into phase texts so each background image
    // matches the beat the narrator says at that moment.
    const phaseTexts = ttsScript
      ? ttsScript.split(/(?<=[.!?])\s+/).filter(Boolean).slice(0, 4)
      : null;

    job.stage = 'media';
    let bgRels = [];
    try {
      const r = await media.gather(item, { count: 4, force: true });
      bgRels = r.map(x => x.rel);
    } catch (e) {
      console.error('media gather failed:', e.message);
    }

    job.stage = 'transcribe';
    let phases = null;
    let transcriptWords = null;
    if (audioRel && ttsScript) {
      try {
        const audioAbs = path.join(PRES_DIR, audioRel);
        execSync(`npx hyperframes transcribe ${JSON.stringify(audioAbs)} --model small.en --json > /dev/null`, {
          cwd: PRES_DIR, stdio: 'pipe',
        });
        const transcriptPath = path.join(PRES_DIR, 'transcript.json');
        if (fs.existsSync(transcriptPath)) {
          transcriptWords = JSON.parse(fs.readFileSync(transcriptPath, 'utf8'));
          phases = alignPhrases(ttsScript, transcriptWords);
        }
      } catch (e) {
        console.error('transcribe failed:', e.message.slice(0, 300));
      }
    }

    job.stage = 'compose';
    fs.writeFileSync(
      path.join(PRES_DIR, 'index.html'),
      composeHTML(item, { bgRels, audioRel, audioDuration, phases, transcript: transcriptWords }),
    );
  } catch (e) {
    job.status = 'failed'; job.error = `${job.stage}: ${e.message}`; job.finishedAt = Date.now();
    renderLock = null;
    return;
  }

  job.stage = 'render';
  const outPath = path.join(RENDER_DIR, `${id}.mp4`);
  const proc = spawn('npx', ['hyperframes', 'render', '--output', outPath, '--quiet'], {
    cwd: PRES_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errBuf = '';
  proc.stderr.on('data', d => { errBuf += d.toString(); });
  proc.on('close', code => {
    job.finishedAt = Date.now();
    if (code === 0 && fs.existsSync(outPath)) {
      job.status = 'done';
      job.videoPath = `/presentations/renders/${id}.mp4`;
    } else {
      job.status = 'failed';
      job.error = errBuf.trim().slice(-500) || `exit ${code}`;
    }
    renderLock = null;
  });
}

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

// Reverse a prior Like: subtract 1 like and add 1 dislike across category/tags/source.
function reverseLike(item) {
  const prefs = readJson(FILES.preferences);
  const touch = (bucket, key) => {
    if (!bucket[key]) bucket[key] = { likes: 0, dislikes: 0 };
    bucket[key].likes    = Math.max(0, (bucket[key].likes || 0) - 1);
    bucket[key].dislikes = (bucket[key].dislikes || 0) + 1;
  };
  touch(prefs.categories, item.category);
  (item.tags || []).forEach(t => touch(prefs.tags, t));
  if (item.source) touch(prefs.sources, item.source);
  prefs.totals.likes    = Math.max(0, (prefs.totals.likes || 0) - 1);
  prefs.totals.dislikes = (prefs.totals.dislikes || 0) + 1;
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

const SAFE_STATICS = new Set(['review.html', 'tweet-studio.html', 'favicon.svg']);

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
      const queue = readJson(FILES.queue);
      const scores = classifier.modelExists() ? classifier.scoreItems(queue) : {};
      const scoredQueue = queue.map(it => {
        const s = scores[it.id];
        return s ? { ...it, tasteScore: s.tasteScore, tastePredicted: s.predicted } : it;
      });
      return sendJson(res, 200, {
        queue:       scoredQueue,
        posts:       readJson(FILES.posts),
        rejected:    readJson(FILES.rejected),
        preferences: readJson(FILES.preferences),
        classifier:  { available: classifier.available(), modelExists: classifier.modelExists() },
      });
    } catch (e) {
      return sendJson(res, 500, { error: String(e) });
    }
  }

  if (req.method === 'POST' && pathname === '/api/classifier/train') {
    const r = classifier.train();
    return sendJson(res, r.ok ? 200 : 500, r);
  }

  const tweet = pathname.match(/^\/api\/tweet\/([\w-]+)$/);
  if (req.method === 'GET' && tweet) {
    const [, id] = tweet;
    const found = findItem(id);
    if (!found) return sendJson(res, 404, { error: 'item not found' });
    const text = composeTweet(found.item);
    // Report which image will be used on posting (first cached slot-0).
    let imageRel = null;
    for (const ext of ['.jpg', '.png', '.webp']) {
      const p = path.join(PRES_DIR, 'assets', `${id}-0${ext}`);
      if (fs.existsSync(p)) { imageRel = `presentations/assets/${id}-0${ext}`; break; }
    }
    return sendJson(res, 200, { text, intentUrl: intentUrl(text), item: found.item, imageRel });
  }

  if (req.method === 'POST' && pathname === '/api/tweet-revise') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      try {
        const { id, currentText, instruction, history } = JSON.parse(body || '{}');
        if (!id || !currentText || !instruction) {
          return sendJson(res, 400, { error: 'id, currentText, instruction required' });
        }
        const found = findItem(id);
        if (!found) return sendJson(res, 404, { error: 'item not found' });
        const r = await tweetChat.revise({
          item: found.item,
          currentText,
          instruction,
          history: Array.isArray(history) ? history : [],
        });
        sendJson(res, 200, r);
      } catch (e) {
        sendJson(res, 500, { error: e.message });
      }
    });
    return;
  }

  const xpostRoute = pathname.match(/^\/api\/x-post\/([\w-]+)$/);
  if (req.method === 'POST' && xpostRoute) {
    const [, id] = xpostRoute;
    const found = findItem(id);
    if (!found) return sendJson(res, 404, { error: 'item not found' });
    // Accept optional override body: {text, imagePath}
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      let override = {};
      try { override = body ? JSON.parse(body) : {}; } catch {}
      const text = override.text || composeTweet(found.item);

      // imagePath override must resolve under PRES_DIR/assets — prevent
      // path traversal or absolute-path access outside the project tree.
      let imagePath = null;
      if (override.imagePath && typeof override.imagePath === 'string') {
        const candidate = path.resolve(ROOT, override.imagePath);
        const assetsDir = path.resolve(PRES_DIR, 'assets') + path.sep;
        if (candidate.startsWith(assetsDir) && fs.existsSync(candidate)) {
          imagePath = candidate;
        }
      }
      if (!imagePath) {
        for (const ext of ['.jpg', '.png', '.webp']) {
          const p = path.join(PRES_DIR, 'assets', `${id}-0${ext}`);
          if (fs.existsSync(p)) { imagePath = p; break; }
        }
      }
      try {
        const r = await xPost.postWithImage({ text, imagePath });
        sendJson(res, 200, { ok: true, ...r, text, imageUsed: imagePath });
      } catch (e) {
        sendJson(res, 500, { error: e.message, text, imageUsed: imagePath });
      }
    });
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/presentations/assets/')) {
    const rel = pathname.replace('/presentations/assets/', '');
    if (rel.includes('..') || rel.includes('/')) { res.writeHead(400); return res.end('bad path'); }
    const file = path.join(PRES_DIR, 'assets', rel);
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(file).toLowerCase();
    const type = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    return fs.createReadStream(file).pipe(res);
  }

  const animate = pathname.match(/^\/api\/animate\/([\w-]+)$/);
  if (req.method === 'POST' && animate) {
    const [, id] = animate;
    const found = findItem(id);
    if (!found) return sendJson(res, 404, { error: 'item not found in queue/posts/rejected' });
    if (renderLock && renderLock.id !== id) {
      return sendJson(res, 429, { error: 'another render is in progress', busy: renderLock.id });
    }
    renderVideo(id, found.item);
    return sendJson(res, 202, { ok: true, id, status: 'rendering' });
  }

  const animStatus = pathname.match(/^\/api\/animate\/([\w-]+)\/status$/);
  if (req.method === 'GET' && animStatus) {
    const [, id] = animStatus;
    const job = renderJobs.get(id);
    if (!job) return sendJson(res, 404, { error: 'no render job for this id' });
    return sendJson(res, 200, job);
  }

  if (req.method === 'GET' && pathname.startsWith('/presentations/renders/')) {
    const rel = pathname.replace('/presentations/renders/', '');
    if (rel.includes('..') || rel.includes('/')) {
      res.writeHead(400); return res.end('bad path');
    }
    const file = path.join(RENDER_DIR, rel);
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' });
    return fs.createReadStream(file).pipe(res);
  }

  // Restore: send a previously-rejected item back into the queue.
  const restore = pathname.match(/^\/api\/restore\/([\w-]+)$/);
  if (req.method === 'POST' && restore) {
    const [, id] = restore;
    try {
      const rejected = readJson(FILES.rejected);
      const idx = rejected.findIndex(r => r.id === id);
      if (idx < 0) return sendJson(res, 404, { error: 'not in rejected' });
      const [item] = rejected.splice(idx, 1);
      writeJson(FILES.rejected, rejected);

      // Undo a prior dislike: -1 dislike across dimensions
      const prefs = readJson(FILES.preferences);
      const touch = (bucket, key) => {
        if (!bucket[key]) return;
        bucket[key].dislikes = Math.max(0, (bucket[key].dislikes || 0) - 1);
      };
      touch(prefs.categories, item.category);
      (item.tags || []).forEach(t => touch(prefs.tags, t));
      if (item.source) touch(prefs.sources, item.source);
      prefs.totals.dislikes = Math.max(0, (prefs.totals.dislikes || 0) - 1);
      prefs.lastUpdated = new Date().toISOString();
      writeJson(FILES.preferences, prefs);

      // Strip verdict-specific fields before returning to queue
      delete item.rejectedAt;
      delete item.wasPublished;
      delete item.publishedAt;
      delete item.score;

      const queue = readJson(FILES.queue);
      queue.unshift(item);
      writeJson(FILES.queue, queue);

      return sendJson(res, 200, { ok: true, action: 'restore' });
    } catch (e) {
      return sendJson(res, 500, { error: String(e) });
    }
  }

  // Unpublish: pull an already-published post off the live feed and flip its learning.
  const unpub = pathname.match(/^\/api\/unpublish\/([\w-]+)$/);
  if (req.method === 'POST' && unpub) {
    const [, id] = unpub;
    try {
      const posts = readJson(FILES.posts);
      const idx = posts.findIndex(p => p.id === id);
      if (idx < 0) return sendJson(res, 404, { error: 'not in posts' });
      const [item] = posts.splice(idx, 1);
      writeJson(FILES.posts, posts);

      const rejected = readJson(FILES.rejected);
      rejected.unshift({ ...item, rejectedAt: new Date().toISOString(), wasPublished: true });
      writeJson(FILES.rejected, rejected);

      reverseLike(item);
      const push = gitPush(`Unpublish: ${item.title}`);
      return sendJson(res, 200, { ok: true, action: 'unpublish', pushed: push.ok, error: push.error || null });
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
        setImmediate(() => classifier.train());
        return sendJson(res, 200, { ok: true, action, published: push.ok, error: push.error || null });
      } else {
        const rejected = readJson(FILES.rejected);
        rejected.unshift({ ...item, rejectedAt: new Date().toISOString() });
        writeJson(FILES.rejected, rejected);
        applyLearning(item, 'dislike');
        setImmediate(() => classifier.train());
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
