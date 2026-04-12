# Treasure Hunt — research pipeline

Reference doc for the hunt agent (cron that refills `queue.json` with researched items).

## Signal sources

Every candidate news item gets scored against these sources. The hunt agent fetches from each and aggregates evidence.

## Candidate sourcing — top trends, not per-item searches

The hunt agent should call **`node trending.js`** (or `require('./trending').collectAll()`) ONCE per hunt. This pulls top items from:

- Hacker News top of last 24h (min 100 points) via Algolia API — free, unlimited
- 15 target subreddits (r/technology, r/MachineLearning, r/LocalLLaMA, r/OpenAI, r/ClaudeAI, r/singularity, r/QuantumComputing, r/Physics, r/netsec, r/cybersecurity, r/sysadmin, r/venturecapital, r/startups, r/Futurology, r/programming) — free, JSON endpoint
- Techmeme RSS — curated tech aggregator
- Google News RSS (AI, Quantum, Cyber feeds)
- The Hacker News RSS
- Product Hunt RSS
- arXiv cs.AI and cs.LG RSS
- (X trends via `xCheck.topTrends()` when keys exist — budgeted: 1 call per hunt)

Results are cached for 20 minutes on disk, deduped by URL, and scored cross-source (HN: points + comments · Reddit: log-ups + comments · RSS: position).

**Cost discipline:** NO per-candidate API calls at this stage. Enrich + verify (coverage, scholar, market, X mentions) only happens for the top ~10-15 candidates that survive the initial filter, and only where that signal adds verifiable value.

### Coverage signals
- **Google News** — broad aggregator; `site:news.google.com` + keyword search gives outlet count.
- **Yahoo News** — complementary coverage, especially finance-adjacent.
- **Reuters, Bloomberg, FT, WSJ, NYT, The Economist** — tier-1 outlets. Each counts 2× in the coverage score.
- **Category-specific outlets**:
  - AI: The Verge, TechCrunch, Ars Technica, Wired, The Information, Platformer, Stratechery.
  - Quantum: IEEE Spectrum, Quanta, Phys.org, The Quantum Insider, Nature.
  - Cybersecurity: The Hacker News, BleepingComputer, Dark Reading, SecurityWeek, Cisco Talos blog, CISA.
  - Startups: Crunchbase, PitchBook, The Information.
  - Research: Nature, Science, PNAS, arXiv, MIT Tech Review.

