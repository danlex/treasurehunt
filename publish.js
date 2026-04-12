#!/usr/bin/env node
// Picks the best item from queue.json and moves it to posts.json.
// Scoring combines my initial ranking (earlier = better) with user taste
// signals from preferences.json (likes +, dislikes −).
// Exits with code 2 if queue is empty.

const fs = require('fs');
const path = require('path');

const ROOT  = __dirname;
const QUEUE = path.join(ROOT, 'queue.json');
const POSTS = path.join(ROOT, 'posts.json');
const PREFS = path.join(ROOT, 'preferences.json');

const readJson  = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const writeJson = (p, d) => fs.writeFileSync(p, JSON.stringify(d, null, 2) + '\n');

const queue = readJson(QUEUE);
if (!queue.length) {
  console.error('Queue empty — nothing to publish.');
  process.exit(2);
}

let prefs = { categories: {}, tags: {}, sources: {} };
try { prefs = readJson(PREFS); } catch {}

const bucketScore = (bucket, key) => {
  const b = (bucket || {})[key];
  return b ? (b.likes || 0) - (b.dislikes || 0) : 0;
};

function itemScore(item, idx) {
  // Prior: my initial ranking — earlier items worth more
  let s = (queue.length - idx) * 0.5;
  // User taste signals
  s += bucketScore(prefs.categories, item.category);
  (item.tags || []).forEach(t => { s += bucketScore(prefs.tags, t); });
  if (item.source) s += bucketScore(prefs.sources, item.source);
  return s;
}

const scored = queue.map((item, idx) => ({ item, idx, score: itemScore(item, idx) }));
scored.sort((a, b) => b.score - a.score);
const pick = scored[0];
const rest = queue.filter((_, idx) => idx !== pick.idx);

const posts = readJson(POSTS);
posts.unshift({ ...pick.item, publishedAt: new Date().toISOString(), score: Number(pick.score.toFixed(2)) });

writeJson(QUEUE, rest);
writeJson(POSTS, posts);

console.log(`Published: ${pick.item.title} (score ${pick.score.toFixed(2)})`);
