#!/usr/bin/env node
// X (Twitter) API v2 helper — bearer-token only, read-only.
// Hard daily budget + 20-min disk cache. Never exceeds X_DAILY_CALL_BUDGET.
//
// CLI:
//   node xCheck.js voices          — recent tweets from tier-1 trusted voices (1 API call)
//   node xCheck.js voices-all      — recent tweets from all 22 trusted voices (still 1 call)
//   node xCheck.js mentions "GPT-5.4"   — recent tweets mentioning a topic (1 call)
//   node xCheck.js budget          — show remaining daily budget
//   node xCheck.js reset-budget    — reset counter (for testing)
//
// Programmatic:
//   const x = require('./xCheck');
//   const trending = await x.trustedVoicesActivity();  // 1 call, cached 20m
//   const signal = await x.mentionsFromTrusted('GPT-5.4');

const fs = require('fs');
const path = require('path');

// ─── .env loader (no deps) ────────────────────────────────────────────────────
function loadEnv() {
  const p = path.join(__dirname, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (!m) continue;
    const [, k, v = ''] = m;
    if (process.env[k] == null) process.env[k] = v.replace(/^['"]|['"]$/g, '');
  }
}
loadEnv();

const TOKEN = process.env.X_BEARER_TOKEN;
const DAILY_BUDGET = Number(process.env.X_DAILY_CALL_BUDGET || 50);
const CACHE_DIR = path.join(__dirname, '.cache');
const BUDGET_FILE = path.join(CACHE_DIR, 'x-budget.json');
const CACHE_TTL_MS = 20 * 60 * 1000;

function ensureCacheDir() { if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true }); }

function todayUTC() { return new Date().toISOString().slice(0, 10); }

function readBudget() {
  try {
    const b = JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8'));
    if (b.date !== todayUTC()) return { date: todayUTC(), calls: 0 };
    return b;
  } catch { return { date: todayUTC(), calls: 0 }; }
}
function writeBudget(b) { ensureCacheDir(); fs.writeFileSync(BUDGET_FILE, JSON.stringify(b, null, 2)); }

function cacheKey(name, params) {
  const crypto = require('crypto');
  const raw = name + ':' + JSON.stringify(params || {});
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16);
}
function readCache(key) {
  const f = path.join(CACHE_DIR, `x-${key}.json`);
  if (!fs.existsSync(f)) return null;
  try {
    const b = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (Date.now() - b.ts > CACHE_TTL_MS) return null;
    return b.data;
  } catch { return null; }
}
function writeCache(key, data) {
  ensureCacheDir();
  fs.writeFileSync(path.join(CACHE_DIR, `x-${key}.json`), JSON.stringify({ ts: Date.now(), data }, null, 2));
}

// ─── Gated API call ───────────────────────────────────────────────────────────
async function apiCall(endpoint, params = {}, cacheName = null) {
  if (!TOKEN) throw new Error('X_BEARER_TOKEN not set in .env');

  // Cache check first — returns without burning budget
  const key = cacheKey(cacheName || endpoint, params);
  const cached = readCache(key);
  if (cached) return { ...cached, _cached: true };

  // Budget check
  const b = readBudget();
  if (b.calls >= DAILY_BUDGET) {
    throw new Error(`X daily budget exhausted (${b.calls}/${DAILY_BUDGET}). Resets at UTC midnight.`);
  }

  const url = new URL('https://api.x.com/2' + endpoint);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v));

  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  b.calls += 1;
  writeBudget(b);

  if (res.status === 429) {
    const reset = res.headers.get('x-rate-limit-reset');
    throw new Error(`X rate-limited (HTTP 429). Reset at epoch ${reset}.`);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`X ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  writeCache(key, json);
  return { ...json, _cached: false };
}

// ─── Loading trusted voices config ────────────────────────────────────────────
function loadTrustedVoices() {
  const tv = JSON.parse(fs.readFileSync(path.join(__dirname, 'trusted_voices.json'), 'utf8'));
  const tier = (t) => (tv.tiers?.[t] || []).map(h => h.handle);
  return {
    tier1: tier('tier_1_must_watch'),
    tier2: tier('tier_2_trusted_practitioners'),
    tier3: tier('tier_3_interesting'),
    all: tv.handles || [],
    weight: {
      tier_1_weight: tv._scoring?.tier_1_weight ?? 3,
      tier_2_weight: tv._scoring?.tier_2_weight ?? 2,
      tier_3_weight: tv._scoring?.tier_3_weight ?? 1
    }
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

// One call returns recent tweets from up to ~15 handles (X query limit is 512 chars).
// Returns tweets enriched with user + public_metrics.
async function trustedVoicesActivity({ tierScope = 'tier1+tier2', maxResults = 100 } = {}) {
  const tv = loadTrustedVoices();
  let handles;
  switch (tierScope) {
    case 'tier1':       handles = tv.tier1; break;
    case 'tier1+tier2': handles = [...tv.tier1, ...tv.tier2]; break;
    case 'all':         handles = tv.all; break;
    default:            handles = tv.tier1;
  }
  // X query limit: 512 chars. "from:X OR " is ~11 chars → ~40 handles max. We cap at 15 for safety.
  const pick = handles.slice(0, 15);
  const q = pick.map(h => `from:${h}`).join(' OR ') + ' -is:reply -is:retweet';

  const json = await apiCall('/tweets/search/recent', {
    query: q,
    max_results: Math.min(100, Math.max(10, maxResults)),
    'tweet.fields': 'created_at,public_metrics,entities',
    'expansions': 'author_id',
    'user.fields': 'username,name,verified'
  }, 'voices:' + tierScope);

  const users = Object.fromEntries((json.includes?.users || []).map(u => [u.id, u]));
  const tweets = (json.data || []).map(t => {
    const u = users[t.author_id] || {};
    return {
      id: t.id,
      handle: u.username,
      name: u.name,
      text: t.text,
      createdAt: t.created_at,
      likes: t.public_metrics?.like_count || 0,
      retweets: t.public_metrics?.retweet_count || 0,
      replies: t.public_metrics?.reply_count || 0,
      impressions: t.public_metrics?.impression_count || null,
      url: `https://x.com/${u.username}/status/${t.id}`
    };
  }).sort((a, b) => (b.likes + b.retweets * 3) - (a.likes + a.retweets * 3));

  return { tweets, queriedHandles: pick, cached: !!json._cached };
}

