#!/usr/bin/env node
// Reddit helper — public JSON API, no auth, free. Rate-limited, so send a
// descriptive User-Agent and cache results.
//
// CLI:
//   node redditCheck.js hot r/MachineLearning
//   node redditCheck.js search "GPT-5.4"  r/MachineLearning,r/OpenAI
//   node redditCheck.js top  r/technology  day

const UA = { 'User-Agent': 'treasurehunt/1.0 (github.com/danlex/treasurehunt)' };

async function hot(sub, { limit = 25 } = {}) {
  const name = sub.replace(/^r\//, '');
  const res = await fetch(`https://www.reddit.com/r/${name}/hot.json?limit=${limit}`, { headers: UA });
  if (!res.ok) throw new Error(`reddit ${res.status}`);
  const j = await res.json();
  return (j.data?.children || []).map(c => simplify(c.data));
}

async function topOf(sub, { timeframe = 'day', limit = 25 } = {}) {
  const name = sub.replace(/^r\//, '');
  const url = `https://www.reddit.com/r/${name}/top.json?t=${timeframe}&limit=${limit}`;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`reddit ${res.status}`);
  const j = await res.json();
  return (j.data?.children || []).map(c => simplify(c.data));
}

// Search across one or many subs. `subs` may be a comma-separated string.
async function search(query, subs = '', { limit = 25, sort = 'relevance', timeframe = 'week' } = {}) {
  const url = new URL('https://www.reddit.com/search.json');
  url.searchParams.set('q', subs ? `${query} subreddit:${subs.replace(/r\//g, '')}` : query);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('sort', sort);
  url.searchParams.set('t', timeframe);
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`reddit ${res.status}`);
  const j = await res.json();
  return (j.data?.children || []).map(c => simplify(c.data));
}

function simplify(p) {
  if (!p) return null;
  return {
    id: p.id,
    sub: 'r/' + p.subreddit,
    title: p.title,
    author: p.author,
    ups: p.ups ?? 0,
    comments: p.num_comments ?? 0,
    ratio: p.upvote_ratio ?? null,
    url: p.url_overridden_by_dest || `https://www.reddit.com${p.permalink}`,
    permalink: `https://www.reddit.com${p.permalink}`,
    createdUtc: p.created_utc,
    flair: p.link_flair_text || null
  };
}

module.exports = { hot, topOf, search };

if (require.main === module) {
  const [, , cmd, ...rest] = process.argv;
  (async () => {
    if (cmd === 'hot')         console.log(JSON.stringify(await hot(rest[0]), null, 2));
    else if (cmd === 'top')    console.log(JSON.stringify(await topOf(rest[0], { timeframe: rest[1] || 'day' }), null, 2));
    else if (cmd === 'search') console.log(JSON.stringify(await search(rest[0], rest[1] || ''), null, 2));
    else {
      console.error('Usage: node redditCheck.js hot <r/sub> | top <r/sub> [timeframe] | search "<q>" [subs]');
      process.exit(2);
    }
  })().catch(e => { console.error(e.message); process.exit(1); });
}
