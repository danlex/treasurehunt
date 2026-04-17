#!/usr/bin/env node
/**
 * guard.js — Five-layer validation pipeline for queue items.
 *
 * Layers (run in order):
 *  1. Prompt Injection Protection  — detect adversarial text in scraped content
 *  2. Schema Guardrails            — required fields, types, value ranges
 *  3. Anti-Confabulation           — internal consistency checks (numbers, signals)
 *  4. Anti-Hallucination / Anti-Confirmation-Bias — FUD, diversity, signal requirements
 *  5. Judge                        — aggregates all findings → PASS / WARN / FAIL
 *
 * Usage (module):
 *   const { auditItem, auditBatch } = require('./guard');
 *   const result = auditItem(item, recentPosts);  // { verdict, penalty, flags }
 *
 * Usage (CLI):
 *   node guard.js queue.json            — audit every item in queue
 *   node guard.js queue.json --fix      — remove FAIL items from queue in-place
 *   node guard.js queue.json --report   — print full report
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

// Patterns that indicate a prompt injection attempt in scraped content.
// These should never appear in legitimate news titles/summaries.
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+instructions/i,
  /disregard\s+(all\s+)?previous/i,
  /you\s+are\s+now\s+(a\s+)?(?!able|going|trying)/i,  // "you are now a ___" but not "you are now able"
  /new\s+(system\s+)?prompt/i,
  /forget\s+(everything|all|previous)/i,
  /\[INST\]|\[\/INST\]/,
  /<\|system\|>|<\|user\|>|<\|assistant\|>/,
  /###\s*(Instruction|System|Human|Assistant)\s*:/i,
  /OVERRIDE\s+(ALL\s+)?INSTRUCTIONS/,
  /jailbreak/i,
  /DAN\s+mode/i,
  /act\s+as\s+(an?\s+)?unfiltered/i,
  /pretend\s+(you\s+are|to\s+be)\s+(an?\s+)?AI\s+with\s+no/i,
  // Injection via fake JSON/schema attempts embedded in content
  /"importance"\s*:\s*(?:10|9\.9)/,          // suspiciously perfect scores
  /"trustVerdict"\s*:\s*"high"/,              // pre-claiming verdict in content
  /add\s+this\s+(item\s+)?to\s+(the\s+)?queue/i,
];

// FUD headline patterns that warrant automatic fudRisk bump
const FUD_HEADLINE_PATTERNS = [
  /world\s+is\s+not\s+ready/i,
  /changes\s+everything/i,
  /nobody\s+saw\s+(this\s+)?coming/i,
  /secret\s+(?:project|research|lab|plan)/i,
  /(?:end|death)\s+of\s+(?:humanity|civilization|democracy|privacy)/i,
  /breaks?\s+(?:the\s+)?(?:internet|web|encryption)\s+forever/i,
  /ai\s+(?:takes?\s+over|becomes?\s+sentient|gains?\s+consciousness)/i,
  /\b(?:bombshell|explosive|shocking|stunning)\b/i,
];

// Confirmation-bias guard: max consecutive items in same category before penalty
const CATEGORY_WINDOW = 10;     // look at last N published posts
const CATEGORY_MAX    = 5;      // if ≥ this many of last N are same category → penalty

// Minimum signal requirements (anti-hallucination)
const MIN_OUTLET_COUNT_FOR_HIGH_TRUST = 3;
const MIN_IMPORTANCE_THRESHOLD        = 4.0;   // items below this are filtered before publish

// ─── Layer 1: Prompt Injection Protection ────────────────────────────────────

function checkInjection(item) {
  const flags  = [];
  const fields = ['title', 'summary', 'whyItMatters', 'trustNotes', 'source'];

  for (const field of fields) {
    const text = String(item[field] || '');
    for (const pattern of INJECTION_PATTERNS) {
      if (pattern.test(text)) {
        flags.push({
          layer:   'injection',
          field,
          pattern: pattern.toString(),
          excerpt: text.slice(0, 100),
          severity: 'critical',
        });
        break; // one flag per field is enough
      }
    }
  }

  // Suspicious: ID or URL contains script/SQL injection markers
  const dangerousChars = /[<>'";\(\)\{\}]|--|\bSELECT\b|\bDROP\b/i;
  if (dangerousChars.test(item.id || '')) {
    flags.push({ layer: 'injection', field: 'id', severity: 'critical', excerpt: item.id });
  }
  if (dangerousChars.test(item.url || '')) {
    flags.push({ layer: 'injection', field: 'url', severity: 'critical', excerpt: item.url });
  }

  return flags;
}

// ─── Layer 2: Schema Guardrails ───────────────────────────────────────────────

function checkSchema(item) {
  const flags = [];

  // Required top-level fields
  for (const f of REQUIRED_FIELDS) {
    if (item[f] == null || item[f] === '') {
      flags.push({ layer: 'schema', field: f, severity: 'error', msg: 'missing required field' });
    }
  }

  // Category must be valid
  if (item.category && !VALID_CATEGORIES.has(item.category)) {
    flags.push({ layer: 'schema', field: 'category', severity: 'error',
      msg: `invalid category "${item.category}" — must be one of: ${[...VALID_CATEGORIES].join(', ')}` });
  }

  // URL format
  try {
    if (item.url) new URL(item.url);
  } catch {
    flags.push({ layer: 'schema', field: 'url', severity: 'error', msg: `malformed URL: ${item.url}` });
  }

  // Metric fields: must be numbers in [0, 10]
  const m = item.metrics || {};
  for (const f of METRIC_FIELDS) {
    if (m[f] == null) {
      flags.push({ layer: 'schema', field: `metrics.${f}`, severity: 'warn', msg: 'metric missing' });
    } else if (typeof m[f] !== 'number' || m[f] < 0 || m[f] > 10) {
      flags.push({ layer: 'schema', field: `metrics.${f}`, severity: 'error',
        msg: `value ${m[f]} out of range [0, 10]` });
    }
  }

  // Importance must be a number
  if (m.importance != null && (typeof m.importance !== 'number' || m.importance < 0 || m.importance > 10)) {
    flags.push({ layer: 'schema', field: 'metrics.importance', severity: 'error',
      msg: `importance ${m.importance} out of range` });
  }

  // trustVerdict must be valid
  if (item.trustVerdict && !['high', 'medium', 'low'].includes(item.trustVerdict)) {
    flags.push({ layer: 'schema', field: 'trustVerdict', severity: 'error',
      msg: `invalid trustVerdict "${item.trustVerdict}"` });
  }

  // Title/summary length
  if (item.title && item.title.length > 200) {
    flags.push({ layer: 'schema', field: 'title', severity: 'warn',
      msg: `title too long (${item.title.length} chars, max 200)` });
  }
  if (item.summary && item.summary.length < 100) {
    flags.push({ layer: 'schema', field: 'summary', severity: 'warn',
      msg: `summary too short (${item.summary.length} chars, min 100)` });
  }

  // Tags: should have at least 3
  if (!Array.isArray(item.tags) || item.tags.length < 3) {
    flags.push({ layer: 'schema', field: 'tags', severity: 'warn',
      msg: `too few tags (${(item.tags || []).length}, min 3)` });
  }

  return flags;
}

// ─── Layer 3: Anti-Confabulation ─────────────────────────────────────────────
// Checks that internal claims are self-consistent. Does NOT fetch URLs (that's layer 4).

function checkConfabulation(item) {
  const flags = [];
  const title   = item.title   || '';
  const summary = item.summary || '';
  const m       = item.metrics || {};
  const s       = item.signals || {};

  // 1. Numbers claimed in the title should appear somewhere in the summary or signals
  const numbersInTitle = title.match(/[\d,]+(?:\.\d+)?[BKMG%]?/g) || [];
  for (const num of numbersInTitle) {
    const normalized = num.replace(/,/g, '');
    const inSummary  = summary.includes(num) || summary.includes(normalized);
    const inWhy      = (item.whyItMatters || '').includes(num);
    if (!inSummary && !inWhy && num.length > 2) {
      flags.push({ layer: 'confabulation', severity: 'warn',
        msg: `number "${num}" in title not found in summary or whyItMatters` });
    }
  }

  // 2. outletCount vs outlets array size: if outletCount >> outlets.length, suspicious
  if (s.outletCount > 0 && Array.isArray(s.outlets) && s.outlets.length > 0) {
    const ratio = s.outletCount / s.outlets.length;
    if (ratio > 10 && s.outletCount > 20) {
      flags.push({ layer: 'confabulation', severity: 'warn',
        msg: `outletCount=${s.outletCount} but only ${s.outlets.length} outlets named — ratio suspicious` });
    }
  }

  // 3. If importance is high (≥8) but tier1Count is 0 or missing, flag
  if ((m.importance || 0) >= 8 && (s.tier1Count || 0) === 0) {
    flags.push({ layer: 'confabulation', severity: 'warn',
      msg: `importance=${m.importance} but tier1Count=0 — high importance without tier-1 backing is suspicious` });
  }

  // 4. trustVerdict='high' requires primarySource
  if (item.trustVerdict === 'high' && !item.primarySource) {
    flags.push({ layer: 'confabulation', severity: 'error',
      msg: 'trustVerdict=high but primarySource is missing' });
  }

  // 5. If fudRisk is low (≤2) but title matches a FUD pattern, inconsistency
  for (const pat of FUD_HEADLINE_PATTERNS) {
    if (pat.test(title) && (m.fudRisk || 0) <= 2) {
      flags.push({ layer: 'confabulation', severity: 'warn',
        msg: `title matches FUD pattern "${pat}" but fudRisk=${m.fudRisk} — under-scored FUD risk` });
      break;
    }
  }

  // 6. twitterMentions > 100k with trustedVoicesCount=0 is suspicious
  if ((s.twitterMentions || 0) > 100000 && (s.trustedVoicesCount || 0) === 0) {
    flags.push({ layer: 'confabulation', severity: 'warn',
      msg: `twitterMentions=${s.twitterMentions} but trustedVoicesCount=0 — implausible combination` });
  }

  // 7. Composite importance formula cross-check
  if (METRIC_FIELDS.every(f => m[f] != null)) {
    const computed = (
      0.22 * m.stakes + 0.18 * m.novelty + 0.15 * m.authority +
      0.12 * m.coverage + 0.12 * m.concreteness + 0.11 * m.social +
      0.10 * (10 - m.fudRisk)
    );
    const claimed  = m.importance || 0;
    if (Math.abs(computed - claimed) > 1.5) {
      flags.push({ layer: 'confabulation', severity: 'warn',
        msg: `importance=${claimed.toFixed(2)} deviates from formula result=${computed.toFixed(2)} by ${Math.abs(computed - claimed).toFixed(2)}` });
    }
  }

  return flags;
}

// ─── Layer 4: Anti-Hallucination + Anti-Confirmation-Bias ────────────────────

function checkHallucinationAndBias(item, recentPosts = []) {
  const flags = [];
  const m = item.metrics || {};
  const s = item.signals || {};

  // A) Anti-Hallucination

  // 1. Minimum signal floor: at least one real corroborating signal
  const hasHnSignal      = (s.hnPoints || 0) > 0;
  const hasRedditSignal  = Array.isArray(s.subreddits) && s.subreddits.length > 0;
  const hasOutletSignal  = (s.outletCount || 0) >= 1;
  const hasTweetSignal   = (s.twitterMentions || 0) > 0 || (s.trustedVoicesCount || 0) > 0;
  const signalCount      = [hasHnSignal, hasRedditSignal, hasOutletSignal, hasTweetSignal]
                             .filter(Boolean).length;

  if (signalCount < 1) {
    flags.push({ layer: 'hallucination', severity: 'error',
      msg: 'zero corroborating signals — item may be fabricated' });
  } else if (signalCount < 2) {
    flags.push({ layer: 'hallucination', severity: 'warn',
      msg: `only ${signalCount} signal type present — weak corroboration` });
  }

  // 2. FUD pattern in title/summary
  const fullText = `${item.title || ''} ${item.summary || ''}`;
  for (const pat of FUD_HEADLINE_PATTERNS) {
    if (pat.test(fullText)) {
      flags.push({ layer: 'hallucination', severity: 'warn',
        msg: `FUD pattern detected: ${pat}` });
      break;
    }
  }

  // 3. High-trust verdict with low authority score is inconsistent
  if (item.trustVerdict === 'high' && (m.authority || 0) < 5) {
    flags.push({ layer: 'hallucination', severity: 'warn',
      msg: `trustVerdict=high but authority=${m.authority} — inconsistent` });
  }

  // 4. Impossibly large numbers in signals (likely hallucinated)
  if ((s.twitterMentions || 0) > 10_000_000) {
    flags.push({ layer: 'hallucination', severity: 'error',
      msg: `twitterMentions=${s.twitterMentions} is implausibly large` });
  }
  if ((s.outletCount || 0) > 500) {
    flags.push({ layer: 'hallucination', severity: 'error',
      msg: `outletCount=${s.outletCount} is implausibly large` });
  }

  // 5. Importance too low to bother publishing
  if ((m.importance || 0) < MIN_IMPORTANCE_THRESHOLD) {
    flags.push({ layer: 'hallucination', severity: 'warn',
      msg: `importance=${m.importance} below minimum threshold ${MIN_IMPORTANCE_THRESHOLD}` });
  }

  // B) Anti-Confirmation Bias

  if (recentPosts.length > 0) {
    const window = recentPosts.slice(0, CATEGORY_WINDOW);
    const catCount = window.filter(p => p.category === item.category).length;
    if (catCount >= CATEGORY_MAX) {
      flags.push({ layer: 'bias', severity: 'warn',
        msg: `category "${item.category}" appears ${catCount}/${window.length} times in last ${CATEGORY_WINDOW} posts — diversity penalty applied` });
    }

    // Warn if we haven't published Research or Top Tweets in the last window
    const categories = new Set(window.map(p => p.category));
    const underrepresented = ['Research', 'Top Tweets'].filter(c => !categories.has(c));
    if (underrepresented.length > 0 && item.category === 'AI') {
      flags.push({ layer: 'bias', severity: 'info',
        msg: `categories ${underrepresented.join(', ')} absent from last ${CATEGORY_WINDOW} posts — consider adding variety` });
    }
  }

  return flags;
}

// ─── Layer 5: Judge ───────────────────────────────────────────────────────────

const SEVERITY_WEIGHT = { critical: 100, error: 10, warn: 2, info: 0 };
const FAIL_THRESHOLD  = 100;   // any critical OR ≥10 errors
const WARN_THRESHOLD  = 6;     // ≥3 warnings

/**
 * Bias-correction: category diversity penalty applied to the item's importance score.
 * Returns a delta (negative = penalty).
 */
