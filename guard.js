#!/usr/bin/env node
/**
 * guard.js — Five-layer validation pipeline for queue items.
 *
 * Layers:
 *  1. Prompt Injection Protection  — adversarial text in scraped content
 *  2. Schema Guardrails            — fields, types, ranges, ID/tag format
 *  3. Anti-Confabulation           — internal consistency, formula auto-correction
 *  4. Anti-Hallucination / Anti-Bias — signals, FUD, dedup, diversity, freshness
 *  5. Judge                        — aggregates → PASS / WARN / FAIL + penalty
 *
 * Sync API (no network):
 *   const { auditItem, auditBatch } = require('./guard');
 *   const result = auditItem(item, { posts, rejected });
 *
 * Async API (includes URL reachability):
 *   const { auditItemAsync, auditBatchAsync } = require('./guard');
 *   const result = await auditItemAsync(item, { posts, rejected });
 *
 * CLI:
 *   node guard.js [queue.json] [--fix] [--report] [--async]
 */

'use strict';

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const http  = require('http');

// ─── Constants ────────────────────────────────────────────────────────────────

const VALID_CATEGORIES = new Set([
  'AI', 'Quantum', 'Cybersecurity', 'Startups', 'Research', 'Top Tweets', 'Viral',
]);

const REQUIRED_FIELDS = [
  'id', 'category', 'title', 'summary', 'url', 'source',
  'metrics', 'signals', 'whyItMatters', 'trustVerdict',
];

const METRIC_FIELDS = [
  'coverage', 'social', 'novelty', 'authority', 'concreteness', 'stakes', 'fudRisk',
];

// Importance formula weights (must match HUNT.md)
const WEIGHTS = {
  stakes: 0.22, novelty: 0.18, authority: 0.15,
  coverage: 0.12, concreteness: 0.12, social: 0.11, fudRisk: 0.10,
};

// Plausible upper bounds for signal fields
const SIGNAL_BOUNDS = {
  twitterMentions:    5_000_000,
  outletCount:        300,
  'redditTop.upvotes': 200_000,
  'topTweets[].likes': 5_000_000,
};

// Diversity windows
const HISTORY_WINDOW   = 10;   // look-back into posts[]
const HISTORY_MAX_SAME = 5;    // ≥ this many of same category → history penalty
const BATCH_MAX_SAME   = 3;    // within a single batch, ≥ this many → batch penalty

// Quality thresholds
const MIN_IMPORTANCE       = 4.0;
const MIN_SUMMARY_CHARS    = 150;
const MAX_SUMMARY_CHARS    = 1200;
const MIN_WHY_CHARS        = 150;
const MAX_TITLE_CHARS      = 200;
const FORMULA_DRIFT_WARN   = 1.0;   // auto-correct above this
const FORMULA_DRIFT_ERROR  = 2.5;   // error above this (even after correction)
const MAX_ARTICLE_AGE_DAYS = 30;

// ─── Layer 1: Prompt Injection Protection ─────────────────────────────────────

