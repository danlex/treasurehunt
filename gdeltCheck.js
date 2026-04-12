#!/usr/bin/env node
// GDELT 2.0 DOC API helper — monitors ~100-language news media in 15-min updates.
// Free, no auth. Docs: https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/
//
// Why GDELT matters:
//   - Coverage: every significant news outlet globally, not just English tier-1
//   - Tone: each article has a sentiment score (-10..+10) — gold for FUD detection
//   - Volume: normalized timeline shows when a topic spikes (viral signal)
//   - Themes: structured tagging (CYBER_ATTACK, SCIENCE, TECH, INNOVATION, etc.)
//
// CLI:
//   node gdeltCheck.js articles "AI agent" 24
//   node gdeltCheck.js tone "OpenAI GPT-5"
//   node gdeltCheck.js timeline "quantum breakthrough" 30
//   node gdeltCheck.js hot
//
// Programmatic:
//   const g = require('./gdeltCheck');
//   const hot = await g.articles('artificial intelligence', { hours: 24, max: 50 });

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE = 'https://api.gdeltproject.org/api/v2/doc/doc';
const MIN_GAP_MS = 5500; // GDELT: "1 query per 5 seconds"
const CACHE_DIR = path.join(__dirname, '.cache');
const CACHE_TTL_MS = 20 * 60 * 1000;

let lastCallAt = 0;
let callLock = Promise.resolve();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Mutex-style: ensure only one in-flight throttle at a time so parallel callers serialize.
function throttle() {
  const mine = callLock.then(async () => {
    const wait = Math.max(0, MIN_GAP_MS - (Date.now() - lastCallAt));
    if (wait) await sleep(wait);
    lastCallAt = Date.now();
  });
  callLock = mine;
  return mine;
}
function cacheKey(params) {
  return crypto.createHash('sha1').update(JSON.stringify(params)).digest('hex').slice(0, 16);
}
function readCache(key) {
  const f = path.join(CACHE_DIR, `gdelt-${key}.json`);
  if (!fs.existsSync(f)) return null;
  try {
    const b = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (Date.now() - b.ts > CACHE_TTL_MS) return null;
    return b.data;
  } catch { return null; }
}
function writeCache(key, data) {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(path.join(CACHE_DIR, `gdelt-${key}.json`), JSON.stringify({ ts: Date.now(), data }, null, 2));
}

// GDELT wants a specific timespan format: <N>h, <N>d, <N>w, <N>mo
function timespan({ hours, days, weeks }) {
  if (hours) return `${hours}h`;
  if (days) return `${days}d`;
  if (weeks) return `${weeks}w`;
  return '24h';
}

// Node's undici fetch is flaky on GDELT (intermittent "fetch failed" on TLS handshake).
// Shell out to curl, which is reliable. curl is available on every reasonable system.
const { execFile } = require('child_process');
const util = require('util');
const execFileP = util.promisify(execFile);

async function fetchJson(params, { retries = 2 } = {}) {
  const key = cacheKey(params);
  const cached = readCache(key);
  if (cached) return cached;

  await throttle();
  const url = new URL(BASE);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v));
  url.searchParams.set('format', 'json');

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const { stdout } = await execFileP('curl', [
        '-sSL',
        '--max-time', '30',
        '-H', 'User-Agent: treasurehunt/1.0',
        '-H', 'Accept: application/json',
        url.toString()
      ], { maxBuffer: 16 * 1024 * 1024 });
      const text = stdout;
      if (!text.trim()) return {};
      if (text.startsWith('Please limit requests')) throw new Error('gdelt 429 — rate limited');
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
      writeCache(key, parsed);
      return parsed;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(1500 * (attempt + 1));
    }
  }
  throw lastErr;
}

// ─── Articles: full article list with tone ───────────────────────────────────
async function articles(query, { hours = 24, days, max = 75, sort = 'HybridRel', sourceCountry = null } = {}) {
  const params = {
    query: sourceCountry ? `${query} sourcecountry:${sourceCountry}` : query,
    mode: 'ArtList',
    timespan: timespan({ hours, days }),
    maxrecords: Math.min(250, max),
    sort
  };
  const json = await fetchJson(params);
  return (json.articles || []).map(a => ({
    title: a.title,
    url: a.url,
    source: a.domain,
    sourceCountry: a.sourcecountry,
    language: a.language,
    publishedAt: a.seendate,
    tone: a.tone != null ? Number(a.tone) : null,
    socialImageUrl: a.socialimage || null
  }));
}

// ─── Tone distribution — for FUD detection ────────────────────────────────────
// Returns tone buckets (-10..+10) so we can tell if coverage is nuanced or polarized.
async function tone(query, { hours = 48, days } = {}) {
  const params = {
    query,
    mode: 'ToneChart',
    timespan: timespan({ hours, days })
  };
  const json = await fetchJson(params);
  const tonechart = json.tonechart || [];
  const total = tonechart.reduce((s, b) => s + b.count, 0);
  const avg = total
    ? tonechart.reduce((s, b) => s + b.bin * b.count, 0) / total
    : null;
  // Polarization: stdev of tone. High = coverage is divided (possible FUD signal).
  let stdev = null;
  if (total && avg != null) {
    const variance = tonechart.reduce((s, b) => s + b.count * Math.pow(b.bin - avg, 2), 0) / total;
    stdev = Math.sqrt(variance);
  }
  return {
    query,
    totalArticles: total,
    averageTone: avg != null ? Math.round(avg * 100) / 100 : null,
    polarization: stdev != null ? Math.round(stdev * 100) / 100 : null,
    distribution: tonechart
  };
}