function diversityPenalty(item, recentPosts) {
  const window   = recentPosts.slice(0, CATEGORY_WINDOW);
  const catCount = window.filter(p => p.category === item.category).length;
  if (catCount < CATEGORY_MAX) return 0;
  // Linear penalty: each post above the threshold costs 0.5 importance points
  return -0.5 * (catCount - CATEGORY_MAX + 1);
}

/**
 * Audit a single item.
 * @param {object} item       — the queue item to audit
 * @param {object[]} recentPosts — last N published posts (for bias check)
 * @returns {{ verdict: 'pass'|'warn'|'fail', penalty: number, flags: object[], summary: string }}
 */
function auditItem(item, recentPosts = []) {
  const allFlags = [
    ...checkInjection(item),
    ...checkSchema(item),
    ...checkConfabulation(item),
    ...checkHallucinationAndBias(item, recentPosts),
  ];

  const score = allFlags.reduce((acc, f) => acc + (SEVERITY_WEIGHT[f.severity] || 0), 0);
  const hasCritical = allFlags.some(f => f.severity === 'critical');
  const errorCount  = allFlags.filter(f => f.severity === 'error').length;
  const warnCount   = allFlags.filter(f => f.severity === 'warn').length;

  let verdict;
  if (hasCritical || errorCount >= 2 || score >= FAIL_THRESHOLD) {
    verdict = 'fail';
  } else if (errorCount >= 1 || warnCount >= WARN_THRESHOLD || score >= WARN_THRESHOLD) {
    verdict = 'warn';
  } else {
    verdict = 'pass';
  }

  const penalty = diversityPenalty(item, recentPosts);

  const layers = [...new Set(allFlags.map(f => f.layer))];
  const summary = verdict === 'pass' && allFlags.length === 0
    ? 'All checks passed.'
    : `${verdict.toUpperCase()} — ${allFlags.length} flag(s) across [${layers.join(', ')}]. ` +
      `Score: ${score}. Penalty: ${penalty}.`;

  return { verdict, penalty, score, flags: allFlags, summary };
}