// For a given topic, check if any trusted voice mentioned it recently.
// Returns: { matchCount, weightedScore, matches: [{handle, tier, tweet}] }
async function mentionsFromTrusted(topic, { days = 7, maxResults = 50 } = {}) {
  const tv = loadTrustedVoices();
  const pick = tv.all.slice(0, 15);
  const q = `(${pick.map(h => `from:${h}`).join(' OR ')}) "${topic}" -is:retweet`;

  const json = await apiCall('/tweets/search/recent', {
    query: q,
    max_results: Math.min(100, maxResults),
    'tweet.fields': 'created_at,public_metrics',
    'expansions': 'author_id',
    'user.fields': 'username'
  }, `mentions:${topic}`);

  const users = Object.fromEntries((json.includes?.users || []).map(u => [u.id, u]));
  const matches = (json.data || []).map(t => {
    const u = users[t.author_id] || {};
    const tier = tv.tier1.includes(u.username) ? 1 : tv.tier2.includes(u.username) ? 2 : 3;
    const weight = tier === 1 ? tv.weight.tier_1_weight : tier === 2 ? tv.weight.tier_2_weight : tv.weight.tier_3_weight;
    return {
      handle: u.username, tier, weight,
      text: t.text, likes: t.public_metrics?.like_count || 0,
      url: `https://x.com/${u.username}/status/${t.id}`
    };
  });
  const weightedScore = matches.reduce((s, m) => s + m.weight, 0);
  return { topic, matchCount: matches.length, weightedScore, matches, cached: !!json._cached };
}

module.exports = {
  trustedVoicesActivity,
  mentionsFromTrusted,
  budget: () => readBudget(),
};

// ─── CLI ──────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const [, , cmd, ...rest] = process.argv;
  (async () => {
    if (cmd === 'budget') {
      const b = readBudget();
      console.log(`${b.calls} / ${DAILY_BUDGET} calls used today (${b.date} UTC). ${DAILY_BUDGET - b.calls} remaining.`);
      return;
    }
    if (cmd === 'reset-budget') { writeBudget({ date: todayUTC(), calls: 0 }); console.log('Budget reset.'); return; }
    if (cmd === 'voices') {
      const r = await trustedVoicesActivity({ tierScope: 'tier1' });
      console.log(`[${r.cached ? 'cached' : 'fresh'}] ${r.tweets.length} tweets from tier-1 voices:\n`);
      r.tweets.slice(0, 15).forEach((t, i) => {
        console.log(`${i + 1}. @${t.handle} · ${t.likes.toLocaleString()} likes · ${t.retweets.toLocaleString()} RTs`);
        console.log(`   ${t.text.replace(/\s+/g, ' ').slice(0, 180)}`);
        console.log(`   ${t.url}\n`);
      });
      return;
    }
    if (cmd === 'voices-all') {
      const r = await trustedVoicesActivity({ tierScope: 'all', maxResults: 100 });
      console.log(`[${r.cached ? 'cached' : 'fresh'}] ${r.tweets.length} tweets · handles queried: ${r.queriedHandles.join(', ')}`);
      r.tweets.slice(0, 20).forEach(t => console.log(`  @${t.handle} (${t.likes}♥) ${t.text.slice(0, 140).replace(/\s+/g, ' ')}`));
      return;
    }
    if (cmd === 'mentions') {
      const r = await mentionsFromTrusted(rest.join(' '));
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    console.error('Usage: node xCheck.js voices | voices-all | mentions "<topic>" | budget | reset-budget');
    process.exit(2);
  })().catch(e => { console.error('Error:', e.message); process.exit(1); });
}