### Social signals
- **X / Twitter Explore** (https://x.com/explore) — what's trending right now.
- **X follow list** (`trusted_voices.json`) — if someone the user follows is discussing it, weight heavily. Missing voices ≠ negative; presence ≠ strongly positive.
- **Reddit** — check relevant subs per category:
  - AI: r/MachineLearning, r/LocalLLaMA, r/singularity, r/OpenAI, r/ChatGPT, r/ClaudeAI.
  - Quantum: r/QuantumComputing, r/Physics, r/science.
  - Cybersecurity: r/netsec, r/cybersecurity, r/sysadmin.
  - Startups: r/venturecapital, r/startups, r/technology.
  - Viral: r/technology, r/Futurology.

### Academic signals (primary-source verification for Research category)
- **arXiv** — wired up via `arxivCheck.js`. Free public API, no auth.
  - `node arxivCheck.js search "<query>"` — recent papers, sorted by submission date
  - `node arxivCheck.js get <arxivId>` — full metadata for a specific paper
  - Use when a news item cites a paper: confirm it exists, grab the real abstract, correct authors.
- **Semantic Scholar** — wired up via `scholarCheck.js`. Google-Scholar-equivalent with real API.
  - `node scholarCheck.js arxiv <arxivId>` or `doi <doi>` or `search "<query>"`
  - Returns: citation count, **influential** citation count, venue, author h-indexes.
  - `scoreSignals(paper)` returns suggested authority/novelty deltas.
  - **Scoring rules**: citations ≥ 500 → authority +3; ≥ 100 → +2; ≥ 25 → +1. Influential citations ≥ 30 → authority +1. Top-author h-index ≥ 40 → authority +1. Same-year publication with ≥5 influential citations → novelty +2.
  - If a "research breakthrough" news item references a paper that Semantic Scholar can't find, treat it as a strong FUD flag.

### GitHub trending
- **https://github.com/trending?since=daily** — daily hot repos
- **https://github.com/trending?since=weekly** — weekly hot repos
- **https://github.com/trending/python?since=daily** — language-scoped (python/typescript/rust are AI-adjacent)
- Signal rules:
  - Repo trending with 1k+ daily stars is news-worthy on its own (often heralds an open-source release)
  - Trending adjacent to a news story corroborates it (e.g., new model release + repo hits trending)
  - Watch org accounts: `google-ai-edge/`, `NVIDIA/`, `meta-llama/`, `openai/`, `anthropic/`, `HuggingFace/`, `microsoft/`
  - Karpathy-connected repos (`karpathy/*`, `andrej-karpathy-skills`, nanoGPT forks) are high-signal for practitioner attention

### Market signals (verification only)
- **Marketstack** — wired up via `marketCheck.js`. Call `node marketCheck.js <SYMBOL> <YYYY-MM-DD>` (or `require('./marketCheck').check(sym, date)`). Returns `{changePct, volumeAnomaly, verdict}`. API key in `.env` (gitignored).
  - **Verdicts**: `reacted` (|Δ| ≥ 2% AND volume ≥ 1.5× avg) · `inconclusive` (one or the other) · `muted` (neither) · `no-data`.
  - **How to use in scoring**: for any news item naming a public company, run the check. If story implies major impact but verdict is `muted`, bump `fudRisk` by +2. If verdict is `reacted`, bump `authority` and `stakes` by +1. Record the result in `signals.tickerMove`.
  - **Relevant tickers**: NVDA, MSFT, GOOGL, META, AAPL, AMZN, TSLA, PLTR, AMD, ORCL, IBM, CRM, SNOW, NET (Cloudflare), DDOG, CRWD, PANW, S (SentinelOne), IONQ, RGTI.

## Scoring (0–10 per dimension)

| Dimension | What it measures | High score looks like |
|-----------|------------------|-----------------------|
| **Coverage** | How many independent outlets covered it | 20+ outlets, 5+ tier-1 |
| **Social** | Volume + quality of discussion | Thousands of mentions, trusted voices weighing in |
| **Novelty** | How new/unique the development is | First-of-kind breakthrough, not incremental |
| **Authority** | Quality of primary source | Peer-reviewed paper, regulator, official vendor |
| **Concreteness** | Specifics vs. vagueness | Named people, hard numbers, dates, replicable claims |
| **Stakes** | Real-world consequences | Safety-critical, economic, policy, scientific |
| **FUD risk** *(inverted)* | Hype / sensationalism / manipulation risk | High = suspicious |

**Composite importance** = 0.22 × Stakes + 0.18 × Novelty + 0.15 × Authority + 0.12 × Coverage + 0.12 × Concreteness + 0.11 × Social + 0.10 × (10 − FUD risk).

## FUD detection

Flag items where:
- Headline uses "world is not ready", "changes everything", "nobody saw this coming", "secret" — without proportional primary-source backing.
- Only sensationalist outlets cover it; no tier-1 treatment.
- Primary source is anonymous leaks, no replication.
- Company/token has a financial incentive to publish it.
- Quantum/AI promises where stated capabilities break physics or current benchmarks by >2 orders of magnitude.
- Stock-moving news without corresponding volume/price action on marketstack.

## Trust verdicts

- **high** — primary source exists, tier-1 outlet corroboration, concrete numbers, no FUD flags.
- **medium** — some gaps (missing primary source or single-outlet leak), modest FUD flags, claims plausible but unreplicated.
- **low** — anonymous sources, pattern of hype, market signals don't match story.

## What an enriched queue item looks like

```json
{
  "id": "short-kebab-id",
  "category": "AI | Quantum | Cybersecurity | Startups | Research | Top Tweets | Viral",
  "title": "Punchy headline — names + numbers in title when possible",
  "summary": "~500 chars, concrete: who, what, how much, when, why now",
  "tags": ["5-7 specific tags"],
  "url": "source article URL",
  "source": "publisher name",
  "metrics": {
    "coverage": 0, "social": 0, "novelty": 0, "authority": 0,
    "concreteness": 0, "stakes": 0, "fudRisk": 0,
    "importance": 0, "trust": 0
  },
  "signals": {
    "outletCount": 0, "tier1Count": 0,
    "outlets": [],
    "twitterMentions": 0,
    "topTweets": [{ "handle": "@x", "likes": 0 }],
    "subreddits": [],
    "redditTop": { "sub": "r/x", "upvotes": 0 },
    "trustedVoicesCount": 0,
    "tickerMove": { "symbol": "AAPL", "changePct": 0 }
  },
  "whyItMatters": "300-500 chars explaining downstream consequences",
  "trustVerdict": "high | medium | low",
  "trustNotes": "concrete reasoning — why this verdict",
  "primarySource": "URL of first-party source, if known"
}
```