// Ordered by severity — first match wins for a given field.
const INJECTION_RULES = [
  // Classic instruction overrides
  { re: /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+instructions/i,    sev: 'critical' },
  { re: /disregard\s+(all\s+)?(previous|prior|above)\s+/i,                     sev: 'critical' },
  { re: /override\s+(all\s+)?instructions/i,                                   sev: 'critical' },
  { re: /forget\s+(everything|all previous|your instructions)/i,               sev: 'critical' },
  { re: /new\s+(system\s+)?prompt\s*:/i,                                       sev: 'critical' },
  // Template delimiters used in fine-tuning / structured prompts
  { re: /\[INST\]|\[\/INST\]|\[SYS\]|\[\/SYS\]/,                              sev: 'critical' },
  { re: /<\|system\|>|<\|user\|>|<\|assistant\|>|<\|im_start\|>/,             sev: 'critical' },
  { re: /###\s*(Instruction|System|Human|Assistant|Context)\s*:/i,             sev: 'critical' },
  { re: /<system>[\s\S]{0,200}<\/system>/i,                                    sev: 'critical' },
  // Role-playing / capability unlocking
  { re: /you\s+are\s+now\s+(a\s+)?(?:DAN|jailbreak|unfiltered|unrestricted)/i, sev: 'critical' },
  { re: /act\s+as\s+(an?\s+)?(?:AI\s+)?(?:with\s+no\s+(?:filter|restriction|limit)|unethical)/i, sev: 'critical' },
  { re: /pretend\s+(you\s+)?(?:have\s+no\s+(?:filter|guideline)|to\s+be\s+evil)/i, sev: 'critical' },
  { re: /developer\s+mode\s+(on|enabled|activated)/i,                         sev: 'critical' },
  { re: /\bDAN\s+mode\b/i,                                                     sev: 'critical' },
  // Prompt leaking
  { re: /repeat\s+(your\s+)?(system\s+)?prompt/i,                             sev: 'error'    },
  { re: /print\s+(your\s+)?(instructions|system\s+prompt)/i,                  sev: 'error'    },
  { re: /reveal\s+(your\s+)?(instructions|prompt|training)/i,                 sev: 'error'    },
  // Fake schema injection — trying to pre-load a high-score item
  { re: /"importance"\s*:\s*(?:10(?:\.0)?|9\.[5-9])/,                         sev: 'error'    },
  { re: /"trustVerdict"\s*:\s*"high"/,                                         sev: 'error'    },
  { re: /add\s+this\s+(item\s+)?to\s+(the\s+)?queue/i,                       sev: 'error'    },
  // Unicode tricks (homoglyphs, RTL override, zero-width)
  { re: /[\u202A-\u202E\u2066-\u2069]/,                                        sev: 'error'    },
  { re: /[\u200B-\u200F\uFEFF\u00AD]/,                                         sev: 'warn'     },
];

const INJECT_FIELDS = ['title', 'summary', 'whyItMatters', 'trustNotes', 'source', 'id'];

function checkInjection(item) {
  const flags = [];
  for (const field of INJECT_FIELDS) {
    const text = String(item[field] || '');
    for (const { re, sev } of INJECTION_RULES) {
      if (re.test(text)) {
        flags.push({ layer: 'injection', field, severity: sev,
          msg: `injection pattern matched: ${re}`,
          excerpt: text.replace(/\s+/g, ' ').slice(0, 120) });
        break; // one flag per field
      }
    }
  }
  // URL should not contain JS/SQL injection chars
  const urlDanger = /[<>"'`;]|\bjavascript:/i;
  if (urlDanger.test(item.url || '')) {
    flags.push({ layer: 'injection', field: 'url', severity: 'critical',
      msg: 'dangerous characters in URL', excerpt: String(item.url).slice(0, 100) });
  }
  return flags;
}

// ─── Layer 2: Schema Guardrails ───────────────────────────────────────────────

function checkSchema(item) {
  const flags = [];

  // Required fields
  for (const f of REQUIRED_FIELDS) {
    if (item[f] == null || item[f] === '') {
      flags.push({ layer: 'schema', field: f, severity: 'error', msg: 'missing required field' });
    }
  }

  // Category
  if (item.category && !VALID_CATEGORIES.has(item.category)) {
    flags.push({ layer: 'schema', field: 'category', severity: 'error',
      msg: `invalid category "${item.category}" — must be one of: ${[...VALID_CATEGORIES].join(', ')}` });
  }

  // ID: must be kebab-case, 4-80 chars, no spaces
  if (item.id) {
    if (!/^[a-z0-9][a-z0-9\-]{2,78}[a-z0-9]$/.test(item.id)) {
      flags.push({ layer: 'schema', field: 'id', severity: 'warn',
        msg: `id "${item.id}" is not valid kebab-case (lowercase, hyphens only, 4–80 chars)` });
    }
    if (item.id.length > 80) {
      flags.push({ layer: 'schema', field: 'id', severity: 'error', msg: `id too long (${item.id.length} chars)` });
    }
  }

  // URL: must be valid http(s), not localhost/private
  if (item.url) {
    try {
      const u = new URL(item.url);
      if (!['http:', 'https:'].includes(u.protocol)) {
        flags.push({ layer: 'schema', field: 'url', severity: 'error',
          msg: `URL protocol must be http/https, got ${u.protocol}` });
      }
      if (/^(localhost|127\.|10\.|192\.168\.|0\.0\.0\.0)/.test(u.hostname)) {
        flags.push({ layer: 'schema', field: 'url', severity: 'error',
          msg: 'URL points to localhost/private network — not a real source' });
      }
    } catch {
      flags.push({ layer: 'schema', field: 'url', severity: 'error',
        msg: `malformed URL: ${item.url}` });
    }
  }

  // primarySource URL format (if present)
  if (item.primarySource) {
    try { new URL(item.primarySource); } catch {
      flags.push({ layer: 'schema', field: 'primarySource', severity: 'warn',
        msg: `malformed primarySource URL: ${item.primarySource}` });
    }
  }

  // Metrics: must be numbers in [0, 10]
  const m = item.metrics || {};
  for (const f of METRIC_FIELDS) {
    if (m[f] == null) {
      flags.push({ layer: 'schema', field: `metrics.${f}`, severity: 'warn', msg: 'metric missing' });
    } else if (typeof m[f] !== 'number' || isNaN(m[f]) || m[f] < 0 || m[f] > 10) {
      flags.push({ layer: 'schema', field: `metrics.${f}`, severity: 'error',
        msg: `value ${m[f]} out of range [0, 10]` });
    }
  }
  if (m.importance != null && (typeof m.importance !== 'number' || m.importance < 0 || m.importance > 10)) {
    flags.push({ layer: 'schema', field: 'metrics.importance', severity: 'error',
      msg: `importance ${m.importance} out of range [0, 10]` });
  }

  // trustVerdict
  if (item.trustVerdict && !['high', 'medium', 'low'].includes(item.trustVerdict)) {
    flags.push({ layer: 'schema', field: 'trustVerdict', severity: 'error',
      msg: `invalid trustVerdict "${item.trustVerdict}"` });
  }

  // Title length
  if (item.title) {
    if (item.title.length > MAX_TITLE_CHARS) {
      flags.push({ layer: 'schema', field: 'title', severity: 'warn',
        msg: `title too long (${item.title.length} chars, max ${MAX_TITLE_CHARS})` });
    }
    if (item.title.length < 20) {
      flags.push({ layer: 'schema', field: 'title', severity: 'warn',
        msg: `title too short (${item.title.length} chars)` });
    }
  }

  // Summary length
  if (item.summary) {
    if (item.summary.length < MIN_SUMMARY_CHARS) {
      flags.push({ layer: 'schema', field: 'summary', severity: 'warn',
        msg: `summary too short (${item.summary.length} chars, min ${MIN_SUMMARY_CHARS})` });
    }
    if (item.summary.length > MAX_SUMMARY_CHARS) {
      flags.push({ layer: 'schema', field: 'summary', severity: 'warn',
        msg: `summary too long (${item.summary.length} chars, max ${MAX_SUMMARY_CHARS})` });
    }
  }

  // whyItMatters length and non-echo
  if (item.whyItMatters) {
    if (item.whyItMatters.length < MIN_WHY_CHARS) {
      flags.push({ layer: 'schema', field: 'whyItMatters', severity: 'warn',
        msg: `whyItMatters too short (${item.whyItMatters.length} chars, min ${MIN_WHY_CHARS})` });
    }
    // Detect title echo: if whyItMatters starts with the same 40 chars as title
    if (item.title && item.whyItMatters.trim().slice(0, 40).toLowerCase() ===
        item.title.trim().slice(0, 40).toLowerCase()) {
      flags.push({ layer: 'schema', field: 'whyItMatters', severity: 'warn',
        msg: 'whyItMatters appears to echo the title — should explain downstream consequences' });
    }
    // Detect summary echo
    if (item.summary && item.whyItMatters.trim().slice(0, 60) === item.summary.trim().slice(0, 60)) {
      flags.push({ layer: 'schema', field: 'whyItMatters', severity: 'warn',
        msg: 'whyItMatters appears to echo the summary — should add new reasoning' });
    }
  }

  // Tags: at least 3, should be lowercase strings, no spaces
  if (!Array.isArray(item.tags) || item.tags.length < 3) {
    flags.push({ layer: 'schema', field: 'tags', severity: 'warn',
      msg: `too few tags (${(item.tags || []).length}, min 3)` });
  } else {
    for (const tag of item.tags) {
      if (typeof tag !== 'string' || tag !== tag.toLowerCase()) {
        flags.push({ layer: 'schema', field: 'tags', severity: 'warn',
          msg: `tag "${tag}" should be lowercase` });
        break;
      }
      if (/\s/.test(tag) && !tag.includes('-')) {
        flags.push({ layer: 'schema', field: 'tags', severity: 'warn',
          msg: `tag "${tag}" contains spaces — use hyphens` });
        break;
      }
    }
  }

  return flags;
}

// ─── Layer 3: Anti-Confabulation ─────────────────────────────────────────────

/**
 * Extract all number tokens from text, handling:
 *  123,456  →  123456
 *  $300B    →  300B
 *  €54k     →  54k
 *  1.47x    →  1.47x
 *  97M      →  97M
 *  1,752 pts → 1752
 */
function extractNumbers(text) {
  const found = new Set();
  // Pattern: optional currency prefix, digits with optional commas, optional decimal,
  // optional multiplier suffix (k/K/M/B/T/x/×/%)
  const re = /(?:[$€£¥₹])?(\d[\d,]*(?:\.\d+)?)\s*([kKMBTGx×%](?:pts?|stars?|installs?|downloads?|likes?)?)?/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0].trim();
    if (raw.length < 2) continue;
    const normalized = raw.replace(/,/g, '').replace(/[€$£¥₹]/g, '');
    found.add(raw);
    found.add(normalized);
    // Also add just the digits for loose matching
    found.add(m[1].replace(/,/g, ''));
  }
  return found;
}

