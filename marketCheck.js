#!/usr/bin/env node
// Marketstack helper: given a ticker and a news date, check whether the market
// reacted (price move + volume anomaly). Used by the hunt pipeline as a
// corroborating signal — a market-moving news item that didn't move the market
// is a FUD flag; a calm story that moved the stock is under-covered.
//
// Loads MARKETSTACK_API_KEY from .env.
//
// Usage:
//   node marketCheck.js AAPL 2026-04-10
//   // → { symbol: "AAPL", changePct: -2.3, volumeAnomaly: 1.8, verdict: "reacted" }

const fs = require('fs');
const path = require('path');

// ─── Minimal .env loader (no deps) ────────────────────────────────────────────
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (!m) continue;
    const [, key, rawVal = ''] = m;
    if (process.env[key] != null) continue;
    const val = rawVal.replace(/^['"]|['"]$/g, '');
    process.env[key] = val;
  }
}
loadEnv();

const KEY = process.env.MARKETSTACK_API_KEY;
if (!KEY) {
  console.error('MARKETSTACK_API_KEY not set. Add it to .env (copy .env.example).');
  process.exit(1);
}

// ─── API call ─────────────────────────────────────────────────────────────────
async function fetchEod(symbol, fromDate, toDate) {
  const url = new URL('https://api.marketstack.com/v2/eod');
  url.searchParams.set('access_key', KEY);
  url.searchParams.set('symbols', symbol);
  url.searchParams.set('date_from', fromDate);
  url.searchParams.set('date_to', toDate);
  url.searchParams.set('limit', '30');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`marketstack ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return (json.data || []).reverse(); // chronological
}

function addDays(iso, n) {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ─── Public API ───────────────────────────────────────────────────────────────
//   check(symbol, newsDate) → {
//     symbol, newsDate, tradingDay, close, prevClose,
//     changePct, volume, avgVolume20d, volumeAnomaly, verdict
//   }
// verdict: "reacted" | "muted" | "inconclusive" | "no-data"
async function check(symbol, newsDate) {
  // Window: 30 days before through 7 days after news date.
  const from = addDays(newsDate, -30);
  const to   = addDays(newsDate, 7);
  const rows = await fetchEod(symbol, from, to);
  if (!rows.length) return { symbol, newsDate, verdict: 'no-data' };

  // Find the first trading day on or after the news date.
  const tgtIdx = rows.findIndex(r => r.date.slice(0, 10) >= newsDate);
  if (tgtIdx < 1) return { symbol, newsDate, verdict: 'no-data' };

  const tgt = rows[tgtIdx];
  const prev = rows[tgtIdx - 1];
  const changePct = ((tgt.close - prev.close) / prev.close) * 100;

  // 20-day trailing average volume ending the day before news
  const prior = rows.slice(Math.max(0, tgtIdx - 20), tgtIdx);
  const avgVolume20d = prior.reduce((s, r) => s + r.volume, 0) / Math.max(1, prior.length);
  const volumeAnomaly = avgVolume20d ? tgt.volume / avgVolume20d : null;

  // Verdict thresholds are intentionally wide — we want corroboration, not precision.
  const moved = Math.abs(changePct) >= 2.0;
  const highVol = volumeAnomaly != null && volumeAnomaly >= 1.5;
  const verdict =
    moved && highVol ? 'reacted' :
    moved || highVol ? 'inconclusive' :
    'muted';

  return {
    symbol,
    newsDate,
    tradingDay: tgt.date.slice(0, 10),
    close: tgt.close,
    prevClose: prev.close,
    changePct: Math.round(changePct * 100) / 100,
    volume: tgt.volume,
    avgVolume20d: Math.round(avgVolume20d),
    volumeAnomaly: volumeAnomaly ? Math.round(volumeAnomaly * 100) / 100 : null,
    verdict
  };
}

module.exports = { check };

// ─── CLI ──────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const [, , symbol, newsDate] = process.argv;
  if (!symbol || !newsDate) {
    console.error('Usage: node marketCheck.js <SYMBOL> <YYYY-MM-DD>');
    process.exit(2);
  }
  check(symbol, newsDate).then(r => {
    console.log(JSON.stringify(r, null, 2));
  }).catch(e => {
    console.error('Error:', e.message);
    process.exit(1);
  });
}
