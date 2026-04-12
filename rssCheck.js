#!/usr/bin/env node
// Generic RSS/Atom fetcher — no deps, regex-based parse sufficient for the
// aggregators we care about.
//
// CLI:
//   node rssCheck.js https://www.techmeme.com/feed.xml 10

async function fetchRss(url, limit = 15) {
  const res = await fetch(url, { headers: { 'User-Agent': 'treasurehunt/1.0' } });
  if (!res.ok) throw new Error(`rss ${res.status}: ${url}`);
  const xml = await res.text();
  return parseItems(xml, limit);
}

function parseItems(xml, limit) {
  // Handle both RSS <item> and Atom <entry>
  const tag = xml.includes('<item>') ? 'item' : 'entry';
  const blocks = xml.split(new RegExp(`<${tag}[^>]*>`)).slice(1, limit + 1);
  return blocks.map(raw => {
    const body = raw.split(new RegExp(`</${tag}>`))[0];
    const pick = (t) => {
      const m = body.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`));
      if (!m) return null;
      return m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim().replace(/\s+/g, ' ');
    };
    const linkMatch = body.match(/<link[^>]*href="([^"]+)"/) || body.match(/<link>([^<]+)<\/link>/);
    return {
      title: pick('title'),
      link: linkMatch ? linkMatch[1].trim() : null,
      published: pick('pubDate') || pick('published') || pick('updated') || pick('dc:date'),
      description: (pick('description') || pick('summary') || '').replace(/<[^>]+>/g, '').slice(0, 400),
      author: pick('author') || pick('dc:creator') || null
    };
  }).filter(i => i.title);
}

module.exports = { fetchRss };

if (require.main === module) {
  const [, , url, limit = 15] = process.argv;
  if (!url) { console.error('Usage: node rssCheck.js <url> [limit]'); process.exit(2); }
  fetchRss(url, Number(limit)).then(r => console.log(JSON.stringify(r, null, 2)))
    .catch(e => { console.error(e.message); process.exit(1); });
}