/**
 * Auto-correct importance using the formula, return the corrected value.
 */
function computeImportance(m) {
  return (
    WEIGHTS.stakes      * m.stakes      +
    WEIGHTS.novelty     * m.novelty     +
    WEIGHTS.authority   * m.authority   +
    WEIGHTS.coverage    * m.coverage    +
    WEIGHTS.concreteness * m.concreteness +
    WEIGHTS.social      * m.social      +
    WEIGHTS.fudRisk     * (10 - m.fudRisk)
  );
}

// FUD patterns for confabulation + hallucination checks
const FUD_PATTERNS = [
  /world\s+is\s+not\s+ready/i,
  /changes?\s+everything/i,
  /nobody\s+saw\s+(this\s+)?coming/i,
  /(?:end|death|doom)\s+of\s+(?:humanity|civilization|democracy|privacy|the\s+world)/i,
  /breaks?\s+(?:the\s+)?(?:internet|web|encryption|everything)\s+(forever|permanently)/i,
  /ai\s+(?:takes?\s+over|becomes?\s+sentient|gains?\s+consciousness|wakes?\s+up)/i,
  /\b(?:bombshell|explosive|stunning|mind-?blowing|earth-?shattering)\b/i,
  /secret\s+(?:project|weapon|document|lab|plan|memo)\s+(?:reveals?|exposes?|leaks?)/i,
  /(?:100x|1000x)\s+(?:faster|better|smarter|cheaper)\s+than\s+(?:human|expert)/i,
  /general\s+artificial\s+intelligence\s+(?:achieved|created|discovered)/i,
  /\bASI\b.{0,30}(?:imminent|arrived?|here)/i,
];

