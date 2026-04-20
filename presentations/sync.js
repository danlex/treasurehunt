// Align narration phrases to transcript word timestamps.
// Walks through the transcript proportionally by word count — robust to
// tokenization mismatches (e.g. Whisper splitting "SynthID" into "synth"
// + "AI"). As long as the TTS rendered the full script, phase boundaries
// land within ~1 word of accuracy.

function normalizeWord(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function splitPhrases(script) {
  return String(script || '')
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function countWords(phrase) {
  return phrase.split(/\s+/).map(normalizeWord).filter(Boolean).length;
}

function alignPhrases(script, transcript) {
  const phrases = splitPhrases(script);
  const words = Array.isArray(transcript) ? transcript : [];
  const W = words.length;
  if (!phrases.length || !W) return phrases.map(p => ({ start: 0, end: 0, text: p }));

  // Expected word counts per phrase
  const counts = phrases.map(countWords);
  const totalExpected = counts.reduce((a, b) => a + b, 0) || 1;

  // Pro-rata distribute the W transcript words to phrases using counts as weights.
  const assigned = counts.map(c => Math.max(1, Math.round((c / totalExpected) * W)));
  // Fix rounding drift.
  let drift = W - assigned.reduce((a, b) => a + b, 0);
  let i = 0;
  while (drift !== 0 && assigned.length) {
    assigned[i % assigned.length] += drift > 0 ? 1 : -1;
    drift += drift > 0 ? -1 : 1;
    i++;
  }

  const out = [];
  let cursor = 0;
  for (let p = 0; p < phrases.length; p++) {
    const n = Math.max(1, assigned[p]);
    const start = cursor;
    const end = Math.min(W - 1, start + n - 1);
    const startT = words[start]?.start ?? 0;
    const endT = words[end]?.end ?? startT;
    out.push({ start: +startT.toFixed(3), end: +endT.toFixed(3), text: phrases[p] });
    cursor = end + 1;
  }
  return out;
}

module.exports = { alignPhrases, splitPhrases, normalizeWord };
