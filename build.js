#!/usr/bin/env node
// Static-site generator for Treasure Hunt.
// Reads posts.json → writes:
//   index.html                 (server-rendered feed with full OG/JSON-LD/meta)
//   posts/<id>.html            (per-post article pages, each with NewsArticle schema)
//   sitemap.xml                (Google/Bing-friendly)
//   feed.xml                   (RSS 2.0)
//   robots.txt                 (allow all, point to sitemap)
//
// Call after every publish.js run so the feed stays in sync.

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const OUT_POSTS_DIR = path.join(ROOT, 'posts');

const SITE_URL = 'https://treasurehunt.alexandrudan.com';
const SITE_NAME = 'Treasure Hunt';
const SITE_TAGLINE = 'The best in AI, Quantum, Cybersecurity, Startups & Research.';
const SITE_DESC = 'Hand-curated daily digest of the best news in AI, Quantum computing, Cybersecurity, AI startups, Research papers and viral tech. One substantial post per hour — names, numbers and the specifics that matter.';
const SITE_KEYWORDS = 'AI news, artificial intelligence news, quantum computing news, cybersecurity news, AI startups, research papers, GPT-5, Gemini, LLM news, tech news daily';

const posts = JSON.parse(fs.readFileSync(path.join(ROOT, 'posts.json'), 'utf8'));

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const catClass = c => 'cat-' + String(c || '').replace(/[^A-Za-z]/g, '');
const truncate = (s, n) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length <= n ? t : t.slice(0, n - 1).replace(/\s+\S*$/, '') + '…'; };
const dateISO = iso => new Date(iso).toISOString();
const dateHuman = iso => new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
const dateRFC822 = iso => new Date(iso).toUTCString();

const postPath = id => `/posts/${id}.html`;
const postUrl  = id => SITE_URL + postPath(id);