// Known-unreliable source domains that lower trust floor
const LOW_TRUST_DOMAINS = new Set([
  'zerohedge.com', 'naturalnews.com', 'infowars.com', 'breitbart.com',
  'dailywire.com', 'thegatewaypundit.com', 'beforeitsnews.com',
  'collective-evolution.com', 'activistpost.com',
]);

// Known high-authority domains (bump authority floor for confabulation check)
const HIGH_AUTHORITY_DOMAINS = new Set([
  'anthropic.com', 'openai.com', 'deepmind.google', 'ai.meta.com',
  'arxiv.org', 'nature.com', 'science.org', 'nytimes.com',
  'wsj.com', 'ft.com', 'bloomberg.com', 'reuters.com',
  'techcrunch.com', 'theverge.com', 'wired.com', 'arstechnica.com',
]);

function getHostname(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function checkConfabulation(item) {
  const flags = [];
  const title   = item.title   || '';
  const summary = item.summary || '';
  const why     = item.whyItMatters || '';
  const m       = item.metrics  || {};
  const s       = item.signals  || {};
  const fullBody = `${summary} ${why}`;

  // 1. Numbers in title must appear in summary or whyItMatters
  const titleNums = extractNumbers(title);
  for (const num of titleNums) {
    if (num.length < 3) continue;
    if (!fullBody.includes(num)) {
      flags.push({ layer: 'confabulation', severity: 'warn',
        msg: `"${num}" claimed in title not found in summary/whyItMatters` });
    }
  }

  // 2. outletCount plausibility vs named outlets
  if (s.outletCount > 0 && Array.isArray(s.outlets) && s.outlets.length > 0) {
    if (s.outletCount > s.outlets.length * 8 && s.outletCount > 20) {
      flags.push({ layer: 'confabulation', severity: 'warn',
        msg: `outletCount=${s.outletCount} but only ${s.outlets.length} outlets named — inflate suspicion` });
    }
  }

  // 3. High importance without tier-1 backing
  if ((m.importance || 0) >= 8 && (s.tier1Count || 0) === 0) {
    flags.push({ layer: 'confabulation', severity: 'warn',
      msg: `importance=${m.importance} but tier1Count=0 — needs tier-1 source for this score` });
  }

  // 4. trustVerdict=high requires primarySource
  if (item.trustVerdict === 'high' && !item.primarySource) {
    flags.push({ layer: 'confabulation', severity: 'error',
      msg: 'trustVerdict=high but primarySource is missing' });
  }

  // 5. trustVerdict vs fudRisk consistency
  if (item.trustVerdict === 'high' && (m.fudRisk || 0) >= 5) {
    flags.push({ layer: 'confabulation', severity: 'error',
      msg: `trustVerdict=high but fudRisk=${m.fudRisk} — contradictory` });
  }
  if (item.trustVerdict === 'low' && (m.fudRisk || 0) < 4) {
    flags.push({ layer: 'confabulation', severity: 'warn',
      msg: `trustVerdict=low but fudRisk=${m.fudRisk} — if trust is low, fudRisk should reflect it` });
  }

  // 6. FUD title with low fudRisk
  for (const pat of FUD_PATTERNS) {
    if (pat.test(title) && (m.fudRisk || 0) <= 2) {
      flags.push({ layer: 'confabulation', severity: 'warn',
        msg: `FUD headline pattern matched but fudRisk=${m.fudRisk} — likely under-scored` });
      break;
    }
  }

  // 7. twitterMentions >> trustedVoicesCount in implausible ratio
  if ((s.twitterMentions || 0) > 500_000 && (s.trustedVoicesCount || 0) === 0) {
    flags.push({ layer: 'confabulation', severity: 'warn',
      msg: `twitterMentions=${s.twitterMentions.toLocaleString()} with trustedVoicesCount=0 — implausible` });
  }

  // 8. Source-URL domain consistency
  if (item.url && item.source) {
    const hostname  = getHostname(item.url);
    const srcLower  = item.source.toLowerCase().replace(/[^a-z0-9]/g, '');
    const hostParts = hostname.toLowerCase().split('.');
    const domainWord = hostParts[hostParts.length - 2] || '';
    // Low-trust domain with high trust verdict
    if (LOW_TRUST_DOMAINS.has(hostname) && item.trustVerdict === 'high') {
      flags.push({ layer: 'confabulation', severity: 'error',
        msg: `URL domain "${hostname}" is known low-reliability but trustVerdict=high` });
    }
    // Source name and domain should share at least one recognisable word
    // (skip this check for aggregators like HN, Reddit, Google News)
    const AGGREGATORS = new Set(['news.ycombinator.com', 'reddit.com', 'news.google.com', 'twitter.com', 'x.com']);
    if (!AGGREGATORS.has(hostname) && domainWord.length >= 4) {
      const domainInSource = srcLower.includes(domainWord);
      const sourceInDomain = domainWord.includes(srcLower.slice(0, 6));
      if (!domainInSource && !sourceInDomain && srcLower.length > 4) {
        flags.push({ layer: 'confabulation', severity: 'warn',
          msg: `source="${item.source}" but URL domain is "${hostname}" — mismatch?` });
      }
    }
  }

  // 9. Importance formula auto-correction + cross-check
  if (METRIC_FIELDS.every(f => m[f] != null)) {
    const computed = computeImportance(m);
    const claimed  = m.importance;
    if (claimed != null) {
      const drift = Math.abs(computed - claimed);
      if (drift > FORMULA_DRIFT_WARN) {
        // Auto-correct silently — attach corrected value to the item
        item.metrics.importance = Math.round(computed * 100) / 100;
        flags.push({ layer: 'confabulation', severity: drift > FORMULA_DRIFT_ERROR ? 'error' : 'warn',
          msg: `importance ${claimed.toFixed(2)} → auto-corrected to formula result ${computed.toFixed(2)} (drift ${drift.toFixed(2)})` });
      }
    } else {
      // Missing importance — fill it in
      item.metrics.importance = Math.round(computed * 100) / 100;
      flags.push({ layer: 'confabulation', severity: 'warn',
        msg: `importance missing — computed and set to ${item.metrics.importance}` });
    }
  }

  // 10. Freshness: article should not be older than MAX_ARTICLE_AGE_DAYS
  // Check common date-like fields the hunt agent might add
  const dateStr = item.publishedAt || item.articleDate || item.date;
  if (dateStr) {
    const age = (Date.now() - new Date(dateStr).getTime()) / 86_400_000;
    if (!isNaN(age) && age > MAX_ARTICLE_AGE_DAYS) {
      flags.push({ layer: 'confabulation', severity: 'warn',
        msg: `article age ~${Math.round(age)} days exceeds ${MAX_ARTICLE_AGE_DAYS}-day freshness limit` });
    }
  }

  return flags;
}

// ─── Layer 4: Anti-Hallucination + Anti-Bias ─────────────────────────────────

function checkHallucinationAndBias(item, { posts = [], rejected = [], batch = [] } = {}) {
  const flags = [];
  const m = item.metrics || {};
  const s = item.signals  || {};

  // A) Anti-Hallucination ─────────────────────────────────────────────────────

  // 1. Minimum corroborating signal floor
  const signals = {
    hn:      (s.hnPoints || 0) > 0 || (s.outletCount || 0) >= 2,
    reddit:  Array.isArray(s.subreddits) && s.subreddits.length > 0,
    outlet:  (s.outletCount || 0) >= 1,
    twitter: (s.twitterMentions || 0) > 0 || (s.trustedVoicesCount || 0) > 0,
    redditTop: (s.redditTop?.upvotes || 0) > 0,
  };
  const sigCount = Object.values(signals).filter(Boolean).length;
  if (sigCount === 0) {
    flags.push({ layer: 'hallucination', severity: 'error',
      msg: 'zero corroborating signals — item may be entirely fabricated' });
  } else if (sigCount === 1) {
    flags.push({ layer: 'hallucination', severity: 'warn',
      msg: `only 1 signal type present (${Object.entries(signals).filter(([,v])=>v).map(([k])=>k).join(',')}) — weak corroboration` });
  }

  // 2. Plausibility bounds on signal numbers
  if ((s.twitterMentions || 0) > SIGNAL_BOUNDS.twitterMentions) {
    flags.push({ layer: 'hallucination', severity: 'error',
      msg: `twitterMentions=${s.twitterMentions.toLocaleString()} exceeds plausible bound (${SIGNAL_BOUNDS.twitterMentions.toLocaleString()})` });
  }
  if ((s.outletCount || 0) > SIGNAL_BOUNDS.outletCount) {
    flags.push({ layer: 'hallucination', severity: 'error',
      msg: `outletCount=${s.outletCount} exceeds plausible bound (${SIGNAL_BOUNDS.outletCount})` });
  }
  if ((s.redditTop?.upvotes || 0) > SIGNAL_BOUNDS['redditTop.upvotes']) {
    flags.push({ layer: 'hallucination', severity: 'error',
      msg: `redditTop.upvotes=${s.redditTop.upvotes.toLocaleString()} exceeds plausible 24h bound` });
  }
  const maxLikes = Math.max(...(s.topTweets || []).map(t => t.likes || 0), 0);
  if (maxLikes > SIGNAL_BOUNDS['topTweets[].likes']) {
    flags.push({ layer: 'hallucination', severity: 'error',
      msg: `topTweets[].likes=${maxLikes.toLocaleString()} exceeds plausible bound` });
  }

  // 3. trustVerdict=high with low authority
  if (item.trustVerdict === 'high' && (m.authority || 0) < 5) {
    flags.push({ layer: 'hallucination', severity: 'warn',
      msg: `trustVerdict=high but authority=${m.authority} — inconsistent` });
  }

  // 4. FUD in body text
  const fullText = `${item.title || ''} ${item.summary || ''} ${item.whyItMatters || ''}`;
  for (const pat of FUD_PATTERNS) {
    if (pat.test(fullText)) {
      flags.push({ layer: 'hallucination', severity: 'warn',
        msg: `FUD pattern matched in body: ${pat.source.slice(0, 60)}` });
      break;
    }
  }

  // 5. Importance below publish threshold
  if ((item.metrics?.importance || 0) < MIN_IMPORTANCE) {
    flags.push({ layer: 'hallucination', severity: 'warn',
      msg: `importance=${item.metrics?.importance} below publish threshold ${MIN_IMPORTANCE}` });
  }

  // 6. High-authority domain mentioned in source but not in URL
  const hostname = getHostname(item.url);
  if (HIGH_AUTHORITY_DOMAINS.has(hostname)) {
    // Good — primary source is authoritative. No flag.
  } else if (item.trustVerdict === 'high' && (m.authority || 0) >= 9 && !HIGH_AUTHORITY_DOMAINS.has(hostname)) {
    flags.push({ layer: 'hallucination', severity: 'warn',
      msg: `authority=9+ but URL domain "${hostname}" is not in known high-authority list` });
  }

  // B) Duplicate detection ────────────────────────────────────────────────────

  const normalizeUrl = u => (u || '').split('?')[0].split('#')[0].replace(/\/$/, '').toLowerCase();
  const itemUrl = normalizeUrl(item.url);

  if (posts.some(p => normalizeUrl(p.url) === itemUrl)) {
    flags.push({ layer: 'hallucination', severity: 'error',
      msg: `URL already published: ${item.url}` });
  }
  if (rejected.some(r => normalizeUrl(r.url) === itemUrl)) {
    flags.push({ layer: 'hallucination', severity: 'error',
      msg: `URL was previously rejected: ${item.url}` });
  }
  // Fuzzy title duplicate check (>80% overlap with existing post)
  const normTitle = (t) => (t || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  const words = new Set(normTitle(item.title).split(/\s+/).filter(w => w.length > 4));
  for (const p of posts) {
    const pWords = new Set(normTitle(p.title).split(/\s+/).filter(w => w.length > 4));
    const overlap = [...words].filter(w => pWords.has(w)).length;
    if (words.size > 0 && overlap / words.size > 0.8) {
      flags.push({ layer: 'hallucination', severity: 'warn',
        msg: `title closely matches published post "${p.id}" — possible near-duplicate` });
      break;
    }
  }

  // C) Anti-Confirmation Bias ─────────────────────────────────────────────────

  // Historical window bias
  if (posts.length > 0) {
    const window   = posts.slice(0, HISTORY_WINDOW);
    const catCount = window.filter(p => p.category === item.category).length;
    if (catCount >= HISTORY_MAX_SAME) {
      flags.push({ layer: 'bias', severity: 'warn',
        msg: `category "${item.category}" is ${catCount}/${window.length} of last ${HISTORY_WINDOW} posts — diversity penalty` });
    }
    // Suggest underrepresented categories
    const seenCats = new Set(window.map(p => p.category));
    const missing  = ['Research', 'Top Tweets', 'Startups'].filter(c => !seenCats.has(c));
    if (missing.length > 0 && ['AI', 'Viral'].includes(item.category)) {
      flags.push({ layer: 'bias', severity: 'info',
        msg: `[${missing.join(', ')}] absent from last ${HISTORY_WINDOW} posts — hunt should seek variety` });
    }
  }

  // Within-batch bias (item appears in same batch as multiple same-category items)
  if (batch.length > 0) {
    const batchSameCat = batch.filter(b => b.category === item.category && b.id !== item.id).length;
    if (batchSameCat >= BATCH_MAX_SAME) {
      flags.push({ layer: 'bias', severity: 'warn',
        msg: `${batchSameCat + 1} items in this batch share category "${item.category}" — over-represented` });
    }
  }

  return flags;
}

// ─── Layer 5: Judge ───────────────────────────────────────────────────────────

const SEV_WEIGHT = { critical: 100, error: 10, warn: 2, info: 0 };

function judgeScore(flags) {
  return flags.reduce((acc, f) => acc + (SEV_WEIGHT[f.severity] || 0), 0);
}

function verdictFromFlags(flags) {
  if (flags.some(f => f.severity === 'critical')) return 'fail';
  const errors = flags.filter(f => f.severity === 'error').length;
  const warns  = flags.filter(f => f.severity === 'warn').length;
  const score  = judgeScore(flags);
  if (errors >= 2 || score >= 100) return 'fail';
  if (errors >= 1 || warns >= 4 || score >= 6)  return 'warn';
  return 'pass';
}

function diversityPenalty(item, posts) {
  const window   = posts.slice(0, HISTORY_WINDOW);
  const catCount = window.filter(p => p.category === item.category).length;
  if (catCount < HISTORY_MAX_SAME) return 0;
  return -0.5 * (catCount - HISTORY_MAX_SAME + 1);
}

/**
 * Synchronous audit (no network calls).
 * @param {object}   item
 * @param {object}   context  { posts, rejected, batch }
 */
function auditItem(item, context = {}) {
  const { posts = [], rejected = [], batch = [] } = context;
  const flags = [
    ...checkInjection(item),
    ...checkSchema(item),
    ...checkConfabulation(item),
    ...checkHallucinationAndBias(item, { posts, rejected, batch }),
  ];
  const verdict = verdictFromFlags(flags);
  const penalty = diversityPenalty(item, posts);
  const score   = judgeScore(flags);
  const layers  = [...new Set(flags.map(f => f.layer))];
  const summary = flags.length === 0
    ? 'All checks passed.'
    : `${verdict.toUpperCase()} — ${flags.length} flag(s) [${layers.join(', ')}]. Score:${score} Penalty:${penalty}`;
  return { verdict, penalty, score, flags, summary };
}

/**
 * Sync batch audit.
 */
function auditBatch(items, context = {}) {
  const { posts = [], rejected = [], batch: _ } = context;
  const results = items.map(item =>
    ({ item, ...auditItem(item, { posts, rejected, batch: items }) })
  );
  return {
    results,
    passed:  results.filter(r => r.verdict !== 'fail'),
    failed:  results.filter(r => r.verdict === 'fail'),
    warned:  results.filter(r => r.verdict === 'warn'),
  };
}

// ─── Async URL Reachability (optional layer) ──────────────────────────────────

const URL_TIMEOUT_MS = 6_000;

function headRequest(url) {
  return new Promise((resolve) => {
    try {
      const u   = new URL(url);
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request(url, { method: 'HEAD',
        headers: { 'User-Agent': 'Mozilla/5.0 (treasurehunt-guard/2.0)' },
        timeout: URL_TIMEOUT_MS,
      }, res => resolve({ status: res.statusCode }));
      req.on('error', () => resolve({ status: 0, error: 'network' }));
      req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
      req.end();
    } catch {
      resolve({ status: 0, error: 'invalid-url' });
    }
  });
}

async function checkURLReachability(item) {
  const flags = [];
  for (const [field, url] of [['url', item.url], ['primarySource', item.primarySource]]) {
    if (!url) continue;
    const { status, error } = await headRequest(url);
    if (status === 404 || status === 410) {
      flags.push({ layer: 'url', field, severity: 'error',
        msg: `${field} returned HTTP ${status} — URL does not exist` });
    } else if (status === 0) {
      flags.push({ layer: 'url', field, severity: 'warn',
        msg: `${field} unreachable (${error}) — could not verify` });
    } else if (status >= 500) {
      flags.push({ layer: 'url', field, severity: 'warn',
        msg: `${field} returned HTTP ${status} (server error)` });
    }
    // 200-399, 401, 403, 429 = URL exists, just may require auth/has rate limit
  }
  return flags;
}

async function auditItemAsync(item, context = {}) {
  const syncResult  = auditItem(item, context);
  const urlFlags    = await checkURLReachability(item);
  const allFlags    = [...syncResult.flags, ...urlFlags];
  const verdict     = verdictFromFlags(allFlags);
  const score       = judgeScore(allFlags);
  const layers      = [...new Set(allFlags.map(f => f.layer))];
  const summary     = allFlags.length === 0
    ? 'All checks passed (including URL).'
    : `${verdict.toUpperCase()} — ${allFlags.length} flag(s) [${layers.join(', ')}]. Score:${score}`;
  return { verdict, penalty: syncResult.penalty, score, flags: allFlags, summary };
}

async function auditBatchAsync(items, context = {}) {
  const { posts = [], rejected = [] } = context;
  const results = await Promise.all(
    items.map(item => auditItemAsync(item, { posts, rejected, batch: items }))
      .map((p, i) => p.then(r => ({ item: items[i], ...r })))
  );
  return {
    results,
    passed: results.filter(r => r.verdict !== 'fail'),
    failed: results.filter(r => r.verdict === 'fail'),
    warned: results.filter(r => r.verdict === 'warn'),
  };
}

// ─── Sanitise scraped content ─────────────────────────────────────────────────

function sanitize(text) {
  if (typeof text !== 'string') return text;
  let out = text;
  for (const { re } of INJECTION_RULES) {
    out = out.replace(re, '[REDACTED]');
  }
  // Remove Unicode tricks
  out = out.replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF\u00AD]/g, '');
  return out;
}