// ─── Volume timeline — for virality / spike detection ─────────────────────────
async function timeline(query, { days = 7 } = {}) {
  const params = { query, mode: 'TimelineVol', timespan: timespan({ days }) };
  const json = await fetchJson(params);
  const series = (json.timeline || [])[0]?.data || [];
  const values = series.map(p => p.value || 0);
  const peak = values.length ? Math.max(...values) : 0;
  const baseline = values.length > 2
    ? values.slice(0, Math.floor(values.length / 2)).reduce((s, v) => s + v, 0) / Math.floor(values.length / 2)
    : 0;
  const spikeFactor = baseline > 0 ? peak / baseline : null;
  return {
    query,
    points: series.length,
    peak,
    baseline: Math.round(baseline * 100) / 100,
    spikeFactor: spikeFactor != null ? Math.round(spikeFactor * 100) / 100 : null,
    raw: series
  };
}

// ─── Convenience: "hot now" — top stories by relevance across tech beats ──────
async function hot({ hours = 24, max = 40 } = {}) {
  const queries = [
    '(artificial intelligence OR AI) (launch OR release OR breakthrough OR announcement)',
    '(quantum computing OR post-quantum) breakthrough',
    '(cybersecurity OR zero-day OR vulnerability) CVE',
    '(startup OR raised OR funding) AI',
    'LLM OR "large language model" release'
  ];
  const batches = await Promise.all(queries.map(q =>
    articles(q, { hours, max: Math.ceil(max / queries.length), sort: 'HybridRel' }).catch(() => [])
  ));
  const all = batches.flat();
  // Dedup by URL
  const seen = new Map();
  for (const a of all) {
    const key = (a.url || '').split('?')[0].toLowerCase();
    if (!seen.has(key)) seen.set(key, a);
  }
  return [...seen.values()]
    .filter(a => a.title)
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
}

// Helper: returns FUD / trust deltas based on tone + polarization for a topic.
// polarization > 2.5 with |averageTone| > 3 = contested narrative → bump FUD
function toneSignals(t) {
  if (!t || !t.totalArticles) return { fudRiskDelta: 0, note: 'no coverage' };
  let d = 0;
  let notes = [];
  if (t.polarization != null && t.polarization > 2.8) { d += 1; notes.push(`polarization ${t.polarization}`); }
  if (t.averageTone != null && t.averageTone < -3.0) { d += 1; notes.push(`strongly negative tone ${t.averageTone}`); }
  if (t.totalArticles < 5)                            { d += 1; notes.push(`thin coverage (${t.totalArticles} articles)`); }
  return { fudRiskDelta: d, note: notes.join('; ') || 'nuanced coverage' };
}

module.exports = { articles, tone, timeline, hot, toneSignals };

// ─── CLI ──────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const [, , cmd, ...rest] = process.argv;
  (async () => {
    if (cmd === 'articles') {
      const [q, hours = 24] = [rest.slice(0, -1).join(' ') || rest[0], rest[rest.length - 1]];
      const list = await articles(q, { hours: Number(hours) || 24, max: 40 });
      console.log(`${list.length} articles for "${q}":`);
      list.slice(0, 25).forEach((a, i) => {
        const tone = a.tone != null ? `tone:${a.tone.toFixed(1)}` : '';
        console.log(`${String(i + 1).padStart(2)}. [${a.source}] ${a.title?.slice(0, 100)} ${tone}`);
        console.log(`    ${a.url}`);
      });
      return;
    }
    if (cmd === 'tone') {
      const q = rest.join(' ');
      const t = await tone(q);
      console.log(JSON.stringify(t, null, 2));
      return;
    }
    if (cmd === 'timeline') {
      const [q, days = 7] = [rest.slice(0, -1).join(' ') || rest[0], rest[rest.length - 1]];
      const tl = await timeline(q, { days: Number(days) || 7 });
      console.log(JSON.stringify({ ...tl, raw: tl.raw.slice(0, 5) + ' ...' }, null, 2));
      return;
    }
    if (cmd === 'hot') {
      const list = await hot({ hours: 24, max: 40 });
      console.log(`${list.length} hot articles (last 24h):`);
      list.slice(0, 25).forEach((a, i) => {
        const tone = a.tone != null ? `tone:${a.tone.toFixed(1).padStart(5)}` : '          ';
        console.log(`${String(i + 1).padStart(2)}. [${tone}] [${(a.source || '?').padEnd(22).slice(0, 22)}] ${a.title?.slice(0, 90)}`);
      });
      return;
    }
    console.error('Usage: node gdeltCheck.js articles "<q>" [hours] | tone "<q>" | timeline "<q>" [days] | hot');
    process.exit(2);
  })().catch(e => { console.error('Error:', e.message); process.exit(1); });
}
