# Treasure Hunt — research pipeline

Reference doc for the hunt agent (cron that refills `queue.json` with researched items).

## Signal sources

Every candidate news item gets scored against these sources. The hunt agent fetches from each and aggregates evidence.

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

### Market signals (verification only)
- **Marketstack** (user has subscription) — confirm a company-specific news item actually moved the stock.
  - Example: if story claims "OpenAI raises $122B", check MSFT / GOOGL / NVDA for reaction; unusual volume or price move = corroborating signal.
  - If a story predicts major market impact and there's no stock reaction, downgrade FUD risk.

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
