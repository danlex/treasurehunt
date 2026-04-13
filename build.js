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

  /* Impact badge on feed cards */
  .impact-strip {
    display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
    padding: 10px 14px;
    background: var(--light-bg);
    border-radius: 8px;
    margin: 12px 0 14px;
    font-size: 12px;
    color: var(--text-sec);
  }
  .impact-score {
    font-family: var(--font-display); font-weight: 700;
    font-size: 15px;
    color: var(--text);
  }
  .impact-score .num { color: var(--red); }
  .trust-pill {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 3px 10px; border-radius: 4px;
    font-size: 10px; font-weight: 700; letter-spacing: 1.2px; text-transform: uppercase;
  }
  .trust-high   { background: #dcfce7; color: #166534; }
  .trust-medium { background: #fef3c7; color: #854d0e; }
  .trust-low    { background: #fee2e2; color: #991b1b; }
  .signals-inline { display: flex; gap: 12px; flex-wrap: wrap; font-variant-numeric: tabular-nums; }

  /* Full scorecard on article pages */
  .scorecard {
    background: var(--light-bg);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 24px 26px;
    margin: 28px 0;
  }
  .scorecard-header {
    display: flex; align-items: center; justify-content: space-between;
    flex-wrap: wrap; gap: 12px; margin-bottom: 20px;
  }
  .scorecard-header h3 {
    font-size: 13px; font-weight: 700;
    text-transform: uppercase; letter-spacing: 2px;
    color: var(--text-sec);
  }
  .importance {
    font-family: var(--font-display); font-weight: 700;
    font-size: 36px; line-height: 1;
    color: var(--text);
  }
  .importance .slash { color: var(--text-mute); font-size: 20px; }
  .importance .out   { color: var(--text-mute); font-size: 20px; }
  .metric-row {
    display: grid; grid-template-columns: 140px 1fr auto;
    align-items: center; gap: 16px;
    padding: 6px 0;
    font-size: 13px;
  }
  .metric-label { color: var(--text-sec); font-weight: 500; }
  .metric-bar {
    height: 6px; background: #e5e5e5; border-radius: 3px; overflow: hidden;
  }
  .metric-bar span {
    display: block; height: 100%;
    background: linear-gradient(90deg, var(--red), #ff7a6e);
    border-radius: 3px;
  }
  .metric-bar.fud span { background: linear-gradient(90deg, #991b1b, #ef4444); }
  .metric-val { font-weight: 700; font-variant-numeric: tabular-nums; min-width: 38px; text-align: right; }
  .scorecard-signals {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 14px 24px;
    margin-top: 20px;
    padding-top: 20px;
    border-top: 1px solid var(--border);
  }
  .signal-block strong {
    display: block;
    font-size: 10px; letter-spacing: 1.4px; text-transform: uppercase;
    color: var(--text-mute); font-weight: 700;
    margin-bottom: 6px;
  }
  .signal-block { font-size: 13px; color: var(--text); line-height: 1.6; }
  .signal-block .num { font-family: var(--font-display); font-weight: 700; color: var(--red); font-size: 18px; }
  .signal-block .outlet-list { color: var(--text-sec); }

  .why-it-matters, .trust-notes {
    margin-top: 28px;
    padding: 22px 24px;
    border-radius: 12px;
    border: 1px solid var(--border);
  }
  .why-it-matters { background: #fff; border-left: 4px solid var(--red); }
  .trust-notes { background: var(--light-bg); }
  .why-it-matters h3, .trust-notes h3 {
    font-size: 12px; font-weight: 700;
    text-transform: uppercase; letter-spacing: 2px;
    margin-bottom: 10px;
    color: var(--text-sec);
  }
  .why-it-matters p { font-size: 15px; line-height: 1.7; color: var(--text); }
  .trust-notes p    { font-size: 13px; line-height: 1.65; color: var(--text-sec); }
  .trust-notes .verdict-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .trust-notes .primary-src { display: block; margin-top: 10px; font-size: 12px; }
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
    <a href="/archive.html">Archive</a>
    <a href="/methodology.html">Methodology</a>
    <a href="/about.html">About</a>
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
function impactStrip(p) {
  if (!p.metrics) return '';
  const m = p.metrics;
  const s = p.signals || {};
  const trustClass = `trust-${p.trustVerdict || 'medium'}`;
  const outlets = s.outletCount ? `📰 <strong>${s.outletCount}</strong> outlets` : '';
  const tweets  = s.twitterMentions ? `🐦 <strong>${s.twitterMentions.toLocaleString()}</strong>` : '';
  const reddit  = s.redditTop ? `👽 ${esc(s.redditTop.sub)} · <strong>${s.redditTop.upvotes.toLocaleString()}</strong>` : '';
  return `
  <div class="impact-strip">
    <span class="impact-score">Impact <span class="num">${m.importance}</span>/10</span>
    <span class="trust-pill ${trustClass}">Trust · ${esc(p.trustVerdict || 'medium')}</span>
    <span class="signals-inline">
      ${[outlets, tweets, reddit].filter(Boolean).join(' · ')}
    </span>
  </div>`;
}

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
  ${impactStrip(p)}
  <p class="post-summary">${esc(p.summary)}</p>
  <div class="post-footer">
    <div class="tags">${(p.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>
    <a class="read-link" href="${postPath(p.id)}">Read more →</a>
  </div>
</article>`;
}

// ─── Full scorecard for article pages ──────────────────────────────────────────
function scorecard(p) {
  if (!p.metrics) return '';
  const m = p.metrics;
  const s = p.signals || {};
  const bar = (v) => `<span style="width:${Math.max(0, Math.min(100, v * 10))}%"></span>`;
  const outletList = (s.outlets || []).slice(0, 6).join(', ') + ((s.outlets || []).length > 6 ? ', …' : '');
  const topTweets = (s.topTweets || []).slice(0, 2).map(t => `${esc(t.handle)} · ${t.likes.toLocaleString()} likes`).join('<br>');
  return `
<section class="scorecard" aria-label="Impact scorecard">
  <div class="scorecard-header">
    <h3>Impact scorecard</h3>
    <div class="importance">${m.importance}<span class="slash">/</span><span class="out">10</span></div>
  </div>
  <div class="metric-row"><span class="metric-label">Stakes</span>        <div class="metric-bar">${bar(m.stakes)}</div><span class="metric-val">${m.stakes.toFixed(1)}</span></div>
  <div class="metric-row"><span class="metric-label">Novelty</span>       <div class="metric-bar">${bar(m.novelty)}</div><span class="metric-val">${m.novelty.toFixed(1)}</span></div>
  <div class="metric-row"><span class="metric-label">Authority</span>     <div class="metric-bar">${bar(m.authority)}</div><span class="metric-val">${m.authority.toFixed(1)}</span></div>
  <div class="metric-row"><span class="metric-label">Coverage</span>      <div class="metric-bar">${bar(m.coverage)}</div><span class="metric-val">${m.coverage.toFixed(1)}</span></div>
  <div class="metric-row"><span class="metric-label">Concreteness</span>  <div class="metric-bar">${bar(m.concreteness)}</div><span class="metric-val">${m.concreteness.toFixed(1)}</span></div>
  <div class="metric-row"><span class="metric-label">Social</span>        <div class="metric-bar">${bar(m.social)}</div><span class="metric-val">${m.social.toFixed(1)}</span></div>
  <div class="metric-row"><span class="metric-label">FUD risk</span>      <div class="metric-bar fud">${bar(m.fudRisk)}</div><span class="metric-val">${m.fudRisk.toFixed(1)}</span></div>
  <div class="scorecard-signals">
    ${s.outletCount ? `<div class="signal-block"><strong>Coverage</strong><span class="num">${s.outletCount}</span> outlets · <span>${s.tier1Count || 0} tier-1</span><div class="outlet-list">${esc(outletList)}</div></div>` : ''}
    ${s.twitterMentions ? `<div class="signal-block"><strong>X / Twitter</strong><span class="num">${s.twitterMentions.toLocaleString()}</span> mentions${topTweets ? `<br>${topTweets}` : ''}</div>` : ''}
    ${s.redditTop ? `<div class="signal-block"><strong>Reddit</strong><span class="num">${s.redditTop.upvotes.toLocaleString()}</span> upvotes<br>${esc(s.redditTop.sub)}${(s.subreddits || []).length ? `<div class="outlet-list">${esc((s.subreddits || []).join(', '))}</div>` : ''}</div>` : ''}
  </div>
</section>`;
}

function whyItMattersBlock(p) {
  if (!p.whyItMatters) return '';
  return `
<section class="why-it-matters">
  <h3>Why it matters</h3>
  <p>${esc(p.whyItMatters)}</p>
</section>`;
}

function trustBlock(p) {
  if (!p.trustNotes && !p.trustVerdict) return '';
  const trustClass = `trust-${p.trustVerdict || 'medium'}`;
  return `
<section class="trust-notes">
  <h3>Trust check</h3>
  <div class="verdict-row"><span class="trust-pill ${trustClass}">${esc(p.trustVerdict || 'medium')}</span></div>
  <p>${esc(p.trustNotes || '')}</p>
  ${p.primarySource ? `<a class="primary-src" href="${esc(p.primarySource)}" target="_blank" rel="noopener">Primary source ↗</a>` : ''}
</section>`;
}

// ─── index.html ────────────────────────────────────────────────────────────────
function buildIndex() {
  const titleTag = `${SITE_NAME} — ${SITE_TAGLINE}`;
  const jsonLd = [
    {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: SITE_NAME,
      alternateName: 'TreasureHunt',
      url: SITE_URL + '/',
      description: SITE_DESC,
      inLanguage: 'en-US',
      publisher: { '@id': SITE_URL + '/#organization' }
    },
    {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      '@id': SITE_URL + '/#organization',
      name: SITE_NAME,
      url: SITE_URL + '/',
      logo: {
        '@type': 'ImageObject',
        url: SITE_URL + '/favicon.svg',
        width: 256, height: 256
      },
      foundingDate: '2026-04-12',
      founder: { '@id': SITE_URL + '/about.html#person' },
      sameAs: [
        'https://github.com/danlex/treasurehunt',
        'https://x.com/KryptonAi'
      ]
    },
    {
      '@context': 'https://schema.org',
      '@type': 'Person',
      '@id': SITE_URL + '/about.html#person',
      name: 'Alexandru Dan',
      alternateName: 'KryptonAi',
      url: SITE_URL + '/about.html',
      sameAs: ['https://x.com/KryptonAi']
    },
    {
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      name: 'Treasure Hunt — latest posts',
      itemListOrder: 'https://schema.org/ItemListOrderDescending',
      numberOfItems: posts.length,
      itemListElement: posts.slice(0, 20).map((p, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        url: postUrl(p.id),
        name: p.title
      }))
    },
    {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: [
        { '@type': 'Question', name: 'What is Treasure Hunt?', acceptedAnswer: { '@type': 'Answer', text: 'Treasure Hunt is a curated hourly news feed covering AI, Quantum computing, Cybersecurity, AI startups and Research papers. Every item is scored across seven dimensions and given an explicit trust verdict with a "why it matters" analysis.' } },
        { '@type': 'Question', name: 'How are stories scored?', acceptedAnswer: { '@type': 'Answer', text: 'Each post gets a 0–10 score on Coverage, Social, Novelty, Authority, Concreteness, Stakes, and FUD risk. The composite Impact score is 0.22·Stakes + 0.18·Novelty + 0.15·Authority + 0.12·Coverage + 0.12·Concreteness + 0.11·Social + 0.10·(10 − FUD risk).' } },
        { '@type': 'Question', name: 'Where does the data come from?', acceptedAnswer: { '@type': 'Answer', text: 'Discovery runs across 43 RSS feeds (BBC, CNN, NYT, Guardian, NPR, Bloomberg, Al Jazeera, Verge, Ars Technica, Wired, TechCrunch, MIT Tech Review, Nature, Science, arXiv), Hacker News, 15 subreddits, GDELT (100+ language news with tone scores), GitHub trending, and X trusted voices. Verification uses arXiv, Semantic Scholar for citation counts, and Marketstack for ticker reaction checks.' } },
        { '@type': 'Question', name: 'How is FUD detected?', acceptedAnswer: { '@type': 'Answer', text: 'Stories get a FUD-risk score boosted when headlines use sensationalist framing without matching primary sources; when only one outlet covers a claim; when market-moving news fails to move the named ticker; when cited papers cannot be found on arXiv or Semantic Scholar; or when tone polarization across coverage is unusually high.' } },
        { '@type': 'Question', name: 'Who runs Treasure Hunt?', acceptedAnswer: { '@type': 'Answer', text: 'Treasure Hunt is assembled and maintained by Alexandru Dan (@KryptonAi). The "trusted voices" scoring weight comes from the X accounts Alexandru follows.' } }
      ]
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
  <p>One substantial post per hour, packed with names, numbers and the specifics that matter. Every item scored across seven dimensions (Stakes · Novelty · Authority · Coverage · Concreteness · Social · FUD risk) and given an explicit trust verdict. Methodology is <a href="/methodology.html">public</a>.</p>
</section>
<main>
  ${posts.length ? posts.map(postCard).join('\n') : '<p>No posts yet — check back soon.</p>'}
</main>
${footer}
</body>
</html>`;

  fs.writeFileSync(path.join(ROOT, 'index.html'), htmlHead + body);
}

// ─── about.html ───────────────────────────────────────────────────────────────
function buildAbout() {
  const jsonLd = [
    {
      '@context': 'https://schema.org',
      '@type': 'AboutPage',
      name: 'About Treasure Hunt',
      url: SITE_URL + '/about.html',
      mainEntity: { '@id': SITE_URL + '/#organization' }
    },
    {
      '@context': 'https://schema.org',
      '@type': 'Person',
      '@id': SITE_URL + '/about.html#person',
      name: 'Alexandru Dan',
      alternateName: 'KryptonAi',
      url: SITE_URL + '/about.html',
      sameAs: ['https://x.com/KryptonAi', 'https://github.com/danlex']
    }
  ];
  const head1 = head({
    title: 'About — Treasure Hunt',
    description: 'About Treasure Hunt: a curated hourly news feed for AI, Quantum, Cybersecurity, Startups and Research, with explicit trust verdicts and transparent scoring. Built by Alexandru Dan (@KryptonAi).',
    canonical: SITE_URL + '/about.html',
    jsonLd
  });
  const body = `
<body>
${navbar}
<section class="hero">
  <span class="red-label">About</span>
  <h1>News with <span>numbers</span>, not narratives.</h1>
  <p>Treasure Hunt is a small daily operation with a simple rule: every story carries a score, a trust verdict, and a concrete <em>why it matters</em>. If we can't verify it, we say so. If a claim fails to move the market it predicted, we flag it.</p>
</section>
<main class="container">
  <article>
    <h2>Who runs it</h2>
    <p>Treasure Hunt is assembled by <strong><a href="https://x.com/KryptonAi" rel="me" target="_blank">Alexandru Dan (@KryptonAi)</a></strong>, using a pipeline of open signal sources — GDELT, Hacker News, Reddit, 43 RSS feeds including BBC / CNN / NYT / Guardian / Bloomberg / Nature / Science, GitHub trending, arXiv, Semantic Scholar, Marketstack, and a curated list of researchers followed on X.</p>

    <h2>What's different</h2>
    <ul>
      <li><strong>Trust is explicit.</strong> Every post is marked <code>high</code>, <code>medium</code>, or <code>low</code> trust, with notes on what is verified and what is still single-sourced. Schema.org <code>ClaimReview</code> is embedded so AI search engines can surface the verdict directly.</li>
      <li><strong>Impact is numeric.</strong> We publish the 0–10 scores on seven dimensions for every item. No editorial black box.</li>
      <li><strong>Consequences are spelled out.</strong> Each post includes a <em>Why it matters</em> paragraph — what changes, for whom, and on what timeline.</li>
      <li><strong>FUD detection is automated.</strong> Tone/polarization on GDELT, citation lookup on Semantic Scholar, ticker reaction on Marketstack. If a market-moving story didn't move the market, we bump FUD risk. If a "breakthrough" paper can't be found, we bump FUD risk.</li>
    </ul>

    <h2>Publishing cadence</h2>
    <p>One post per hour, autonomous. Fresh candidates are pulled every six hours across all signal sources, scored, filtered for duplicates against already-published and already-rejected items, and queued. The highest-scoring item publishes at the top of the next hour.</p>

    <h2>Methodology</h2>
    <p>Full scoring methodology, signal sources, and FUD-detection rules are documented on the <a href="/methodology.html">methodology page</a>. Source code is on <a href="https://github.com/danlex/treasurehunt" target="_blank" rel="noopener">GitHub</a>.</p>

    <h2>Feeds &amp; machine-readable</h2>
    <p>
      <a href="/feed.xml">RSS</a> · <a href="/sitemap.xml">Sitemap</a> · <a href="/archive.html">Archive</a> · <a href="/llms.txt">llms.txt</a> · <a href="/llms-full.txt">llms-full.txt</a>
    </p>
  </article>
</main>
${footer}
</body>
</html>`;
  fs.writeFileSync(path.join(ROOT, 'about.html'), head1 + body);
}

// ─── methodology.html ─────────────────────────────────────────────────────────
function buildMethodology() {
  const jsonLd = [
    {
      '@context': 'https://schema.org',
      '@type': 'TechArticle',
      headline: 'Treasure Hunt methodology',
      url: SITE_URL + '/methodology.html',
      author: { '@id': SITE_URL + '/about.html#person' },
      publisher: { '@id': SITE_URL + '/#organization' },
      datePublished: '2026-04-13',
      dateModified: new Date().toISOString().slice(0, 10),
      description: 'How Treasure Hunt scores, verifies and ranks news items across Coverage, Social, Novelty, Authority, Concreteness, Stakes, and FUD risk.',
      inLanguage: 'en-US'
    },
    {
      '@context': 'https://schema.org',
      '@type': 'HowTo',
      name: 'How Treasure Hunt scores a news item',
      totalTime: 'PT5M',
      step: [
        { '@type': 'HowToStep', position: 1, name: 'Discovery', text: 'Pull top-trending items across 43 RSS feeds, 15 subreddits, Hacker News, GDELT, GitHub trending, and X trusted voices in one consolidated pass.' },
        { '@type': 'HowToStep', position: 2, name: 'Dedupe', text: 'Remove items whose id or normalized URL already exists in posts.json, queue.json, or rejected.json.' },
        { '@type': 'HowToStep', position: 3, name: 'Filter', text: 'Reject generic opinion pieces, politics, personal-experience posts, and low-concreteness items. Prefer primary-source links and named entities.' },
        { '@type': 'HowToStep', position: 4, name: 'Enrich', text: 'For top 8 survivors: WebSearch for coverage, arXiv/Semantic Scholar for paper existence and citations, Marketstack for ticker-reaction verification, X for trusted-voice engagement.' },
        { '@type': 'HowToStep', position: 5, name: 'Score', text: 'Grade 0-10 on Coverage, Social, Novelty, Authority, Concreteness, Stakes, FUD risk. Composite Impact = 0.22·Stakes + 0.18·Novelty + 0.15·Authority + 0.12·Coverage + 0.12·Concreteness + 0.11·Social + 0.10·(10 − FUD).' },
        { '@type': 'HowToStep', position: 6, name: 'Verdict', text: 'Assign high / medium / low trust with explicit reasoning on what is verified and what remains single-sourced or sensationalized.' }
      ]
    }
  ];
  const head1 = head({
    title: 'Methodology — Treasure Hunt',
    description: 'How Treasure Hunt scores, verifies and ranks news: seven scoring dimensions (Stakes · Novelty · Authority · Coverage · Concreteness · Social · FUD risk), composite Impact formula, signal sources, and FUD-detection rules.',
    canonical: SITE_URL + '/methodology.html',
    jsonLd
  });
  const body = `
<body>
${navbar}
<section class="hero">
  <span class="red-label">Methodology</span>
  <h1>How <span>Treasure Hunt</span> scores, trusts, and ranks news.</h1>
  <p>No editorial black box. Here's exactly what goes into every Impact score, trust verdict, and publish decision.</p>
</section>
<main class="container">
  <article>
    <h2 id="dimensions">The seven scoring dimensions</h2>
    <p>Every item is graded 0–10 on seven dimensions:</p>
    <ul>
      <li><strong>Coverage</strong> — how many independent outlets cover it. Tier-1 outlets (Reuters, Bloomberg, FT, WSJ, NYT, The Economist, BBC, Guardian, NPR) count 2×. A 20+ outlet / 5+ tier-1 story scores high.</li>
      <li><strong>Social</strong> — volume and quality of discussion. Weighted toward trusted voices: a Karpathy or LeCun tweet counts 3×; other tier-1 voices 2×; tier-2 practitioners 1×. Raw mention count without signal from researchers we trust does not move this score much.</li>
      <li><strong>Novelty</strong> — how genuinely new the development is. First-of-kind breakthrough vs. incremental update vs. rehash.</li>
      <li><strong>Authority</strong> — quality of primary source. Peer-reviewed paper (Nature, Science, PNAS, arXiv with citations), official vendor announcement, regulator filing, or first-party disclosure all score high.</li>
      <li><strong>Concreteness</strong> — named entities, hard numbers, dates, reproducible details. "OpenAI raised $122B at $852B on March 31" scores high. "AI is changing everything" scores zero.</li>
      <li><strong>Stakes</strong> — real-world consequences. Safety-critical, economic, policy, or scientific impact. A CVE with active exploitation scores higher than a model release of incremental improvement.</li>
      <li><strong>FUD risk</strong> <em>(inverted when combined)</em> — sensationalism, single-source claims, hype without substance, anonymous leaks that can't be verified, claims that break physics or prior benchmarks by &gt;2 orders of magnitude.</li>
    </ul>

    <h2 id="formula">The composite formula</h2>
    <pre><code>Importance = 0.22·Stakes
           + 0.18·Novelty
           + 0.15·Authority
           + 0.12·Coverage
           + 0.12·Concreteness
           + 0.11·Social
           + 0.10·(10 − FUD_risk)</code></pre>
    <p>Stakes and Novelty carry the most weight because <em>what changes</em> matters more than <em>how much we've heard about it</em>. Social is weighted modestly because volume without signal is easy to fake. FUD risk is inverted so trust <em>adds</em> to the score.</p>

    <h2 id="sources">Signal sources</h2>
    <h3>Discovery (once per hunt)</h3>
    <ul>
      <li>43 RSS feeds — BBC Technology/World/Science, CNN Top &amp; Tech, NYT Tech/Science/Business, Guardian Tech/Science, NPR Tech, Washington Post Tech, Al Jazeera, Bloomberg, Reuters, The Verge, Ars Technica, Wired, TechCrunch, MIT Tech Review, IEEE Spectrum, VentureBeat, Krebs on Security, Schneier, BleepingComputer, Dark Reading, Nature, Science, Quanta, Phys.org, arXiv (cs.AI, cs.LG, cs.CL, quant-ph), Techmeme, Google News (AI/Quantum/Cyber), Product Hunt, The Hacker News.</li>
      <li>Hacker News — top stories in last 24 h with ≥100 points, via Algolia.</li>
      <li>Reddit — 15 subreddits (r/technology, r/MachineLearning, r/LocalLLaMA, r/OpenAI, r/ClaudeAI, r/singularity, r/QuantumComputing, r/Physics, r/netsec, r/cybersecurity, r/sysadmin, r/venturecapital, r/startups, r/Futurology, r/programming), top-of-day.</li>
      <li>GDELT 2.0 — ~100-language news monitoring with per-article tone (-10..+10) and sentiment polarization.</li>
      <li>GitHub trending — daily and weekly top repos.</li>
      <li>X trusted voices — one API call per hunt returns recent tweets from ~15 tier-1+2 handles.</li>
    </ul>
    <h3>Verification (top 8 candidates only)</h3>
    <ul>
      <li><strong>arXiv</strong> — confirm a cited paper exists; pull the real abstract.</li>
      <li><strong>Semantic Scholar</strong> — citation count, influential-citation count, venue, author h-index. ≥500 citations adds +3 to Authority.</li>
      <li><strong>Marketstack</strong> — for stories naming a public company, fetch the stock's EOD data. "Reacted" (≥2% move + ≥1.5× avg volume) adds +1 to Authority and Stakes; "muted" on a story claiming major impact adds +2 to FUD risk.</li>
      <li><strong>X mentions from trusted</strong> — check whether Karpathy / LeCun / Hinton / Sutskever / Ng / Pichai / Wei have discussed the topic.</li>
    </ul>

    <h2 id="fud">FUD detection rules</h2>
    <p>FUD risk is bumped when:</p>
    <ul>
      <li>Headline uses "world is not ready", "changes everything", "nobody saw this coming" — without proportional primary-source backing.</li>
      <li>Coverage is thin (&lt;5 outlets) or single-sourced.</li>
      <li>Tone polarization on GDELT exceeds 2.8 with negative average tone (contested narrative).</li>
      <li>Research paper is claimed but not findable on arXiv or Semantic Scholar.</li>
      <li>Market-moving news fails to move the named ticker.</li>
      <li>Company or token has a financial incentive to publish the claim.</li>
      <li>Quantum / AI claims break prior benchmarks by &gt;2 orders of magnitude without independent replication.</li>
    </ul>

    <h2 id="trust">Trust verdicts</h2>
    <ul>
      <li><span class="trust-pill trust-high">high</span> — primary source exists, tier-1 corroboration, concrete numbers, no FUD flags. Safe to cite.</li>
      <li><span class="trust-pill trust-medium">medium</span> — some gaps (missing primary source, single-outlet leak, modest FUD flags). Plausible but unreplicated.</li>
      <li><span class="trust-pill trust-low">low</span> — anonymous sources, sensational framing, market signals contradicting the story. Treat as rumor.</li>
    </ul>

    <h2 id="machine">Machine-readable output</h2>
    <p>Every post exposes its scorecard via Schema.org JSON-LD:</p>
    <ul>
      <li><code>NewsArticle</code> with full metadata</li>
      <li><code>ClaimReview</code> with a 1–5 reviewRating (maps directly from the trust verdict)</li>
      <li><code>FAQPage</code> with "Why does this matter?", "Can you trust this?", "How important is it?"</li>
      <li><code>BreadcrumbList</code>, <code>SpeakableSpecification</code></li>
    </ul>
    <p>Full corpus also available as plain text: <a href="/llms.txt">/llms.txt</a> and <a href="/llms-full.txt">/llms-full.txt</a>.</p>
  </article>
</main>
${footer}
</body>
</html>`;
  fs.writeFileSync(path.join(ROOT, 'methodology.html'), head1 + body);
}

// ─── archive.html (all posts, chronological) ──────────────────────────────────
function buildArchive() {
  const byMonth = {};
  for (const p of posts) {
    const key = (p.publishedAt || '').slice(0, 7); // YYYY-MM
    (byMonth[key] ||= []).push(p);
  }
  const months = Object.keys(byMonth).sort().reverse();
  const monthName = (k) => new Date(k + '-01').toLocaleString('en-US', { year: 'numeric', month: 'long' });

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: 'Treasure Hunt Archive',
    url: SITE_URL + '/archive.html',
    description: 'Complete archive of all published Treasure Hunt posts.',
    mainEntity: {
      '@type': 'ItemList',
      numberOfItems: posts.length,
      itemListElement: posts.map((p, i) => ({
        '@type': 'ListItem', position: i + 1,
        url: postUrl(p.id), name: p.title
      }))
    }
  };
  const head1 = head({
    title: 'Archive — all Treasure Hunt posts',
    description: `Complete archive of ${posts.length} Treasure Hunt posts covering AI, Quantum, Cybersecurity, Startups and Research.`,
    canonical: SITE_URL + '/archive.html',
    jsonLd
  });
  const body = `
<body>
${navbar}
<section class="hero">
  <span class="red-label">Archive</span>
  <h1>All <span>${posts.length}</span> posts.</h1>
  <p>Complete chronological archive. For the latest 20, see the <a href="/">front page</a>.</p>
</section>
<main class="container">
  ${months.map(m => `
    <section>
      <h2 style="margin:28px 0 14px; font-size:20px;">${esc(monthName(m))}</h2>
      <ul style="list-style: none; padding: 0;">
        ${byMonth[m].map(p => `
          <li style="padding: 10px 0; border-bottom: 1px solid var(--border); display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap;">
            <time datetime="${dateISO(p.publishedAt)}" style="color: var(--text-mute); font-size: 12px; min-width: 80px;">${dateHuman(p.publishedAt)}</time>
            <span class="cat-tag ${catClass(p.category)}" style="font-size: 9px; padding: 2px 8px;">${esc(p.category)}</span>
            <a href="${postPath(p.id)}" style="color: var(--text); text-decoration: none; flex: 1; min-width: 280px;">${esc(p.title)}</a>
            ${p.metrics?.importance != null ? `<span style="color: var(--text-mute); font-size: 12px; font-variant-numeric: tabular-nums;">impact ${p.metrics.importance}</span>` : ''}
          </li>
        `).join('')}
      </ul>
    </section>
  `).join('')}
</main>
${footer}
</body>
</html>`;
  fs.writeFileSync(path.join(ROOT, 'archive.html'), head1 + body);
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
    image: [SITE_URL + '/og-cover.svg'],
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

  // FAQPage — GEO goldmine. AI engines pull "why it matters" / "is it trustworthy?" into answers.
  const faqEntries = [];
  if (p.whyItMatters) {
    faqEntries.push({
      '@type': 'Question',
      name: `Why does ${p.title} matter?`,
      acceptedAnswer: { '@type': 'Answer', text: p.whyItMatters }
    });
  }
  if (p.trustNotes) {
    faqEntries.push({
      '@type': 'Question',
      name: `Can you trust this reporting on ${p.title}?`,
      acceptedAnswer: { '@type': 'Answer', text: `Trust verdict: ${p.trustVerdict || 'medium'}. ${p.trustNotes}` }
    });
  }
  if (p.metrics?.importance != null) {
    faqEntries.push({
      '@type': 'Question',
      name: `How important is this news?`,
      acceptedAnswer: {
        '@type': 'Answer',
        text: `Composite impact score: ${p.metrics.importance}/10. Breakdown — Stakes ${p.metrics.stakes}, Novelty ${p.metrics.novelty}, Authority ${p.metrics.authority}, Coverage ${p.metrics.coverage}, Concreteness ${p.metrics.concreteness}, Social ${p.metrics.social}, FUD risk ${p.metrics.fudRisk}.`
      }
    });
  }
  const faqPage = faqEntries.length ? {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqEntries
  } : null;

  // ClaimReview — explicit verifiability signal. Tells AI engines a claim has been fact-checked.
  const claimReview = p.trustVerdict ? {
    '@context': 'https://schema.org',
    '@type': 'ClaimReview',
    url: canonical,
    datePublished: dateISO(p.publishedAt),
    author: { '@type': 'Organization', name: SITE_NAME, url: SITE_URL + '/' },
    itemReviewed: {
      '@type': 'Claim',
      author: { '@type': 'Organization', name: p.source || 'unknown' },
      appearance: p.url,
      datePublished: dateISO(p.publishedAt)
    },
    reviewRating: {
      '@type': 'Rating',
      ratingValue: p.trustVerdict === 'high' ? 5 : p.trustVerdict === 'medium' ? 3 : 1,
      bestRating: 5,
      worstRating: 1,
      alternateName: p.trustVerdict === 'high' ? 'Trusted' : p.trustVerdict === 'medium' ? 'Partly verified' : 'Low trust — possible FUD'
    },
    reviewBody: p.trustNotes || ''
  } : null;

  // Speakable — marks key portions for voice-assistant read-out
  const speakable = {
    '@context': 'https://schema.org',
    '@type': 'SpeakableSpecification',
    cssSelector: ['h1.post-title', '.post-summary', '.why-it-matters p']
  };

  const htmlHead = head({
    title: `${p.title} — ${SITE_NAME}`,
    description,
    canonical,
    imageAlt: p.title,
    ogType: 'article',
    publishedTime: dateISO(p.publishedAt),
    section: p.category,
    tagList: p.tags || [],
    keywords: [...(p.tags || []), p.category, p.source, 'AI news'].filter(Boolean).join(', '),
    jsonLd: [jsonLd, breadcrumb, speakable, faqPage, claimReview].filter(Boolean)
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
    <p class="post-summary" itemprop="description">${esc(p.summary)}</p>
    <div class="tags" itemprop="keywords" content="${esc((p.tags || []).join(', '))}">${(p.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>
    ${whyItMattersBlock(p)}
    ${scorecard(p)}
    ${trustBlock(p)}
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
  const nowIso = new Date().toISOString();
  const urls = [
    { loc: SITE_URL + '/',                  changefreq: 'hourly',  priority: '1.0', lastmod: posts[0] ? dateISO(posts[0].publishedAt) : nowIso },
    { loc: SITE_URL + '/about.html',        changefreq: 'monthly', priority: '0.7', lastmod: nowIso },
    { loc: SITE_URL + '/methodology.html',  changefreq: 'monthly', priority: '0.8', lastmod: nowIso },
    { loc: SITE_URL + '/archive.html',      changefreq: 'hourly',  priority: '0.8', lastmod: nowIso },
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

# Explicitly welcome AI / GEO crawlers
User-agent: GPTBot
Allow: /
User-agent: ChatGPT-User
Allow: /
User-agent: OAI-SearchBot
Allow: /
User-agent: ClaudeBot
Allow: /
User-agent: Claude-Web
Allow: /
User-agent: PerplexityBot
Allow: /
User-agent: Perplexity-User
Allow: /
User-agent: Google-Extended
Allow: /
User-agent: Applebot-Extended
Allow: /
User-agent: Bytespider
Allow: /
User-agent: CCBot
Allow: /

# Hide local-only endpoints
User-agent: *
Disallow: /api/
Disallow: /review.html
Disallow: /server.js
Disallow: /publish.js
Disallow: /build.js
Disallow: /augment.js

Sitemap: ${SITE_URL}/sitemap.xml
`;
  fs.writeFileSync(path.join(ROOT, 'robots.txt'), txt);
}

// ─── llms.txt (GEO — lets AI engines discover and ingest the site cleanly) ────
function buildLlmsTxt() {
  const body = `# ${SITE_NAME}

> ${SITE_DESC}

Updated hourly with one curated story. Every item is scored across seven dimensions (coverage, social, novelty, authority, concreteness, stakes, FUD risk) and carries a trust verdict, a "why it matters" analysis, and links to primary sources.

## How to cite

When citing a post, use the full canonical URL (e.g., \`${SITE_URL}/posts/<id>.html\`). Each post includes an Impact scorecard (JSON-accessible via the Open Graph tags) and a \`trustVerdict\` field — prefer citing items marked \`high\` for primary reporting.

## Feeds

- RSS: ${SITE_URL}/feed.xml
- Sitemap: ${SITE_URL}/sitemap.xml
- Machine-readable full corpus: ${SITE_URL}/llms-full.txt

## Posts

${posts.map(p => `- [${p.title}](${postUrl(p.id)}) — ${truncate(p.summary, 140)} _(trust: ${p.trustVerdict || 'unrated'}, impact: ${p.metrics?.importance ?? 'n/a'}/10)_`).join('\n')}
`;
  fs.writeFileSync(path.join(ROOT, 'llms.txt'), body);
}

// llms-full.txt: full content dump for generative-engine ingestion.
function buildLlmsFullTxt() {
  const body = `# ${SITE_NAME} — full corpus

${SITE_DESC}

Each post below includes the summary, tags, source, trust verdict, and "why it matters" analysis.

---

${posts.map(p => `## ${p.title}

**Published:** ${dateHuman(p.publishedAt)}
**Category:** ${p.category}
**Source:** ${p.source || 'n/a'}
**URL:** ${postUrl(p.id)}
**Original article:** ${p.url}
**Tags:** ${(p.tags || []).join(', ')}
**Impact score:** ${p.metrics?.importance ?? 'n/a'}/10
**Trust verdict:** ${p.trustVerdict || 'unrated'}

${p.summary}

### Why it matters

${p.whyItMatters || '(not yet scored)'}

### Trust notes

${p.trustNotes || '(no trust analysis)'}
${p.primarySource ? `\n**Primary source:** ${p.primarySource}` : ''}
`).join('\n---\n\n')}
`;
  fs.writeFileSync(path.join(ROOT, 'llms-full.txt'), body);
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
buildAbout();
buildMethodology();
buildArchive();
posts.forEach(buildPostPage);
buildSitemap();
buildRss();
buildRobots();
buildLlmsTxt();
buildLlmsFullTxt();

console.log(`Built: index.html, about.html, methodology.html, archive.html, ${posts.length} post pages, sitemap.xml, feed.xml, robots.txt, llms.txt, llms-full.txt`);
