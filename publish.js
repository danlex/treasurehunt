#!/usr/bin/env node
// Publishes all items from queue.json to posts.json, best-first by score.
// Scoring combines importance + user taste signals from preferences.json.
// Runs guard.js on every item before publishing — FAIL items are moved to rejected.json.
// Exits with code 2 if queue is empty.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { auditBatch } = require('./guard');

const ROOT     = __dirname;
const QUEUE    = path.join(ROOT, 'queue.json');
const POSTS    = path.join(ROOT, 'posts.json');
const PREFS    = path.join(ROOT, 'preferences.json');
const REJECTED = path.join(ROOT, 'rejected.json');

const readJson  = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const writeJson = (p, d) => fs.writeFileSync(p, JSON.stringify(d, null, 2) + '\n');

const queue = readJson(QUEUE);
if (!queue.length) {
  console.error('Queue empty — nothing to publish.');
  process.exit(2);
}

// ── Guard: audit all queued items before publishing ───────────────────────────
const posts    = readJson(POSTS);
let   rejected_all = [];
try { rejected_all = readJson(REJECTED); } catch {}

const { results } = auditBatch(queue, { posts, rejected: rejected_all, batch: queue });

const guardPassed = [];
const guardFailed = [];

for (const r of results) {
  if (r.verdict === 'fail') {
    console.warn(`Guard FAIL: ${r.item.id || r.item.title?.slice(0, 60)}`);
    console.warn(`  ${r.summary}`);
    for (const f of r.flags.filter(x => x.severity === 'critical' || x.severity === 'error')) {
      console.warn(`  [${f.layer}/${f.severity}] ${f.msg || f.pattern || ''}`);
    }
    guardFailed.push({ ...r.item, guardAudit: { verdict: r.verdict, flags: r.flags } });
  } else {
    // Apply diversity penalty to score
    guardPassed.push({ item: r.item, penalty: r.penalty, guardVerdict: r.verdict, guardFlags: r.flags });
  }
}

// Move failed items to rejected.json
if (guardFailed.length > 0) {
  const rejected = readJson(REJECTED);
  const now      = new Date().toISOString();
  for (const item of guardFailed) {
    rejected.unshift({ ...item, rejectedAt: now, rejectedBy: 'guard' });
  }
  writeJson(REJECTED, rejected);
  console.log(`Guard: ${guardFailed.length} item(s) rejected. ${guardPassed.length} proceeding.`);
}

if (!guardPassed.length) {
  console.error('All items failed guard — nothing to publish.');
  writeJson(QUEUE, []);
  process.exit(2);
}

let prefs = { categories: {}, tags: {}, sources: {} };
try { prefs = readJson(PREFS); } catch {}

const bucketScore = (bucket, key) => {
  const b = (bucket || {})[key];
  return b ? (b.likes || 0) - (b.dislikes || 0) : 0;
};

function itemScore(item, idx, penalty = 0) {
  let s = item.metrics?.importance != null
    ? item.metrics.importance
    : (guardPassed.length - idx) * 0.5;
  if (item.metrics?.fudRisk) s -= item.metrics.fudRisk * 0.3;
  s += bucketScore(prefs.categories, item.category);
  (item.tags || []).forEach(t => { s += bucketScore(prefs.tags, t); });
  if (item.source) s += bucketScore(prefs.sources, item.source);
  s += penalty; // diversity penalty from guard (negative)
  return s;
}

const scored = guardPassed
  .map(({ item, penalty, guardVerdict, guardFlags }, idx) => ({
    item, score: itemScore(item, idx, penalty), guardVerdict, guardFlags,
  }))
  .sort((a, b) => b.score - a.score);

const now = new Date().toISOString();
for (const { item, score, guardVerdict, guardFlags } of scored) {
  const warnings = (guardFlags || []).filter(f => f.severity === 'warn');
  posts.unshift({
    ...item,
    publishedAt:  now,
    score:        Number(score.toFixed(2)),
    guardVerdict,
    ...(warnings.length > 0 ? { guardWarnings: warnings.map(f => f.msg) } : {}),
  });
  const badge = guardVerdict === 'warn' ? ' ⚠' : '';
  console.log(`Published: ${item.title} (score ${score.toFixed(2)})${badge}`);
}

writeJson(QUEUE, []);
writeJson(POSTS, posts);

execSync('node build.js', { cwd: ROOT, stdio: 'inherit' });
