// Long-form tweet composer for X Premium (≤900 chars). Human-sounding,
// no AI-slop templates, no "Why it matters ↓" labels, no emoji scaffolding.
//
// Shape — short and unlabeled, reads like a person wrote it:
//
//   {Hook — one crisp line}.
//
//   {Body — natural prose with stats woven in.
//    Line break between sentences when they deserve separate weight.}
//
//   {One-sentence takeaway — not labeled, not prefaced, just the thought}.
//
//   {url}
//
// No "The numbers:" header. No "Why it matters:" header. No "Translation:".
// No "TL;DR:". No marketing vocabulary. Stats are woven into sentences
// unless there are 4+ distinct ones, where a dash list is permitted.

const MAX_CHARS = 900;            // premium safety cap (API allows ~25k)
const URL_WEIGHT = 23;            // X collapses any URL to ~23 counted chars

function extractStatLines(text) {
  if (!text) return [];
  const lines = [];
  const seen = new Set();

  const patterns = [
    { re: /(\d+(?:\.\d+)?\s*%[\w\s/\-.'"]{0,70}?)(?=[.,;:—]|$)/gi },
    { re: /((?:\d+(?:\.\d+)?)\s*(?:x|×|times)[\w\s/\-.']{0,60}?)(?=[.,;:—]|$)/gi },
    { re: /(\$\s*\d+(?:\.\d+)?\s*(?:billion|million|thousand|B|M|K)?[\w\s/\-.']{0,60}?)(?=[.,;:—]|$)/gi },
    { re: /(\d+(?:[.,]\d+)?\s*(?:K|k|M|m)?\s*(?:stars|downloads|users|installs|commits|contributors|forks|releases|qubits|tokens|params?|parameters?)[\w\s/\-.']{0,50}?)(?=[.,;:—]|$)/gi },
  ];

  for (const { re } of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      const snippet = m[1].trim().replace(/\s+/g, ' ');
      const words = snippet.split(/\s+/);
      if (words.length < 2) continue;
      const leadNumber = snippet.match(/\$?\s*\d+(?:[.,]\d+)?\s*(?:%|x|×|K|M|B|billion|million|thousand|times)?/i);
      const key = leadNumber ? leadNumber[0].toLowerCase().replace(/\s+/g, '') : snippet.toLowerCase().slice(0, 30);
      if (!seen.has(key) && snippet.length >= 8 && snippet.length <= 110) {
        lines.push(snippet);
        seen.add(key);
      }
    }
  }
  return lines;
}

function extractActor(title) {
  const m = title.match(/^([A-Z][\w&.\-]*(?:\s[A-Z][\w&.\-]*)?)/);
  return m ? m[1].replace(/[.,:;]$/, '') : '';
}

function cleanHook(title) {
  // Strip everything after the em-dash/colon — leave the punchy front half.
  return String(title || '')
    .split(/[—–:]/)[0]
    .replace(/\s+/g, ' ')
    .trim();
}

// Take the first 1-2 sentences from whyItMatters.
function leadingSentences(text, n = 2) {
  return String(text || '')
    .split(/(?<=[.!?])\s+/)
    .slice(0, n)
    .join(' ')
    .trim();
}

function xCharCount(text) {
  return text.replace(/https?:\/\/\S+/g, 'x'.repeat(URL_WEIGHT)).length;
}

function cleanup(text) {
  return text
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

// Weave up to 3 stats into a natural prose sentence. "90.8%, 36.1%, 2×"
// feels punchy when comma-separated; 4+ stats switch to a dash list.
function weaveStatsInline(stats) {
  const s = stats.slice(0, 3);
  if (!s.length) return '';
  if (s.length === 1) return s[0];
  if (s.length === 2) return `${s[0]} and ${s[1]}`;
  return `${s[0]}, ${s[1]}, and ${s[2]}`;
}

// Strip marketing-speak and AI-slop tells from a string.
const SLOP_PATTERNS = [
  /\bgame[- ]changer\b/gi,
  /\brevolutionary\b/gi,
  /\bgroundbreaking\b/gi,
  /\bdisrupt(?:s|ed|ing|ive)?\b/gi,
  /\bcutting[- ]edge\b/gi,
  /\bworld[- ]class\b/gi,
  /\bstate[- ]of[- ]the[- ]art\b/gi,
  /\bunprecedented\b/gi,
  /\bparadigm shift\b/gi,
  /\bleverag(?:e|es|ing)\b/gi,
  /\bsynerg(?:y|ies|ize)\b/gi,
  /\bbleeding[- ]edge\b/gi,
];
function debloat(s) {
  if (!s) return s;
  let out = s;
  for (const re of SLOP_PATTERNS) out = out.replace(re, '');
  return out.replace(/\s{2,}/g, ' ').trim();
}

// Grab one short, concrete sentence we can use as a takeaway. Prefer
// whyItMatters since it contains the author's framing. Avoid predictive
// "Expect X within N days" patterns that read as AI slop.
function pickTakeaway(item) {
  const sents = String(item.whyItMatters || '')
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean);
  // Prefer a middle sentence — the opening is usually generic, the last is
  // often a prediction/CTA.
  const candidates = sents.filter(s => {
    if (/^expect\b/i.test(s)) return false;            // "Expect X..."
    if (/^translation\s*:/i.test(s)) return false;
    if (/^bottom line\b/i.test(s)) return false;
    if (s.length < 30 || s.length > 220) return false;
    return true;
  });
  return debloat(candidates[0] || sents[0] || '');
}

function composeTweet(item) {
  const title = item.title || '';
  const summary = item.summary || '';
  const hook = debloat(cleanHook(title));
  const stats = extractStatLines(`${title}. ${summary}`).slice(0, 4);
  const statsInline = weaveStatsInline(stats);
  const url = item.primarySource || item.url || '';

  // Context sentence — first sentence of summary, debloated.
  const firstSummary = debloat((summary.split(/(?<=[.!?])\s+/)[0] || '').trim());

  // Body: weave stats naturally into a sentence. 4+ stats → dash list.
  // No "The numbers:" label — just the stats, with a soft connective.
  let body;
  if (stats.length >= 4) {
    body = stats.map(s => `— ${s}`).join('\n');
  } else if (stats.length >= 2) {
    body = firstSummary
      ? `${firstSummary} ${statsInline}.`
      : `${statsInline}.`;
  } else if (stats.length === 1) {
    body = firstSummary || `${statsInline}.`;
  } else {
    body = firstSummary;
  }

  const takeaway = pickTakeaway(item);

  const sections = (parts) => parts.filter(p => p && p.trim()).join('\n\n');

  const full = sections([
    hook + '.',
    body,
    takeaway && takeaway !== body ? takeaway : '',
    url,
  ]);

  // Leaner variants — drop takeaway, then drop body detail.
  const lean = sections([
    hook + '.',
    stats.length >= 2 ? `${statsInline}.` : firstSummary,
    takeaway && takeaway !== firstSummary ? takeaway : '',
    url,
  ]);

  const tight = sections([
    hook + '.',
    stats.length ? `${statsInline}.` : firstSummary,
    url,
  ]);

  for (const v of [full, lean, tight]) {
    if (xCharCount(v) <= MAX_CHARS) return cleanup(v);
  }
  return cleanup(tight).slice(0, MAX_CHARS);
}

function intentUrl(text) {
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}`;
}

module.exports = { composeTweet, intentUrl, extractStatLines, xCharCount, MAX_CHARS };

if (require.main === module) {
  const fs = require('fs');
  const id = process.argv[2];
  if (!id) { console.error('usage: node tweet.js <item-id>'); process.exit(1); }
  const all = [
    ...JSON.parse(fs.readFileSync('posts.json', 'utf8')),
    ...(fs.existsSync('queue.json') ? JSON.parse(fs.readFileSync('queue.json', 'utf8')) : []),
  ];
  const item = all.find(x => x.id === id);
  if (!item) { console.error('no item:', id); process.exit(2); }
  const text = composeTweet(item);
  console.log(`--- tweet (${xCharCount(text)} chars counted by X) ---`);
  console.log(text);
  console.log(`\n--- intent url ---`);
  console.log(intentUrl(text));
}
