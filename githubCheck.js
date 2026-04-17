#!/usr/bin/env node
// GitHub Trending scraper — fetches top repos from github.com/trending (HTML scrape).
// No auth required. Returns repos sorted by daily star gain.
//
// Usage:
//   const github = require('./githubCheck');
//   const repos = await github.trending({ since: 'daily', language: null, limit: 25 });
//
// CLI:
//   node githubCheck.js daily
//   node githubCheck.js weekly python

const https = require('https');
const path  = require('path');
const fs    = require('fs');

const CACHE_DIR  = path.join(__dirname, '.cache');
const CACHE_TTL  = 60 * 60 * 1000; // 1 hour — GitHub trending updates hourly

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (treasurehunt-bot/1.0)' } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return get(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

function parseRepos(html) {
  const repos = [];
  // Match each repo article block
  const articleRe = /<article[^>]*class="[^"]*Box-row[^"]*"[^>]*>([\s\S]*?)<\/article>/g;
  let m;
  while ((m = articleRe.exec(html)) !== null) {
    const block = m[1];

    // Full name: org/repo
    const nameMatch = block.match(/href="\/([^"\/]+\/[^"\/]+)"/);
    const fullName  = nameMatch ? nameMatch[1] : null;
    if (!fullName) continue;

    // Description
    const descMatch = block.match(/<p[^>]*>\s*([\s\S]*?)\s*<\/p>/);
    const description = descMatch
      ? descMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
      : '';

    // Language
    const langMatch = block.match(/itemprop="programmingLanguage"[^>]*>\s*([^<]+)\s*</);
    const language  = langMatch ? langMatch[1].trim() : null;

    // Total stars
    const starsMatch = block.match(/href="\/[^"]+\/stargazers"[^>]*>\s*[\s\S]*?([\d,]+)\s*</);
    const totalStars = starsMatch ? parseInt(starsMatch[1].replace(/,/g, ''), 10) : 0;

    // Stars today / this period
    const gainMatch = block.match(/([\d,]+)\s+stars? today/i)
                   || block.match(/([\d,]+)\s+stars? this week/i)
                   || block.match(/([\d,]+)\s+stars? this month/i);
    const starGain  = gainMatch ? parseInt(gainMatch[1].replace(/,/g, ''), 10) : 0;

    repos.push({
      fullName,
      url:         `https://github.com/${fullName}`,
      description,
      language,
      totalStars,
      starGain,
    });
  }
  return repos;
}

async function trending({ since = 'daily', language = null, limit = 25 } = {}) {
  const langSlug  = language ? `/${encodeURIComponent(language.toLowerCase())}` : '';
  const url       = `https://github.com/trending${langSlug}?since=${since}`;
  const cacheKey  = `github-trending-${since}-${language || 'all'}.json`;
  const cachePath = path.join(CACHE_DIR, cacheKey);

  // Check cache
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (Date.now() - raw.ts < CACHE_TTL) return raw.data.slice(0, limit);
  } catch {}

  const html  = await get(url);
  const repos = parseRepos(html);

  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify({ ts: Date.now(), data: repos }, null, 2));

  return repos.slice(0, limit);
}

module.exports = { trending };

if (require.main === module) {
  const since    = process.argv[2] || 'daily';
  const language = process.argv[3] || null;
  trending({ since, language, limit: 20 })
    .then(repos => {
      console.log(`GitHub Trending (${since}${language ? ', ' + language : ''}) — ${repos.length} repos`);
      repos.forEach((r, i) => {
        console.log(`${String(i + 1).padStart(2)}. ${r.fullName.padEnd(45)} ★${String(r.starGain).padStart(6)}/period  ${(r.description || '').slice(0, 60)}`);
      });
    })
    .catch(e => { console.error(e.message); process.exit(1); });
}
