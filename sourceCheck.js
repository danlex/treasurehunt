#!/usr/bin/env node
// Source discovery — finds new RSS feeds daily from aggregator lists and trending
// GitHub repos, then appends novel ones to a discovery log for human review.
//
// Scans:
//  - OPDS/OPML public feed lists
//  - GitHub repos tagged 'rss-feed', 'news-aggregator', 'ai-newsletter'
//  - HN "Ask HN: What RSS feeds do you follow" threads
//  - GitHub trending repos that link RSS in their README
//
// Writes newly-found feeds to .cache/discovered-feeds.json
// Usage: node sourceCheck.js

const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');

const CACHE_DIR    = path.join(__dirname, '.cache');
const FOUND_FILE   = path.join(CACHE_DIR, 'discovered-feeds.json');
const CACHE_TTL    = 24 * 60 * 60 * 1000; // 1 day

// Known curated RSS/newsletter lists (all free, no auth)
const DISCOVERY_SOURCES = [
  // OPML / RSS list aggregators
  'https://raw.githubusercontent.com/plenaryapp/awesome-rss-feeds/master/countries/with_category/United_States.opml',
  'https://raw.githubusercontent.com/tuan3w/awesome-tech-rss/master/README.md',
  // Feedspot top AI blogs (HTML, we parse href+rss patterns)
  'https://rss.feedspot.com/artificial_intelligence_rss_feeds/',
  'https://rss.feedspot.com/machine_learning_rss_feeds/',
  'https://rss.feedspot.com/tech_news_rss_feeds/',
];

// AI/ML tags to search on GitHub for repos that ARE RSS feeds or newsletters
const GITHUB_TOPICS = [
  'ai-newsletter', 'machine-learning-news', 'ai-news', 'llm-news', 'tech-news',
];

function get(url, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (treasurehunt-source-discovery/1.0)' }
    }, res => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        return get(res.headers.location, timeout).then(resolve).catch(reject);
      }
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function extractRssUrls(text) {
  const found = new Set();
  // OPML xmlUrl attributes
  const opml = /xmlUrl="([^"]+)"/gi;
  let m;
  while ((m = opml.exec(text)) !== null) found.add(m[1]);
  // Markdown links ending in /feed, /rss, /atom, .xml
  const mdLink = /https?:\/\/[^\s\)>"]+(?:\/feed\/?|\/rss\/?|\/atom\/?|\.rss|\.xml|\/feed\.xml|\/rss\.xml)/gi;
  while ((m = mdLink.exec(text)) !== null) found.add(m[1] || m[0]);
  return [...found];
}

function loadKnown() {
  // Build set of URLs already in trending.js RSS_FEEDS
  const src = fs.readFileSync(path.join(__dirname, 'trending.js'), 'utf8');
  const known = new Set();
  const re = /url:\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(src)) !== null) known.add(m[1]);
  return known;
}

function loadFound() {
  try {
    const raw = JSON.parse(fs.readFileSync(FOUND_FILE, 'utf8'));
    return { ts: raw.ts || 0, feeds: new Set(raw.feeds || []) };
  } catch {
    return { ts: 0, feeds: new Set() };
  }
}

function saveFound(feedSet) {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(FOUND_FILE, JSON.stringify({
    ts: Date.now(),
    feeds: [...feedSet],
  }, null, 2));
}

async function searchGithubTopics(topics) {
  const found = [];
  for (const topic of topics) {
    try {
      const url = `https://api.github.com/search/repositories?q=topic:${topic}&sort=stars&per_page=10`;
      const { status, body } = await get(url);
      if (status !== 200) continue;
      const data = JSON.parse(body);
      for (const repo of (data.items || [])) {
        if (repo.homepage) found.push(repo.homepage);
        // Try README for feed links
        const readmeUrl = `https://raw.githubusercontent.com/${repo.full_name}/${repo.default_branch || 'main'}/README.md`;
        try {
          const { body: readme } = await get(readmeUrl, 5000);
          found.push(...extractRssUrls(readme));
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  return found;
}

async function discover() {
  const { ts, feeds: prevFound } = loadFound();
  if (Date.now() - ts < CACHE_TTL) {
    const known = loadKnown();
    const novel = [...prevFound].filter(u => !known.has(u));
    console.log(`Source discovery (cached): ${prevFound.size} total found, ${novel.length} novel vs current trending.js`);
    novel.slice(0, 20).forEach(u => console.log(' +', u));
    return novel;
  }

  const known = loadKnown();
  const allFound = new Set(prevFound);

  // Scrape discovery sources
  for (const src of DISCOVERY_SOURCES) {
    try {
      const { body } = await get(src, 15000);
      const urls = extractRssUrls(body);
      urls.forEach(u => allFound.add(u));
      console.log(`Scraped ${src.slice(0, 60)} — ${urls.length} feeds`);
    } catch (e) {
      console.log(`Skip ${src.slice(0, 60)} — ${e.message}`);
    }
  }

  // GitHub topic search
  console.log('Searching GitHub topics...');
  const ghUrls = await searchGithubTopics(GITHUB_TOPICS);
  ghUrls.forEach(u => allFound.add(u));
  console.log(`GitHub topics: ${ghUrls.length} candidates`);

  saveFound(allFound);

  const novel = [...allFound].filter(u => u.startsWith('http') && !known.has(u));
  console.log(`\nDiscovery complete: ${allFound.size} total, ${novel.length} novel vs trending.js`);
  novel.slice(0, 30).forEach(u => console.log(' +', u));
  return novel;
}

module.exports = { discover };

if (require.main === module) {
  discover().catch(e => { console.error(e.message); process.exit(1); });
}
