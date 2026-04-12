#!/usr/bin/env node
// Trending orchestrator — pulls top items from all free sources in one pass.
// Results cached on disk for 20 min so repeated hunt calls don't re-fetch.
//
// Returns a flat list of { title, url, source, score, createdAt } ordered by score.
// Hunt pipeline uses this as its CANDIDATE pool — then enriches, filters, scores,
// and writes to queue.json.
//
// Cost discipline: NO per-candidate calls happen here. One call per source.

const fs = require('fs');
const path = require('path');
const hn = require('./hnCheck');
const reddit = require('./redditCheck');
const rss = require('./rssCheck');

// X is optional — only loaded if the module exists. xCheck.js loads .env itself.
let xCheck = null;
try { xCheck = require('./xCheck'); } catch { /* no X module */ }

const CACHE_FILE = path.join(__dirname, '.cache', 'trending.json');
const CACHE_TTL_MS = 20 * 60 * 1000;

const REDDIT_SUBS = [
  'r/technology', 'r/MachineLearning', 'r/LocalLLaMA', 'r/OpenAI', 'r/ClaudeAI',
  'r/singularity', 'r/QuantumComputing', 'r/Physics', 'r/netsec', 'r/cybersecurity',
  'r/sysadmin', 'r/venturecapital', 'r/startups', 'r/Futurology', 'r/programming'
];

const RSS_FEEDS = [
  { url: 'https://www.techmeme.com/feed.xml',                                          source: 'Techmeme' },
  { url: 'https://news.google.com/rss/search?q=artificial+intelligence&hl=en-US&gl=US', source: 'Google News (AI)' },
  { url: 'https://news.google.com/rss/search?q=quantum+computing&hl=en-US',            source: 'Google News (Quantum)' },
  { url: 'https://news.google.com/rss/search?q=cybersecurity+zero-day&hl=en-US',       source: 'Google News (Cyber)' },
  { url: 'https://feeds.feedburner.com/TheHackersNews',                                source: 'The Hacker News' },
  { url: 'https://www.producthunt.com/feed',                                           source: 'Product Hunt' },
  { url: 'https://export.arxiv.org/rss/cs.AI',                                         source: 'arXiv cs.AI' },
  { url: 'https://export.arxiv.org/rss/cs.LG',                                         source: 'arXiv cs.LG' }
];

function ensureCacheDir() {
  const d = path.dirname(CACHE_FILE);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}
function readCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (Date.now() - raw.ts < CACHE_TTL_MS) return raw.data;
  } catch {}
  return null;
}
function writeCache(data) {
  ensureCacheDir();
  fs.writeFileSync(CACHE_FILE, JSON.stringify({ ts: Date.now(), data }, null, 2));
}

// Scores per source — normalized roughly to 0-100 for cross-source sorting.
function scoreHn(h) { return Math.min(100, h.points * 0.5 + h.comments * 0.3); }
function scoreReddit(r) { return Math.min(100, Math.log10(Math.max(1, r.ups)) * 25 + r.comments * 0.2); }
function scoreRss(r, idx) { return Math.max(0, 60 - idx * 2); } // RSS is ordered

async function collectAll() {
  const cached = readCache();
  if (cached) return cached;

  const jobs = [];

  // Hacker News — top of last 24h, min 100 points
  jobs.push(
    hn.top({ hours: 24, min_points: 100, limit: 25 })
      .then(items => items.map(h => ({
        title: h.title, url: h.url || h.hnUrl, source: 'Hacker News',
        score: scoreHn(h), createdAt: h.createdAt,
        meta: { points: h.points, comments: h.comments, hnUrl: h.hnUrl }
      })))
      .catch(e => (console.error('HN fetch failed:', e.message), []))
  );

  // Reddit — top of day for each sub, flattened
  for (const sub of REDDIT_SUBS) {
    jobs.push(
      reddit.topOf(sub, { timeframe: 'day', limit: 5 })
        .then(items => items.map(r => ({
          title: r.title, url: r.url, source: r.sub,
          score: scoreReddit(r), createdAt: new Date(r.createdUtc * 1000).toISOString(),
          meta: { ups: r.ups, comments: r.comments, permalink: r.permalink }
        })))
        .catch(e => (console.error(`Reddit ${sub} failed:`, e.message), []))
    );
  }

  // RSS aggregators
  for (const { url, source } of RSS_FEEDS) {
    jobs.push(
      rss.fetchRss(url, 10)
        .then(items => items.map((r, i) => ({
          title: r.title, url: r.link, source,
          score: scoreRss(r, i), createdAt: r.published,
          meta: { description: r.description }
        })))
        .catch(e => (console.error(`RSS ${source} failed:`, e.message), []))
    );
  }

  // X trusted voices — one call, fetches top recent tweets from tier-1+2 handles.
  // Skip silently if bearer token missing or daily budget exhausted.
  if (xCheck && process.env.X_BEARER_TOKEN) {
    jobs.push(
      xCheck.trustedVoicesActivity({ tierScope: 'tier1+tier2', maxResults: 100 })
        .then(r => (r.tweets || []).map(t => ({
          title: t.text.replace(/\s+/g, ' ').slice(0, 140),
          url: t.url,
          source: 'X · @' + t.handle,
          score: Math.min(100, Math.log10(Math.max(1, t.likes)) * 20 + t.retweets * 0.5),
          createdAt: t.createdAt,
          meta: { likes: t.likes, retweets: t.retweets, handle: t.handle, fullText: t.text }
        })))
        .catch(e => (console.error('X voices failed:', e.message), []))
    );
  }

  const chunks = await Promise.all(jobs);
  const flat = chunks.flat().filter(x => x.title && x.url);

  // Deduplicate by normalized URL (strip query/fragment)
  const seen = new Map();
  for (const item of flat) {
    const key = (item.url || '').split('?')[0].split('#')[0].replace(/\/$/, '').toLowerCase();
    if (!seen.has(key) || seen.get(key).score < item.score) seen.set(key, item);
  }
  const merged = [...seen.values()].sort((a, b) => b.score - a.score);
  writeCache(merged);
  return merged;
}

module.exports = { collectAll, REDDIT_SUBS, RSS_FEEDS };

if (require.main === module) {
  collectAll().then(items => {
    console.log(`${items.length} items collected (cache age: fresh pull or <20min)`);
    items.slice(0, 40).forEach((it, i) => {
      console.log(`${String(i + 1).padStart(2)}. [${it.source.padEnd(18)}] (${Math.round(it.score).toString().padStart(3)}) ${it.title.slice(0, 100)}`);
    });
  }).catch(e => { console.error(e.message); process.exit(1); });
}