function sanitizeTrendingItem(item) {
  return {
    ...item,
    title: sanitize(item.title),
    meta: item.meta ? {
      ...item.meta,
      description: sanitize(item.meta.description),
      fullText:    sanitize(item.meta.fullText),
    } : item.meta,
  };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  (async () => {
    const args      = process.argv.slice(2);
    const fix       = args.includes('--fix');
    const report    = args.includes('--report');
    const useAsync  = args.includes('--async');
    const file      = args.find(a => !a.startsWith('--')) || path.join(__dirname, 'queue.json');
    const root      = path.dirname(file) === '.' ? __dirname : path.dirname(file);

    let items, posts, rejected;
    try {
      items    = JSON.parse(fs.readFileSync(file, 'utf8'));
      posts    = JSON.parse(fs.readFileSync(path.join(root, 'posts.json'), 'utf8'));
      rejected = JSON.parse(fs.readFileSync(path.join(root, 'rejected.json'), 'utf8'));
    } catch (e) {
      console.error('Error reading files:', e.message);
      process.exit(1);
    }

    if (!items.length) {
      console.log('Queue is empty — nothing to audit.');
      process.exit(0);
    }

    const ctx    = { posts, rejected };
    const audit  = useAsync
      ? await auditBatchAsync(items, ctx)
      : auditBatch(items, ctx);

    const { results, passed, failed, warned } = audit;

    console.log(`\n── Guard Audit: ${path.basename(file)} ${useAsync ? '(+URL checks)' : '(sync)'} ──`);
    console.log(`  Total : ${items.length}`);
    console.log(`  Pass  : ${passed.filter(r => r.verdict === 'pass').length}`);
    console.log(`  Warn  : ${warned.length}`);
    console.log(`  Fail  : ${failed.length}\n`);

    for (const r of results) {
      const icon = { pass: '✓', warn: '⚠', fail: '✗' }[r.verdict];
      console.log(`${icon} [${r.verdict.toUpperCase().padEnd(4)}] ${(r.item.id || '?').padEnd(35)} score:${r.score}`);
      if (report || r.verdict !== 'pass') {
        console.log(`       ${r.summary}`);
        for (const f of r.flags) {
          const badge = { critical: '🔴', error: '🟠', warn: '🟡', info: '🔵' }[f.severity] || '⚪';
          console.log(`       ${badge} [${f.layer}] ${f.msg || ''}`);
        }
        console.log();
      }
    }

    if (fix && failed.length > 0) {
      const kept = passed.map(r => r.item);
      fs.writeFileSync(file, JSON.stringify(kept, null, 2) + '\n');
      console.log(`--fix: removed ${failed.length} item(s) from ${path.basename(file)}`);
    }

    process.exit(failed.length > 0 ? 1 : 0);
  })();
}

module.exports = {
  auditItem, auditBatch,
  auditItemAsync, auditBatchAsync,
  sanitize, sanitizeTrendingItem,
  computeImportance, extractNumbers,
};