// ─── Shared styles (inlined into every generated page) ──────────────────────────
const STYLES = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --red: #ff4a3d; --red-dark: #d63a2a; --red-light: #ff9a8f;
    --dark: #0f0f0f; --light-bg: #f7f6f4;
    --text: #111; --text-sec: #4a4a4a; --text-mute: #8a8a8a;
    --border: #ebebeb;
    --font-display: 'Space Grotesk', 'Segoe UI', sans-serif;
    --font-body: 'Manrope', 'Segoe UI', sans-serif;
  }
  html { scroll-behavior: smooth; }
  body { font-family: var(--font-body); color: var(--text); background: #fff; line-height: 1.6; }
  h1, h2, h3 { font-family: var(--font-display); letter-spacing: -0.01em; }
  a { color: var(--red); }
  a:hover { color: var(--red-dark); }

  nav {
    position: sticky; top: 0;
    height: 72px;
    background: #fff;
    border-bottom: 1px solid var(--border);
    display: flex; align-items: center; justify-content: space-between;
    padding: 0 40px;
    z-index: 100;
  }
  .nav-logo { display: flex; align-items: center; gap: 10px; text-decoration: none; }
  .nav-logo-text {
    font-family: var(--font-display); font-size: 15px; font-weight: 700;
    color: var(--red); letter-spacing: 2px; text-transform: uppercase;
  }
  .nav-links { display: flex; gap: 20px; align-items: center; }
  .nav-links a {
    color: var(--text-sec); text-decoration: none; font-size: 14px; font-weight: 500;
  }
  .nav-links a:hover { color: var(--red); }

  .container { max-width: 980px; margin: 0 auto; padding: 24px 40px; }
  .hero { padding: 56px 40px 16px; max-width: 980px; margin: 0 auto; }
  .red-label {
    display: inline-block; color: var(--red);
    font-size: 13px; font-weight: 600; letter-spacing: 1.5px; text-transform: uppercase;
    margin-bottom: 14px;
  }
  .hero h1 { font-size: clamp(32px, 5vw, 48px); font-weight: 700; line-height: 1.1; margin-bottom: 14px; }
  .hero h1 span { color: var(--red); }
  .hero p { font-size: 16px; color: var(--text-sec); font-weight: 300; max-width: 620px; }

  main { max-width: 980px; margin: 0 auto; padding: 24px 40px 80px; }

  /* Category color tag (no hero image) */
  .cat-tag {
    display: inline-block;
    padding: 4px 12px;
    border-radius: 4px;
    color: #fff;
    font-family: var(--font-display);
    font-size: 11px; font-weight: 700;
    letter-spacing: 2px;
    text-transform: uppercase;
    margin-bottom: 14px;
  }
  .cat-AI             { background: linear-gradient(135deg, #ff4a3d 0%, #ff9a8f 100%); }
  .cat-Quantum        { background: linear-gradient(135deg, #5b3eff 0%, #b78fff 100%); }
  .cat-Cybersecurity  { background: linear-gradient(135deg, #0f0f0f 0%, #4a4a4a 100%); color: #fff; }
  .cat-Startups       { background: linear-gradient(135deg, #10b981 0%, #6ee7b7 100%); }
  .cat-Research       { background: linear-gradient(135deg, #0ea5e9 0%, #7dd3fc 100%); }
  .cat-TopTweets      { background: linear-gradient(135deg, #f59e0b 0%, #fcd34d 100%); }
  .cat-Viral          { background: linear-gradient(135deg, #ec4899 0%, #f9a8d4 100%); }

  article.post {
    background: #fff;
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 28px 30px;
    margin-bottom: 20px;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  article.post:hover { border-color: #d4d4d4; box-shadow: 0 4px 18px rgba(0,0,0,0.05); }
  .post-meta {
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    font-size: 12px; color: var(--text-sec);
    margin-bottom: 8px;
  }
  .post-meta .dot { color: #ccc; }
  .post-meta time { font-weight: 500; }
  .post-meta .source {
    font-size: 11px; font-weight: 600; color: var(--text-sec);
    text-transform: uppercase; letter-spacing: 1px;
  }
  .post-title { font-family: var(--font-display); font-size: 24px; font-weight: 700; line-height: 1.25; margin-bottom: 12px; }
  .post-title a { color: var(--text); text-decoration: none; }
  .post-title a:hover { color: var(--red); }
  .post-summary { color: var(--text-sec); font-size: 15px; line-height: 1.7; margin-bottom: 18px; }
  .post-footer {
    display: flex; justify-content: space-between; align-items: center;
    flex-wrap: wrap; gap: 12px;
  }
  .tags { display: flex; gap: 6px; flex-wrap: wrap; }
  .tag {
    font-size: 11px; font-weight: 600; color: var(--text-sec);
    background: var(--light-bg); padding: 4px 10px; border-radius: 4px; letter-spacing: 0.3px;
  }
  .read-link { color: var(--red); font-weight: 600; font-size: 13px; text-decoration: none; }
  .read-link:hover { text-decoration: underline; }

  /* Per-post article page */
  .article-page .post-title { font-size: clamp(28px, 4vw, 42px); line-height: 1.15; margin-bottom: 18px; }
  .article-page .post-summary { font-size: 18px; line-height: 1.75; color: var(--text); margin-bottom: 26px; }
  .article-page .hero-image { width: 100%; max-height: 420px; object-fit: cover; border-radius: 12px; margin-bottom: 28px; border: 1px solid var(--border); }
  .article-page .cta {
    background: var(--dark); color: #fff; border-radius: 12px;
    padding: 26px 28px; margin: 32px 0;
    display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap;
  }
  .article-page .cta p { margin: 0; font-size: 15px; color: rgba(255,255,255,0.8); }
  .article-page .cta a {
    background: var(--red); color: #fff; padding: 12px 22px; border-radius: 6px;
    text-decoration: none; font-weight: 600; font-size: 14px;
  }
  .article-page .back { color: var(--text-sec); font-weight: 500; font-size: 13px; text-decoration: none; }
  .article-page .back:hover { color: var(--red); }
  .related h2 {
    font-size: 14px; font-weight: 700; text-transform: uppercase; letter-spacing: 2px;
    color: var(--text-sec); margin: 40px 0 16px;
  }

  footer {
    border-top: 1px solid var(--border);
    padding: 32px 40px;
    max-width: 980px; margin: 40px auto 0;
    display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 16px;
    color: var(--text-mute); font-size: 13px;
  }
  footer a { color: var(--text-sec); text-decoration: none; margin-left: 16px; }
  footer a:hover { color: var(--red); }

  @media (max-width: 640px) {
    nav { padding: 0 20px; }
    .hero, main, footer, .container { padding-left: 20px; padding-right: 20px; }
    article.post { padding: 22px 20px; }
  }
`;

// ─── Shared head block ─────────────────────────────────────────────────────────
function head(opts) {
  const image = opts.image || `${SITE_URL}/og-cover.svg`;
  const url = opts.canonical;
  const title = opts.title;
  const desc = opts.description;
  const keywords = opts.keywords || SITE_KEYWORDS;
  const ogType = opts.ogType || 'website';

  const jsonLd = opts.jsonLd
    ? (Array.isArray(opts.jsonLd) ? opts.jsonLd : [opts.jsonLd])
        .map(j => `<script type="application/ld+json">${JSON.stringify(j)}</script>`).join('\n')
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta name="keywords" content="${esc(keywords)}">
<meta name="author" content="${esc(SITE_NAME)}">
<meta name="theme-color" content="#ff4a3d">
<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1">
<link rel="canonical" href="${esc(url)}">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="apple-touch-icon" href="/favicon.svg">
<!-- Open Graph -->
<meta property="og:type" content="${esc(ogType)}">
<meta property="og:site_name" content="${esc(SITE_NAME)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:image:alt" content="${esc(opts.imageAlt || title)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="${opts.ogType === 'article' ? '600' : '630'}">
<meta property="og:locale" content="en_US">
${opts.publishedTime ? `<meta property="article:published_time" content="${esc(opts.publishedTime)}">` : ''}
${opts.section ? `<meta property="article:section" content="${esc(opts.section)}">` : ''}
${(opts.tagList || []).map(t => `<meta property="article:tag" content="${esc(t)}">`).join('\n')}
<!-- Twitter -->
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(image)}">
<meta name="twitter:image:alt" content="${esc(opts.imageAlt || title)}">
<!-- Feeds -->
<link rel="alternate" type="application/rss+xml" title="${esc(SITE_NAME)} RSS" href="${SITE_URL}/feed.xml">
<link rel="sitemap" type="application/xml" href="${SITE_URL}/sitemap.xml">
<!-- Fonts -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Manrope:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>${STYLES}</style>
${jsonLd}
</head>`;
}

// ─── Shared navbar ─────────────────────────────────────────────────────────────
const navbar = `
<nav>
  <a class="nav-logo" href="/">
    <svg width="28" height="28" viewBox="107 107 786 786" fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="Treasure Hunt logo">
      <rect width="32" height="32" rx="6" fill="#f7f6f4"/>
      <path d="M892.95 447.19L552.77 107.06V106.92H106.92V552.81L447.19 893.07H893.08L892.95 447.18V447.19ZM868.91 447.19H552.78V131.19L868.91 447.18V447.19ZM123.99 123.99H535.71V447.19H447.19V535.75H123.99V123.99ZM535.71 464.25V535.75H464.25V464.25H535.71ZM131.04 552.81H447.19V868.94L131.04 552.81ZM876.01 876.01H464.25V552.81H552.77V464.25H876.01V876.01Z" fill="#FF4931"/>
      <path d="M290.55 255.08V272.11H273.12V389.18H255.88V281.12L236.53 272.11V255.08H290.55Z" fill="#FF4931"/>
      <path d="M366.8 255.08L346.7 389.18H321.03L300.92 255.08H318.53L329.85 330.57L331.7 342.92H336.02L337.88 330.57L349.19 255.08H366.8Z" fill="#FF4931"/>
      <path d="M424.68 372.12V389.18H382.92V255.08H400.17V372.12H424.68Z" fill="#FF4931"/>
      <path d="M552.77 641.5L572.22 650.55V759.11H589.54V658.63V641.5H607.06V624.37H552.77V641.5Z" fill="#FF4931"/>
      <path d="M642.28 700.21H668.27V683.08H642.28L641.92 641.5H668.84V624.37H636.12H624.96V641.5V651.53V759.11H626.91H668.84H669.45V741.98H642.28V700.21Z" fill="#FF4931"/>
      <path d="M687.35 741.98V759.11H729.89V741.98H704.67V641.5H729.89V624.37H687.35V741.98Z" fill="#FF4931"/>
      <path d="M788.8 624.37V683.08H767.63V624.37H750.3V759.11H767.63V700.21H788.8V759.11H806.12V624.37H788.8Z" fill="#FF4931"/>
    </svg>
    <span class="nav-logo-text">Treasure Hunt</span>
  </a>
  <div class="nav-links">
    <a href="/feed.xml">RSS</a>
    <a href="https://github.com/danlex/treasurehunt" target="_blank" rel="noopener">GitHub ↗</a>
  </div>
</nav>
`;

const footer = `
<footer>
  <span>© ${new Date().getFullYear()} Treasure Hunt · curated for signal over noise</span>
  <nav>
    <a href="/">Home</a>
    <a href="/feed.xml">RSS</a>
    <a href="/sitemap.xml">Sitemap</a>
  </nav>
</footer>
`;

// ─── Card rendering (used on index) ────────────────────────────────────────────
function postCard(p) {
  return `
<article class="post" aria-labelledby="title-${esc(p.id)}">
  <span class="cat-tag ${catClass(p.category)}">${esc(p.category)}</span>
  <div class="post-meta">
    <time datetime="${dateISO(p.publishedAt)}">${dateHuman(p.publishedAt)}</time>
    <span class="dot">·</span>
    <span class="source">${esc(p.source || '')}</span>
  </div>
  <h2 class="post-title" id="title-${esc(p.id)}"><a href="${postPath(p.id)}">${esc(p.title)}</a></h2>
  <p class="post-summary">${esc(p.summary)}</p>
  <div class="post-footer">
    <div class="tags">${(p.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>
    <a class="read-link" href="${postPath(p.id)}">Read more →</a>
  </div>
</article>`;
}

// ─── index.html ────────────────────────────────────────────────────────────────
function buildIndex() {
  const titleTag = `${SITE_NAME} — ${SITE_TAGLINE}`;
  const jsonLd = [
    {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: SITE_NAME,
      url: SITE_URL + '/',
      description: SITE_DESC,
      potentialAction: {
        '@type': 'SearchAction',
        target: SITE_URL + '/?q={search_term_string}',
        'query-input': 'required name=search_term_string'
      }
    },
    {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name: SITE_NAME,
      url: SITE_URL + '/',
      logo: SITE_URL + '/favicon.svg'
    },
    {
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      name: 'Treasure Hunt — latest posts',
      itemListElement: posts.slice(0, 20).map((p, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        url: postUrl(p.id),
        name: p.title
      }))
    }
  ];

  const htmlHead = head({
    title: titleTag,
    description: SITE_DESC,
    canonical: SITE_URL + '/',
    jsonLd,
  });

  const body = `
<body>
${navbar}
<section class="hero">
  <span class="red-label">Updated hourly · curated daily</span>
  <h1>The <span>best</span> in AI, Quantum, Cybersecurity, Startups &amp; Research.</h1>
  <p>One substantial post per hour, packed with names, numbers and the specifics that matter. No filler, no SEO spam — just the highlights from each day's tech crawl, scored by signal.</p>
</section>
<main>
  ${posts.length ? posts.map(postCard).join('\n') : '<p>No posts yet — check back soon.</p>'}
</main>
${footer}
</body>
</html>`;

  fs.writeFileSync(path.join(ROOT, 'index.html'), htmlHead + body);
}

// ─── Per-post article pages ───────────────────────────────────────────────────
function buildPostPage(p, i) {
  const related = posts.filter(x => x.id !== p.id).slice(0, 3);
  const canonical = postUrl(p.id);
  const description = truncate(p.summary, 158);

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'NewsArticle',
    headline: p.title,
    description,
    url: canonical,
    mainEntityOfPage: { '@type': 'WebPage', '@id': canonical },
    image: p.image ? [p.image] : [SITE_URL + '/og-cover.svg'],
    datePublished: dateISO(p.publishedAt),
    dateModified: dateISO(p.publishedAt),
    articleSection: p.category,
    keywords: (p.tags || []).join(', '),
    author: { '@type': 'Organization', name: SITE_NAME, url: SITE_URL + '/' },
    publisher: {
      '@type': 'Organization',
      name: SITE_NAME,
      url: SITE_URL + '/',
      logo: { '@type': 'ImageObject', url: SITE_URL + '/favicon.svg' }
    },
    isBasedOn: p.url,
    citation: p.url
  };

  const breadcrumb = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: SITE_URL + '/' },
      { '@type': 'ListItem', position: 2, name: p.category, item: SITE_URL + '/#' + catClass(p.category) },
      { '@type': 'ListItem', position: 3, name: p.title, item: canonical }
    ]
  };

  const htmlHead = head({
    title: `${p.title} — ${SITE_NAME}`,
    description,
    canonical,
    image: p.image || undefined,
    imageAlt: p.title,
    ogType: 'article',
    publishedTime: dateISO(p.publishedAt),
    section: p.category,
    tagList: p.tags || [],
    keywords: [...(p.tags || []), p.category, p.source, 'AI news'].filter(Boolean).join(', '),
    jsonLd: [jsonLd, breadcrumb]
  });

  const body = `
<body class="article-page">
${navbar}
<main class="container">
  <article itemscope itemtype="https://schema.org/NewsArticle">
    <meta itemprop="datePublished" content="${dateISO(p.publishedAt)}">
    <meta itemprop="author" content="${esc(SITE_NAME)}">
    <a class="back" href="/">← Back to feed</a>
    <div style="margin: 18px 0 0;">
      <span class="cat-tag ${catClass(p.category)}" itemprop="articleSection">${esc(p.category)}</span>
    </div>
    <h1 class="post-title" itemprop="headline">${esc(p.title)}</h1>
    <div class="post-meta">
      <time datetime="${dateISO(p.publishedAt)}" itemprop="datePublished">${dateHuman(p.publishedAt)}</time>
      <span class="dot">·</span>
      <span class="source">${esc(p.source || '')}</span>
    </div>
    ${p.image ? `<img class="hero-image" src="${esc(p.image)}" alt="${esc(p.title)}" itemprop="image" loading="eager" width="1200" height="600">` : ''}
    <p class="post-summary" itemprop="description">${esc(p.summary)}</p>
    <div class="tags" itemprop="keywords" content="${esc((p.tags || []).join(', '))}">${(p.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>
    <aside class="cta">
      <p>Want the full story from the original source?</p>
      <a href="${esc(p.url)}" target="_blank" rel="noopener" itemprop="isBasedOn">Read on ${esc(p.source || 'source')} ↗</a>
    </aside>
  </article>
  ${related.length ? `
  <section class="related">
    <h2>Keep reading</h2>
    ${related.map(postCard).join('')}
  </section>` : ''}
</main>
${footer}
</body>
</html>`;

  const out = path.join(OUT_POSTS_DIR, `${p.id}.html`);
  fs.writeFileSync(out, htmlHead + body);
}

// ─── sitemap.xml ──────────────────────────────────────────────────────────────
function buildSitemap() {
  const urls = [
    { loc: SITE_URL + '/', changefreq: 'hourly', priority: '1.0', lastmod: posts[0] ? dateISO(posts[0].publishedAt) : new Date().toISOString() },
    ...posts.map(p => ({
      loc: postUrl(p.id),
      changefreq: 'weekly',
      priority: '0.8',
      lastmod: dateISO(p.publishedAt),
      image: p.image || null
    }))
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"
        xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
${urls.map(u => `  <url>
    <loc>${esc(u.loc)}</loc>
    <lastmod>${esc(u.lastmod)}</lastmod>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>${u.image ? `
    <image:image><image:loc>${esc(u.image)}</image:loc></image:image>` : ''}
  </url>`).join('\n')}
</urlset>
`;
  fs.writeFileSync(path.join(ROOT, 'sitemap.xml'), xml);
}

// ─── feed.xml (RSS 2.0) ───────────────────────────────────────────────────────
function buildRss() {
  const lastBuild = posts[0] ? dateRFC822(posts[0].publishedAt) : new Date().toUTCString();
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel>
  <title>${esc(SITE_NAME)}</title>
  <link>${SITE_URL}/</link>
  <atom:link href="${SITE_URL}/feed.xml" rel="self" type="application/rss+xml"/>
  <description>${esc(SITE_DESC)}</description>
  <language>en-us</language>
  <lastBuildDate>${lastBuild}</lastBuildDate>
  <generator>treasurehunt-build</generator>
  <image>
    <url>${SITE_URL}/favicon.svg</url>
    <title>${esc(SITE_NAME)}</title>
    <link>${SITE_URL}/</link>
  </image>
${posts.slice(0, 50).map(p => `  <item>
    <title>${esc(p.title)}</title>
    <link>${postUrl(p.id)}</link>
    <guid isPermaLink="true">${postUrl(p.id)}</guid>
    <pubDate>${dateRFC822(p.publishedAt)}</pubDate>
    <category>${esc(p.category)}</category>
    <source url="${esc(p.url)}">${esc(p.source || '')}</source>
    <description>${esc(p.summary)}</description>
  </item>`).join('\n')}
</channel>
</rss>
`;
  fs.writeFileSync(path.join(ROOT, 'feed.xml'), xml);
}

// ─── robots.txt ───────────────────────────────────────────────────────────────
function buildRobots() {
  const txt = `User-agent: *
Allow: /
Disallow: /api/
Disallow: /review.html
Disallow: /server.js

Sitemap: ${SITE_URL}/sitemap.xml
`;
  fs.writeFileSync(path.join(ROOT, 'robots.txt'), txt);
}

// ─── run ──────────────────────────────────────────────────────────────────────
if (!fs.existsSync(OUT_POSTS_DIR)) fs.mkdirSync(OUT_POSTS_DIR, { recursive: true });

// Clean stale per-post files (ids no longer in posts.json)
const validIds = new Set(posts.map(p => p.id));
for (const f of fs.readdirSync(OUT_POSTS_DIR)) {
  if (f.endsWith('.html') && !validIds.has(f.replace(/\.html$/, ''))) {
    fs.unlinkSync(path.join(OUT_POSTS_DIR, f));
  }
}

buildIndex();
posts.forEach(buildPostPage);
buildSitemap();
buildRss();
buildRobots();

console.log(`Built: index.html, ${posts.length} post pages, sitemap.xml, feed.xml, robots.txt`);
