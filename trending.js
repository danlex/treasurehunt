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

// GDELT is free and always available.
let gdelt = null;
try { gdelt = require('./gdeltCheck'); } catch { /* no GDELT module */ }

// GitHub Trending scraper
let github = null;
try { github = require('./githubCheck'); } catch { /* no githubCheck module */ }

const CACHE_FILE = path.join(__dirname, '.cache', 'trending.json');
const CACHE_TTL_MS = 20 * 60 * 1000;

const REDDIT_SUBS = [
  // AI / ML
  'r/MachineLearning', 'r/LocalLLaMA', 'r/OpenAI', 'r/ClaudeAI', 'r/ChatGPT',
  'r/singularity', 'r/artificial',
  // General tech
  'r/technology', 'r/programming', 'r/compsci', 'r/Futurology',
  // Science
  'r/science', 'r/Physics', 'r/QuantumComputing',
  // Security
  'r/netsec', 'r/cybersecurity', 'r/sysadmin',
  // Business / startups
  'r/venturecapital', 'r/startups', 'r/wallstreetbets',
];

const RSS_FEEDS = [
  // Tech aggregators
  { url: 'https://www.techmeme.com/feed.xml',                                                source: 'Techmeme' },
  { url: 'https://news.google.com/rss/search?q=artificial+intelligence&hl=en-US&gl=US',      source: 'Google News (AI)' },
  { url: 'https://news.google.com/rss/search?q=large+language+model&hl=en-US&gl=US',         source: 'Google News (LLM)' },
  { url: 'https://news.google.com/rss/search?q=quantum+computing&hl=en-US',                  source: 'Google News (Quantum)' },
  { url: 'https://news.google.com/rss/search?q=AI+startup+funding&hl=en-US&gl=US',           source: 'Google News (AI Funding)' },
  { url: 'https://news.google.com/rss/search?q=cybersecurity+zero-day&hl=en-US',             source: 'Google News (Cyber)' },
  { url: 'https://feeds.feedburner.com/TheHackersNews',                                       source: 'The Hacker News' },
  { url: 'https://www.producthunt.com/feed',                                                  source: 'Product Hunt' },
  { url: 'https://lobste.rs/rss',                                                             source: 'Lobste.rs' },

  // AI lab primary blogs — highest authority for model/product releases
  // (Use Google News targeted searches for labs whose RSS is blocked or absent)
  { url: 'https://news.google.com/rss/search?q=site:anthropic.com&hl=en-US&gl=US',            source: 'Anthropic (GNews)' },
  { url: 'https://news.google.com/rss/search?q=site:openai.com&hl=en-US&gl=US',              source: 'OpenAI (GNews)' },
  { url: 'https://deepmind.google/blog/rss.xml',                                              source: 'Google DeepMind Blog' },
  { url: 'https://news.google.com/rss/search?q=site:ai.meta.com&hl=en-US&gl=US',             source: 'Meta AI (GNews)' },
  { url: 'https://research.google/blog/rss/',                                                 source: 'Google Research Blog' },
  { url: 'https://huggingface.co/blog/feed.xml',                                              source: 'HuggingFace Blog' },
  { url: 'https://news.google.com/rss/search?q=site:mistral.ai&hl=en-US&gl=US',              source: 'Mistral AI (GNews)' },

  // arXiv — AI/ML/science preprints
  { url: 'https://export.arxiv.org/rss/cs.AI',                                                source: 'arXiv cs.AI' },
  { url: 'https://export.arxiv.org/rss/cs.LG',                                                source: 'arXiv cs.LG' },
  { url: 'https://export.arxiv.org/rss/cs.CL',                                                source: 'arXiv cs.CL' },
  { url: 'https://export.arxiv.org/rss/cs.CV',                                                source: 'arXiv cs.CV' },
  { url: 'https://export.arxiv.org/rss/cs.RO',                                                source: 'arXiv cs.RO' },
  { url: 'https://export.arxiv.org/rss/stat.ML',                                              source: 'arXiv stat.ML' },
  { url: 'https://export.arxiv.org/rss/quant-ph',                                             source: 'arXiv quant-ph' },

  // Tier-1 general news
  { url: 'http://feeds.bbci.co.uk/news/technology/rss.xml',                                   source: 'BBC Technology' },
  { url: 'http://feeds.bbci.co.uk/news/world/rss.xml',                                        source: 'BBC World' },
  { url: 'http://feeds.bbci.co.uk/news/science_and_environment/rss.xml',                      source: 'BBC Science' },
  { url: 'http://rss.cnn.com/rss/cnn_tech.rss',                                               source: 'CNN Tech' },
  { url: 'http://rss.cnn.com/rss/edition.rss',                                                source: 'CNN Top' },
  { url: 'https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml',                       source: 'NYT Technology' },
  { url: 'https://rss.nytimes.com/services/xml/rss/nyt/Science.xml',                          source: 'NYT Science' },
  { url: 'https://rss.nytimes.com/services/xml/rss/nyt/Business.xml',                         source: 'NYT Business' },
  { url: 'https://www.theguardian.com/technology/rss',                                        source: 'The Guardian Tech' },
  { url: 'https://www.theguardian.com/science/rss',                                           source: 'The Guardian Science' },
  { url: 'https://feeds.washingtonpost.com/rss/business/technology',                          source: 'Washington Post Tech' },
  { url: 'https://feeds.npr.org/1019/rss.xml',                                                source: 'NPR Technology' },
  { url: 'https://www.aljazeera.com/xml/rss/all.xml',                                         source: 'Al Jazeera' },
  { url: 'https://feeds.bloomberg.com/technology/news.rss',                                   source: 'Bloomberg Tech' },

  // Tech trade outlets
  { url: 'https://www.theverge.com/rss/index.xml',                                            source: 'The Verge' },
  { url: 'http://feeds.arstechnica.com/arstechnica/index',                                    source: 'Ars Technica' },
  { url: 'https://www.wired.com/feed/rss',                                                    source: 'Wired' },
  { url: 'https://techcrunch.com/feed/',                                                      source: 'TechCrunch' },
  { url: 'https://www.technologyreview.com/feed/',                                            source: 'MIT Tech Review' },
  { url: 'https://spectrum.ieee.org/rss/fulltext',                                            source: 'IEEE Spectrum' },
  { url: 'https://venturebeat.com/feed/',                                                     source: 'VentureBeat' },
  { url: 'https://www.theregister.com/headlines.atom',                                        source: 'The Register' },
  { url: 'https://www.zdnet.com/news/rss.xml',                                                source: 'ZDNet' },
  { url: 'https://feeds.feedburner.com/fastcompany/headlines',                                source: 'Fast Company' },
  { url: 'https://www.cnbc.com/id/19854910/device/rss/rss.html',                             source: 'CNBC Tech' },
  { url: 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml',                                    source: 'WSJ Markets' },

  // AI newsletters
  { url: 'https://jack-clark.net/feed/',                                                      source: 'Import AI (Jack Clark)' },
  { url: 'https://www.deeplearning.ai/blog/rss/',                                             source: 'The Batch (Andrew Ng)' },
  { url: 'https://buttondown.com/ainews/rss',                                                 source: 'AI News' },
  { url: 'https://tldr.tech/api/rss/ai',                                                      source: 'TLDR AI' },

  // Cybersecurity specialists
  { url: 'https://krebsonsecurity.com/feed/',                                                 source: 'Krebs on Security' },
  { url: 'https://www.schneier.com/feed/atom/',                                               source: 'Schneier on Security' },
  { url: 'https://www.darkreading.com/rss.xml',                                               source: 'Dark Reading' },
  { url: 'https://www.bleepingcomputer.com/feed/',                                            source: 'BleepingComputer' },

  // Science / research
  { url: 'https://www.nature.com/nature.rss',                                                 source: 'Nature' },
  { url: 'https://www.science.org/rss/news_current.xml',                                      source: 'Science Magazine' },
  { url: 'https://www.quantamagazine.org/feed/',                                              source: 'Quanta Magazine' },
  { url: 'https://phys.org/rss-feed/',                                                        source: 'Phys.org' },
  { url: 'https://www.newscientist.com/feed/home/',                                           source: 'New Scientist' },
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

  // GDELT — one call per beat, throttled internally to 1 per 5s. Pulls global
  // multilingual news with tone scores. Disk-cached for 20min.
  if (gdelt) {
    jobs.push(
      gdelt.hot({ hours: 24, max: 40 })
        .then(items => items.map(a => ({
          title: a.title, url: a.url, source: 'GDELT · ' + (a.source || 'news'),
          score: 60 + (a.tone != null ? Math.max(-10, Math.min(10, a.tone)) : 0), // neutral → 60, positive higher
          createdAt: a.publishedAt,
          meta: { tone: a.tone, sourceCountry: a.sourceCountry, language: a.language, domain: a.source }
        })))
        .catch(e => (console.error('GDELT hot failed:', e.message), []))
    );
  }

  // GitHub Trending — daily + weekly passes. High-signal for open-source releases.
  // Repos with 1k+ daily stars are news-worthy; watch frontier orgs.
  if (github) {
    const WATCHED_ORGS = ['openai', 'anthropic', 'google-deepmind', 'google-ai-edge',
      'meta-llama', 'NVIDIA', 'microsoft', 'HuggingFace', 'mistralai', 'karpathy'];
    for (const since of ['daily', 'weekly']) {
      jobs.push(
        github.trending({ since, limit: 25 })
          .then(repos => repos.map(r => {
            const org = r.fullName.split('/')[0].toLowerCase();
            const isFrontier = WATCHED_ORGS.some(w => org === w.toLowerCase());
            // Score: star gain drives base; frontier org gets a bump
            const base = Math.min(100, Math.log10(Math.max(1, r.starGain + 1)) * 28);
            return {
              title: `GitHub Trending (${since}): ${r.fullName}${r.description ? ' — ' + r.description.slice(0, 80) : ''}`,
              url: r.url,
              source: 'GitHub Trending',
              score: isFrontier ? base + 15 : base,
              createdAt: new Date().toISOString(),
              meta: { starGain: r.starGain, totalStars: r.totalStars, language: r.language, since, isFrontier }
            };
          }))
          .catch(e => (console.error(`GitHub trending (${since}) failed:`, e.message), []))
      );
    }
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
