# Treasure Hunt

> **One curated post per hour**, drawn from the best news in AI, Quantum computing, Cybersecurity, AI startups, Research papers and viral tech. Every post is scored across seven dimensions — Coverage, Social, Novelty, Authority, Concreteness, Stakes, FUD risk — with an explicit trust verdict and a *why it matters* analysis.

**Live site:** [treasurehunt.alexandrudan.com](https://treasurehunt.alexandrudan.com) · **Feed:** [RSS](https://treasurehunt.alexandrudan.com/feed.xml) · **Machine-readable:** [llms.txt](https://treasurehunt.alexandrudan.com/llms.txt), [llms-full.txt](https://treasurehunt.alexandrudan.com/llms-full.txt)

---

## What is this?

A news aggregator that does three things most aggregators don't:

1. **Scores each story.** No flat timestamped list. Every item carries a composite 0–10 **Impact score** (weighted blend of Stakes, Novelty, Authority, Coverage, Concreteness, Social, plus a FUD-risk penalty) so you can see at a glance what actually matters.
2. **Trust-checks every claim.** Each post gets a `high` / `medium` / `low` **Trust verdict** with explicit notes on what's verified and what's still single-sourced or sensationalized. Schema.org `ClaimReview` is embedded so AI search engines can surface the verdict directly.
3. **Explains the consequences.** Every post has a dedicated *Why it matters* paragraph — what changes for whom, and on what timeline. Not filler, not hype.

## How does the scoring work?

The composite **Impact** is:

```
Importance = 0.22·Stakes + 0.18·Novelty + 0.15·Authority + 0.12·Coverage
           + 0.12·Concreteness + 0.11·Social + 0.10·(10 − FUD_risk)
```

Each dimension is 0–10. FUD risk is inverted because we want trust to *boost* the score.

| Dimension | What it measures | High score |
|-----------|------------------|------------|
| **Coverage** | Independent outlets covering the story | 20+ outlets, 5+ tier-1 |
| **Social** | Volume and quality of discussion | Trusted voices engaged, not just raw mention count |
| **Novelty** | How new/unique the development is | First-of-kind vs. incremental |
| **Authority** | Quality of primary source | Peer-reviewed paper, regulator, official vendor |
| **Concreteness** | Named entities, hard numbers, reproducible details | Specific over vague |
| **Stakes** | Real-world consequences | Safety-critical, economic, policy-relevant |
| **FUD risk** *(inverted)* | Hype, manipulation, sensationalism | Higher = more suspicious |

## Where does the data come from?

**Discovery** (pulled once per hunt, cheap):

| Source | Cost | What it contributes |
|---|---|---|
| [Hacker News](https://news.ycombinator.com) via Algolia | free | Tech enthusiast consensus |
| 15 subreddits (r/MachineLearning, r/LocalLLaMA, r/netsec, …) | free | Per-niche trend signal |
| 43 RSS feeds (BBC, CNN, NYT, Guardian, NPR, WaPo, Al Jazeera, Bloomberg, Verge, Ars, Wired, TechCrunch, MIT Tech Review, IEEE Spectrum, Krebs, Schneier, BleepingComputer, Nature, Science, Quanta, arXiv, …) | free | Global tier-1 coverage |
| [GDELT 2.0](https://gdeltproject.org/) | free | ~100-language news with tone/sentiment scores |
| [GitHub trending](https://github.com/trending) | free | Open-source momentum |
| **X / Twitter trusted-voices list** | paid (budgeted 50/day) | What researchers we follow are actually discussing |

**Verification** (fires only on top-scoring candidates, to control cost):

| Source | Use |
|---|---|
| [arXiv](https://arxiv.org) API | Confirm a cited paper exists; grab the real abstract |
| [Semantic Scholar](https://api.semanticscholar.org) API | Citation count, influential-citation count, author h-index, venue |
| [Marketstack](https://marketstack.com) | Did the story actually move the named ticker? |

If a story claims a breakthrough but Semantic Scholar can't find the paper, or claims market impact but the stock didn't move — both strong FUD flags.

## Who runs it?

Assembled by **Alexandru Dan** ([@KryptonAi](https://x.com/KryptonAi)). The "trusted voices" list is pulled from accounts Alexandru follows on X — tier-1 includes Andrej Karpathy, Yann LeCun, Geoffrey Hinton, Ilya Sutskever, Andrew Ng, Sundar Pichai, Jason Wei.

## Architecture

Static site + scheduled Node processes:

```
┌─────────────────────────────────────────────────────────────────────┐
│                      hunt cron (every 6 h)                          │
│  trending.js → 550+ candidates → filter → enrich top 8 → score      │
│        └─> queue.json                                               │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     publish cron (every hour)                       │
│  publish.js → highest-importance item → posts.json → build.js       │
│        └─> git commit + push → GitHub Pages → live                  │
└─────────────────────────────────────────────────────────────────────┘
```

- **`trending.js`** — one call per source, 20-min disk cache, serializes everything that needs rate-limiting
- **`publish.js`** — picks the highest-scoring queue item using `importance + user taste − FUD penalty`
- **`build.js`** — server-renders `index.html`, per-post pages under `/posts/`, `sitemap.xml`, `feed.xml`, `robots.txt`, `llms.txt`, `llms-full.txt`
- **`server.js`** — local review UI (http://localhost:3737) for Like / Dislike on each item; Likes publish, Dislikes are used to learn your taste

## GEO (Generative Engine Optimization)

Everything an AI engine needs to cite this site confidently:

- **`/llms.txt`** — structured index of every post with impact + trust
- **`/llms-full.txt`** — full corpus for ingestion
- **`/robots.txt`** — explicit allow for GPTBot, ChatGPT-User, OAI-SearchBot, ClaudeBot, PerplexityBot, Google-Extended, Applebot-Extended, Bytespider, CCBot
- Per-post JSON-LD:
  - `NewsArticle` + `BreadcrumbList` + `SpeakableSpecification`
  - `FAQPage` with "Why does this matter?" / "Can you trust this?" / "How important is it?"
  - `ClaimReview` converting the trust verdict into a 1–5 machine-readable fact-check rating

## Signal helpers (installed, callable)

```bash
node trending.js                               # run the full discovery pass
node gdeltCheck.js articles "quantum" 24       # GDELT articles with tone scores
node gdeltCheck.js tone "Claude Mythos"        # tone distribution + polarization
node hnCheck.js top                            # Hacker News top 24h
node redditCheck.js top r/MachineLearning day  # subreddit top of day
node arxivCheck.js search "neurosymbolic"      # arXiv recent papers
node scholarCheck.js arxiv 2201.11903          # Semantic Scholar paper lookup
node marketCheck.js NVDA 2026-04-08            # ticker reaction on a news date
node xCheck.js voices                          # tier-1 X voices recent activity
node xCheck.js budget                          # X daily call budget remaining
```

## Running locally

```bash
# One-time: review UI + API key config
cp .env.example .env   # add your Marketstack, X, Semantic Scholar keys
node server.js         # http://localhost:3737

# Build the static site
node build.js

# Hunt (manual)
node trending.js
```

## Files

| File | Purpose |
|---|---|
| `queue.json` | Pending candidates with full metrics |
| `posts.json` | Published feed (what the site serves) |
| `rejected.json` | Items disliked during review (input for taste learning) |
| `preferences.json` | Learned per-category / per-tag / per-source weights |
| `trusted_voices.json` | Tiered list of X handles whose discussion is strong signal |
| `HUNT.md` | Research pipeline reference for the hunt agent |

## License

MIT. Content is curated from public sources with links back to the originals.
