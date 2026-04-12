#!/usr/bin/env node
// Semantic Scholar helper — Google-Scholar-equivalent with a real free API.
// Gives citation counts, influential-citation counts, venue, and cross-references.
// Docs: https://api.semanticscholar.org/
// No key required for low-volume use. For higher limits, set SEMANTIC_SCHOLAR_API_KEY in .env.
//
// CLI:
//   node scholarCheck.js search "chain of thought prompting"
//   node scholarCheck.js cite 649def34f8be52c8b66281af98ae884c09aef38b
//   node scholarCheck.js arxiv 2201.11903
//
// Programmatic:
//   const { search, byPaperId, byArxivId } = require('./scholarCheck');

const fs = require('fs');
const path = require('path');

function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (!m) continue;
    const [, k, v = ''] = m;
    if (process.env[k] == null) process.env[k] = v.replace(/^['"]|['"]$/g, '');
  }
}
loadEnv();

const BASE = 'https://api.semanticscholar.org/graph/v1';
const FIELDS = [
  'paperId', 'title', 'abstract', 'year', 'venue',
  'authors.name', 'authors.hIndex',
  'citationCount', 'influentialCitationCount', 'referenceCount',
  'openAccessPdf', 'url', 'externalIds', 'publicationDate'
].join(',');

function headers() {
  const h = { 'User-Agent': 'treasurehunt/1.0' };
  if (process.env.SEMANTIC_SCHOLAR_API_KEY) h['x-api-key'] = process.env.SEMANTIC_SCHOLAR_API_KEY;
  return h;
}

async function hit(url) {
  const res = await fetch(url, { headers: headers() });
  if (res.status === 429) throw new Error('rate-limited (add SEMANTIC_SCHOLAR_API_KEY to .env for higher limits)');
  if (!res.ok) throw new Error(`scholar ${res.status}: ${await res.text()}`);
  return res.json();
}

async function search(query, { limit = 10, year = null } = {}) {
  const url = new URL(`${BASE}/paper/search`);
  url.searchParams.set('query', query);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('fields', FIELDS);
  if (year) url.searchParams.set('year', year);
  const json = await hit(url);
  return (json.data || []).map(simplify);
}

async function byPaperId(paperId) {
  const url = new URL(`${BASE}/paper/${paperId}`);
  url.searchParams.set('fields', FIELDS);
  return simplify(await hit(url));
}

async function byArxivId(arxivId) {
  const url = new URL(`${BASE}/paper/ARXIV:${arxivId}`);
  url.searchParams.set('fields', FIELDS);
  return simplify(await hit(url));
}

async function byDoi(doi) {
  const url = new URL(`${BASE}/paper/DOI:${doi}`);
  url.searchParams.set('fields', FIELDS);
  return simplify(await hit(url));
}

function simplify(p) {
  if (!p) return null;
  return {
    paperId: p.paperId,
    title: p.title,
    venue: p.venue || null,
    year: p.year,
    publicationDate: p.publicationDate,
    authors: (p.authors || []).map(a => ({ name: a.name, hIndex: a.hIndex })),
    citationCount: p.citationCount ?? 0,
    influentialCitationCount: p.influentialCitationCount ?? 0,
    referenceCount: p.referenceCount ?? 0,
    abstract: p.abstract ? p.abstract.slice(0, 500) : null,
    url: p.url,
    pdf: p.openAccessPdf?.url || null,
    externalIds: p.externalIds || {}
  };
}

// Quick heuristic: returns {authority, novelty} deltas to feed into the scorecard.
function scoreSignals(paper) {
  if (!paper) return { authority: 0, novelty: 0, reason: 'no paper data' };
  let auth = 0, nov = 0;
  const c = paper.citationCount || 0;
  const ic = paper.influentialCitationCount || 0;

  // Authority: citations + venue + author h-index
  if (c >= 500) auth += 3;
  else if (c >= 100) auth += 2;
  else if (c >= 25) auth += 1;
  if (ic >= 30) auth += 1;
  const topH = Math.max(0, ...(paper.authors || []).map(a => a.hIndex || 0));
  if (topH >= 40) auth += 1;

  // Novelty: recent + uncited-yet-attention OR many influential citations on recent paper
  const pubYear = paper.year || 0;
  const current = new Date().getUTCFullYear();
  if (pubYear === current) nov += 1;
  if (pubYear === current && ic >= 5) nov += 2;
  if (pubYear === current - 1 && ic >= 20) nov += 1;

  return {
    authority: auth,
    novelty: nov,
    reason: `citations=${c}, influential=${ic}, venue=${paper.venue || 'n/a'}, topH=${topH}`
  };
}

module.exports = { search, byPaperId, byArxivId, byDoi, scoreSignals };

if (require.main === module) {
  const [, , cmd, ...rest] = process.argv;
  (async () => {
    if (cmd === 'search') {
      const out = await search(rest.join(' '), { limit: 10 });
      console.log(JSON.stringify(out, null, 2));
    } else if (cmd === 'cite') {
      const out = await byPaperId(rest[0]);
      console.log(JSON.stringify(out, null, 2));
    } else if (cmd === 'arxiv') {
      const out = await byArxivId(rest[0]);
      console.log(JSON.stringify(out, null, 2));
    } else if (cmd === 'doi') {
      const out = await byDoi(rest[0]);
      console.log(JSON.stringify(out, null, 2));
    } else {
      console.error('Usage: node scholarCheck.js search "<q>" | cite <paperId> | arxiv <arxivId> | doi <doi>');
      process.exit(2);
    }
  })().catch(e => { console.error(e.message); process.exit(1); });
}
