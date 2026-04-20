// Real-image sourcing for presentations.
// Priority order per item (targeting `count` images):
//   1. og:image / twitter:image from item.primarySource
//   2. og:image / twitter:image from item.url (if different domain)
//   3. Generated backgrounds via bg.generateMany (Nano Banana)
//
// Extra sources can be plugged in by expanding collectCandidateUrls().
// Cached under presentations/assets/<id>-<i>.<ext>

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const ASSETS_DIR = path.join(__dirname, 'assets');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36';

function fetchText(url, { redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const req = client.get(url, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        const next = new URL(res.headers.location, url).toString();
        res.resume();
        fetchText(next, { redirects: redirects - 1 }).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`${res.statusCode} ${url}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('timeout')); });
  });
}

function fetchBinary(url, { redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const req = client.get(url, { headers: { 'User-Agent': UA } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        const next = new URL(res.headers.location, url).toString();
        res.resume();
        fetchBinary(next, { redirects: redirects - 1 }).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`${res.statusCode} ${url}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        buffer: Buffer.concat(chunks),
        contentType: res.headers['content-type'] || '',
      }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(new Error('timeout')); });
  });
}

function extractImageUrls(html, baseUrl) {
  const urls = new Set();
  const patterns = [
    /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/gi,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url)?["']/gi,
    /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/gi,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image(?::src)?["']/gi,
    /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(html)) !== null) {
      try { urls.add(new URL(m[1], baseUrl).toString()); } catch {}
    }
  }
  return [...urls];
}

function extFromMime(mime) {
  if (!mime) return '.png';
  if (/jpeg|jpg/i.test(mime)) return '.jpg';
  if (/png/i.test(mime)) return '.png';
  if (/webp/i.test(mime)) return '.webp';
  if (/gif/i.test(mime)) return '.gif';
  return '.png';
}

async function fetchAndSaveImage(url, outPathStem) {
  const { buffer, contentType } = await fetchBinary(url);
  if (!/^image\//i.test(contentType)) throw new Error('not an image: ' + contentType);
  const ext = extFromMime(contentType);
  const outPath = outPathStem + ext;
  fs.writeFileSync(outPath, buffer);
  return { path: outPath, rel: path.relative(path.join(ROOT, 'presentations'), outPath), size: buffer.length };
}

async function collectCandidateUrls(item) {
  const urls = [];
  const pageUrls = [];
  if (item.primarySource) pageUrls.push(item.primarySource);
  if (item.url && item.url !== item.primarySource) pageUrls.push(item.url);
  for (const pu of pageUrls) {
    try {
      const html = await fetchText(pu);
      const imgs = extractImageUrls(html, pu);
      for (const u of imgs) if (!urls.includes(u)) urls.push(u);
    } catch (e) {
      console.error('page fetch failed:', pu, e.message);
    }
  }
  return urls;
}

async function gather(item, { count = 4, force = false } = {}) {
  if (!fs.existsSync(ASSETS_DIR)) fs.mkdirSync(ASSETS_DIR, { recursive: true });

  const results = [];
  const seenPaths = new Set();

  // Reuse existing cached images unless forced.
  if (!force) {
    for (let i = 0; i < count; i++) {
      for (const ext of ['.jpg', '.png', '.webp']) {
        const p = path.join(ASSETS_DIR, `${item.id}-${i}${ext}`);
        if (fs.existsSync(p)) {
          const rel = `assets/${item.id}-${i}${ext}`;
          results.push({ path: p, rel, cached: true });
          seenPaths.add(p);
          break;
        }
      }
      if (results.length < i + 1) break; // stop at first missing slot
    }
    if (results.length >= count) return results.slice(0, count);
  }

  // Try real-image URLs from the item's primary source(s).
  if (!force && results.length) {
    // keep what we have, just fetch the missing ones
  } else {
    // Clear existing files for these slots if forcing.
    for (let i = 0; i < count; i++) {
      for (const ext of ['.jpg', '.png', '.webp']) {
        const p = path.join(ASSETS_DIR, `${item.id}-${i}${ext}`);
        if (fs.existsSync(p) && force) fs.unlinkSync(p);
      }
    }
    results.length = 0;
  }

  const candidateUrls = await collectCandidateUrls(item);

  let slot = results.length;
  for (const url of candidateUrls) {
    if (slot >= count) break;
    const stem = path.join(ASSETS_DIR, `${item.id}-${slot}`);
    try {
      const r = await fetchAndSaveImage(url, stem);
      results.push({ ...r, source: 'og-image', url, cached: false });
      slot += 1;
    } catch (e) {
      console.error('image dl failed:', url, e.message);
    }
  }

  // Fill remaining slots with Nano Banana generations for visual cohesion.
  if (slot < count) {
    try {
      const bg = require('./bg');
      const needed = count - slot;
      const generated = await bg.generateMany(item, {
        count: needed, force: true, phaseTexts: null, startIndex: slot,
      });
      for (const g of generated) {
        results.push({
          path: g.path,
          rel: g.rel,
          source: 'nanobanana',
          cached: false,
        });
      }
    } catch (e) {
      console.error('nanobanana fallback failed:', e.message);
    }
  }

  return results.slice(0, count);
}

module.exports = { gather, collectCandidateUrls };

if (require.main === module) {
  (async () => {
    const id = process.argv[2];
    if (!id) { console.error('usage: node presentations/media.js <item-id> [count]'); process.exit(1); }
    const count = Number(process.argv[3] || 4);
    const all = [
      ...JSON.parse(fs.readFileSync(path.join(ROOT, 'posts.json'), 'utf8')),
      ...JSON.parse(fs.readFileSync(path.join(ROOT, 'queue.json'), 'utf8')),
    ];
    const item = all.find(x => x.id === id);
    if (!item) { console.error('no item:', id); process.exit(2); }
    try {
      const r = await gather(item, { count, force: true });
      console.log(JSON.stringify(r, null, 2));
    } catch (e) {
      console.error('media failed:', e.message);
      process.exit(3);
    }
  })();
}