/**
 * Audit a batch of items.
 * Returns the batch with audit results attached, and a filtered list.
 */
function auditBatch(items, recentPosts = []) {
  const results = items.map(item => {
    const audit = auditItem(item, recentPosts);
    return { item, ...audit };
  });

  const passed  = results.filter(r => r.verdict !== 'fail');
  const failed  = results.filter(r => r.verdict === 'fail');
  const warned  = results.filter(r => r.verdict === 'warn');

  return { results, passed, failed, warned };
}

// ─── Sanitise scraped content (call before feeding to LLM) ───────────────────

/**
 * Strip prompt-injection markers from a string.
 * Use this on raw scraped titles/descriptions before they enter the agent prompt.
 */
function sanitize(text) {
  if (typeof text !== 'string') return text;
  let out = text;
  for (const pat of INJECTION_PATTERNS) {
    out = out.replace(pat, '[REDACTED]');
  }
  // Remove zero-width chars and RTL override marks sometimes used in injections
  out = out.replace(/[\u200B-\u200F\u202A-\u202E\uFEFF]/g, '');
  return out;
}

/**
 * Sanitize all text fields of a trending item (output of trending.js).
 * Safe to call on every item before passing to the hunt agent.
 */
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
  const args    = process.argv.slice(2);
  const fix     = args.includes('--fix');
  const report  = args.includes('--report');
  const file    = args.find(a => !a.startsWith('--')) || path.join(__dirname, 'queue.json');
  const postsFile = path.join(__dirname, 'posts.json');

  let items, recentPosts;
  try {
    items       = JSON.parse(fs.readFileSync(file, 'utf8'));
    recentPosts = JSON.parse(fs.readFileSync(postsFile, 'utf8'));
  } catch (e) {
    console.error('Error reading files:', e.message);
    process.exit(1);
  }

  const { results, passed, failed, warned } = auditBatch(items, recentPosts);

  console.log(`\n── Guard Audit: ${file} ──`);
  console.log(`  Total:  ${items.length}`);
  console.log(`  Pass:   ${passed.filter(r => r.verdict === 'pass').length}`);
  console.log(`  Warn:   ${warned.length}`);
  console.log(`  Fail:   ${failed.length}\n`);

  for (const r of results) {
    const icon = r.verdict === 'pass' ? '✓' : r.verdict === 'warn' ? '⚠' : '✗';
    console.log(`${icon} [${r.verdict.toUpperCase()}] ${r.item.id || r.item.title?.slice(0, 60)}`);
    if (report || r.verdict !== 'pass') {
      console.log(`   ${r.summary}`);
      if (report) {
        for (const f of r.flags) {
          console.log(`   [${f.layer}/${f.severity}] ${f.msg || f.pattern || ''}`);
        }
      }
    }
  }

  if (fix && failed.length > 0) {
    const kept = passed.map(r => r.item);
    fs.writeFileSync(file, JSON.stringify(kept, null, 2) + '\n');
    console.log(`\n--fix: removed ${failed.length} failed item(s) from ${file}`);
  }

  process.exit(failed.length > 0 ? 1 : 0);
}

module.exports = { auditItem, auditBatch, sanitize, sanitizeTrendingItem };
