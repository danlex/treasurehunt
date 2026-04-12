#!/usr/bin/env node
// Hacker News helper — HN Algolia API (free, no auth).
// Docs: https://hn.algolia.com/api
//
// CLI:
//   node hnCheck.js top            — top stories right now
//   node hnCheck.js search "gpt"   — recent stories matching keyword
//   node hnCheck.js item 39999999  — one item

const ALGOLIA = 'https://hn.algolia.com/api/v1';

async function top({ hours = 24, min_points = 100, limit = 30 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const url = new URL(`${ALGOLIA}/search`);
  url.searchParams.set('tags', 'story');
  url.searchParams.set('numericFilters', `created_at_i>${now - hours * 3600},points>${min_points}`);
  url.searchParams.set('hitsPerPage', String(limit));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`hn ${res.status}`);
  const j = await res.json();
  return (j.hits || []).map(simplify);
}

async function search(query, { hours = 72, limit = 20 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const url = new URL(`${ALGOLIA}/search_by_date`);
  url.searchParams.set('query', query);
  url.searchParams.set('tags', 'story');
  url.searchParams.set('numericFilters', `created_at_i>${now - hours * 3600}`);
  url.searchParams.set('hitsPerPage', String(limit));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`hn ${res.status}`);
  const j = await res.json();
  return (j.hits || []).map(simplify);
}

async function item(id) {
  const res = await fetch(`${ALGOLIA}/items/${id}`);
  if (!res.ok) throw new Error(`hn ${res.status}`);
  return simplify(await res.json());
}

function simplify(h) {
  if (!h) return null;
  return {
    id: h.objectID || h.id,
    title: h.title,
    url: h.url,
    author: h.author,
    points: h.points ?? h.score ?? 0,
    comments: h.num_comments ?? 0,
    createdAt: h.created_at,
    hnUrl: `https://news.ycombinator.com/item?id=${h.objectID || h.id}`
  };
}

module.exports = { top, search, item };

if (require.main === module) {
  const [, , cmd, ...rest] = process.argv;
  (async () => {
    if (cmd === 'top')         console.log(JSON.stringify(await top(), null, 2));
    else if (cmd === 'search') console.log(JSON.stringify(await search(rest.join(' ')), null, 2));
    else if (cmd === 'item')   console.log(JSON.stringify(await item(rest[0]), null, 2));
    else {
      console.error('Usage: node hnCheck.js top | search "<query>" | item <id>');
      process.exit(2);
    }
  })().catch(e => { console.error(e.message); process.exit(1); });
}
