#!/usr/bin/env node
// arXiv helper — free public API, no auth, no deps.
// Docs: https://info.arxiv.org/help/api/user-manual.html
//
// CLI:
//   node arxivCheck.js search "mixture of experts scaling"
//   node arxivCheck.js get 2404.19756
//
// Programmatic:
//   const { search, get } = require('./arxivCheck');
//   await search('neurosymbolic reasoning', { max: 10 });
//   await get('2404.19756');

const API = 'http://export.arxiv.org/api/query';

function parseEntries(xml) {
  // Minimal regex-based parse — arXiv's Atom is small and well-formed.
  const entries = [];
  const blocks = xml.split(/<entry>/).slice(1);
  for (const raw of blocks) {
    const body = raw.split('</entry>')[0];
    const pick = (tag) => {
      const m = body.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      return m ? m[1].trim().replace(/\s+/g, ' ') : null;
    };
    const id = pick('id');
    const arxivId = id ? id.split('/abs/')[1] : null;
    const authors = [...body.matchAll(/<author>\s*<name>([^<]+)<\/name>\s*<\/author>/g)].map(m => m[1].trim());
    const categories = [...body.matchAll(/<category[^/]*term="([^"]+)"/g)].map(m => m[1]);
    const pdfMatch = body.match(/<link[^>]+title="pdf"[^>]+href="([^"]+)"/);
    entries.push({
      id: arxivId,
      title: pick('title'),
      summary: pick('summary'),
      authors,
      primaryCategory: categories[0] || null,
      categories,
      published: pick('published'),
      updated: pick('updated'),
      abstractUrl: id,
      pdfUrl: pdfMatch ? pdfMatch[1] : null
    });
  }
  return entries;
}

async function search(query, { max = 8, sortBy = 'submittedDate', sortOrder = 'descending' } = {}) {
  const url = new URL(API);
  url.searchParams.set('search_query', `all:${query}`);
  url.searchParams.set('start', '0');
  url.searchParams.set('max_results', String(max));
  url.searchParams.set('sortBy', sortBy);
  url.searchParams.set('sortOrder', sortOrder);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`arxiv ${res.status}`);
  return parseEntries(await res.text());
}

async function get(arxivId) {
  const url = new URL(API);
  url.searchParams.set('id_list', arxivId);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`arxiv ${res.status}`);
  const entries = parseEntries(await res.text());
  return entries[0] || null;
}

module.exports = { search, get };

if (require.main === module) {
  const [, , cmd, ...rest] = process.argv;
  (async () => {
    if (cmd === 'search') {
      const out = await search(rest.join(' '), { max: 8 });
      console.log(JSON.stringify(out, null, 2));
    } else if (cmd === 'get') {
      const out = await get(rest[0]);
      console.log(JSON.stringify(out, null, 2));
    } else {
      console.error('Usage: node arxivCheck.js search "<query>"  |  get <arxivId>');
      process.exit(2);
    }
  })().catch(e => { console.error(e.message); process.exit(1); });
}
