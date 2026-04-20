// Cinematic composer with narration sync + multi-background crossfades.
// Expects upstream pipeline to provide:
//   bgRels:       string[]   relative paths to ≥1 background images
//   audioRel:     string     relative path to TTS WAV
//   audioDuration: number    duration of TTS audio
//   phases:       array from sync.js alignPhrases() — [{start,end,text}, ...]
//                 produced from narration script + hyperframes transcribe output
//
// The narration script produced by tts.narrationFromItem splits into 4 phrases:
//   0: "<Category> update."
//   1: "<Title>."
//   2: "<beats joined>"     — one combined sentence pair
//   3: "Source: <source>."
// We drive visibility of UI chunks off the phase windows.

const CAT_ACCENT = {
  AI:             '#38bdf8',
  Research:       '#a78bfa',
  'Top Tweets':   '#f59e0b',
  Startups:       '#34d399',
  Quantum:        '#c084fc',
  Cybersecurity:  '#f87171',
  Viral:          '#22d3ee',
};

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function splitBeats(summary, max = 2) {
  const sentences = String(summary || '')
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean);
  const beats = [];
  let buf = '';
  for (const s of sentences) {
    if ((buf + ' ' + s).trim().length > 160 && buf) { beats.push(buf.trim()); buf = s; }
    else buf = buf ? buf + ' ' + s : s;
    if (beats.length >= max - 1) break;
  }
  if (buf) beats.push(buf.trim());
  return beats.slice(0, max);
}

// Split the combined beats-phase time window into N equal sub-windows so
// we can still animate in each beat separately even when the TTS merged
// them into one long phrase.
function subDivideWindow(win, n, pad = 0.2) {
  if (!win || n <= 0) return [];
  const dur = Math.max(0.5, win.end - win.start);
  const each = dur / n;
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      start: +(win.start + i * each).toFixed(3),
      end: +(win.start + (i + 1) * each - pad).toFixed(3),
    });
  }
  return out;
}

// Extract big "stat callouts" from the narration — percentages, dollar
// amounts, multipliers, star-counts, and round big numbers. We look up
// each in the transcript to get the exact time the narrator says it,
// so the callout can pop in sync.
function extractStats(transcript) {
  if (!Array.isArray(transcript) || !transcript.length) return [];
  const words = transcript.map(w => ({
    ...w,
    norm: String(w.text || '').toLowerCase(),
  }));
  const stats = [];
  const seen = new Set();

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const text = w.norm.replace(/[^a-z0-9.%$]/g, '');

    // Percentages: "90.8", "36.1", often followed by "percent" or "%".
    const numMatch = text.match(/^(\d+(?:\.\d+)?)$/);
    if (numMatch) {
      const nextNorm = words[i + 1]?.norm || '';
      const num = numMatch[1];

      // NN (.MM)? percent
      if (/percent|%/.test(nextNorm)) {
        const label = num + '%';
        if (!seen.has(label)) {
          stats.push({
            label,
            start: w.start,
            end: (words[i + 1] && words[i + 1].end) || w.end + 1.0,
          });
          seen.add(label);
          continue;
        }
      }
      // NN times / NNx
      if (/^times?$/.test(nextNorm)) {
        const label = `${num}×`;
        if (!seen.has(label)) {
          stats.push({
            label,
            start: w.start,
            end: (words[i + 1] && words[i + 1].end) || w.end + 1.0,
          });
          seen.add(label);
          continue;
        }
      }
      // NN billion/million dollars
      if (/^(billion|million|thousand)$/.test(nextNorm)) {
        const unit = { billion: 'B', million: 'M', thousand: 'K' }[nextNorm];
        const label = `$${num}${unit}`;
        if (!seen.has(label)) {
          stats.push({
            label,
            start: w.start,
            end: (words[i + 2] && words[i + 2].end) || w.end + 1.5,
          });
          seen.add(label);
          continue;
        }
      }
    }
  }

  // Keep at most 4 stats, spaced ≥2s apart to avoid visual collision.
  const spaced = [];
  for (const s of stats) {
    if (!spaced.length || s.start - spaced[spaced.length - 1].start >= 2.0) {
      spaced.push(s);
    }
    if (spaced.length >= 4) break;
  }
  return spaced;
}

// Group word-level transcript into caption chunks that break on
// SENTENCE boundaries only. Never breaks mid-sentence.
// If a single sentence runs longer than MAX_DUR, we allow a break at
// the longest inter-word gap (natural speaking pause). Falls back to
// clause-punctuation (, ; :) only when no big pause exists.
function captionChunks(transcript, opts = {}) {
  const MAX_DUR = opts.maxDur ?? 7.0;
  const out = [];
  if (!Array.isArray(transcript) || !transcript.length) return out;

  const clean = words =>
    words.map(w => w.text).join(' ').replace(/\s+([.,!?;:])/g, '$1').trim();

  // Step 1: split transcript into sentence chunks on . ! ?
  const sentences = [];
  let cur = [];
  for (const w of transcript) {
    cur.push(w);
    if (/[.!?]$/.test(w.text)) {
      sentences.push(cur);
      cur = [];
    }
  }
  if (cur.length) sentences.push(cur);

  // Step 2: for each sentence, if it fits MAX_DUR, emit as-is.
  // Otherwise split at the single biggest pause; if still too long,
  // recursively split at next biggest pause.
  const emitSentence = (words) => {
    if (!words.length) return;
    const duration = words[words.length - 1].end - words[0].start;
    if (duration <= MAX_DUR || words.length < 6) {
      out.push({
        start: +words[0].start.toFixed(3),
        end: +words[words.length - 1].end.toFixed(3),
        text: clean(words),
      });
      return;
    }
    // Find biggest gap between consecutive words (natural pause).
    // Prefer gaps that also follow clause punctuation.
    let bestIdx = -1;
    let bestScore = 0;
    for (let i = 1; i < words.length - 1; i++) {
      const gap = words[i].start - words[i - 1].end;
      const isClause = /[,;:]$/.test(words[i - 1].text);
      const score = gap + (isClause ? 0.4 : 0);
      // Prefer breakpoints in the middle of the sentence to balance.
      const balance = 1 - Math.abs(i / words.length - 0.5) * 2;
      const adjusted = score * (0.6 + 0.4 * balance);
      if (adjusted > bestScore) { bestScore = adjusted; bestIdx = i; }
    }
    if (bestIdx < 0) bestIdx = Math.floor(words.length / 2);
    emitSentence(words.slice(0, bestIdx));
    emitSentence(words.slice(bestIdx));
  };

  for (const sent of sentences) emitSentence(sent);
  return out;
}

function composeHTML(item, opts = {}) {
  const {
    bgRels = [],
    audioRel = null,
    audioDuration = null,
    phases = null,
    transcript = null,
  } = opts;

  const accent = CAT_ACCENT[item.category] || CAT_ACCENT.AI;
  const beats = splitBeats(item.summary, 2);
  const title = item.title || '';
  const source = item.source || '';

  // Total runtime: 0.4s lead-in + narration + 0.8s tail. Keeps the last word from clipping.
  const LEAD = 0.4;
  const TAIL = 1.0;
  const total = audioDuration
    ? +(audioDuration + LEAD + TAIL).toFixed(2)
    : 20;

  // Phase windows (in seconds, AUDIO-relative — shift by LEAD for video timing).
  // phases[i] = {start,end,text} or null. Provide sane fallback timing when absent.
  const fallback = {
    intro:  { start: 0.0, end: 2.0 },
    title:  { start: 2.0, end: 6.0 },
    beats:  { start: 6.0, end: Math.max(14, (audioDuration || 16) - 3.0) },
    source: { start: Math.max(14, (audioDuration || 16) - 3.0), end: audioDuration || 16 },
  };
  // Phase layout:
  //   phases[0]         = intro     ("<cat> update.")
  //   phases[1]         = title     ("<title>.")
  //   phases[2..N-2]    = beats     (1..M summary sentences)
  //   phases[N-1]       = source    ("Source: <name>.")
  const shift = w => ({ start: (w.start || 0) + LEAD, end: (w.end || 0) + LEAD });
  let introW, titleW, beatsW, sourceW, innerBeatPhases;
  if (phases && phases.length >= 4) {
    introW = shift(phases[0]);
    titleW = shift(phases[1]);
    sourceW = shift(phases[phases.length - 1]);
    innerBeatPhases = phases.slice(2, phases.length - 1).map(shift);
    beatsW = {
      start: innerBeatPhases[0]?.start ?? titleW.end,
      end:   innerBeatPhases[innerBeatPhases.length - 1]?.end ?? sourceW.start,
    };
  } else {
    introW  = { start: fallback.intro.start  + LEAD, end: fallback.intro.end  + LEAD };
    titleW  = { start: fallback.title.start  + LEAD, end: fallback.title.end  + LEAD };
    beatsW  = { start: fallback.beats.start  + LEAD, end: fallback.beats.end  + LEAD };
    sourceW = { start: fallback.source.start + LEAD, end: fallback.source.end + LEAD };
    innerBeatPhases = null;
  }

  // Split the beats window across each beat line.
  // If we have actual phrase windows, map one beat → one phrase window (take first N).
  const beatWindows = innerBeatPhases && innerBeatPhases.length >= beats.length
    ? innerBeatPhases.slice(0, beats.length).map(p => ({ start: p.start, end: p.end }))
    : subDivideWindow(beatsW, beats.length);

  const clips = [];
  const tl = [];

  // ── Background layer — N images crossfade across the timeline ─────────
  const bgCount = Math.max(1, bgRels.length);
  const bgSlice = total / bgCount;
  const CROSSFADE = 1.2;
  bgRels.forEach((rel, i) => {
    const start = Math.max(0, i * bgSlice - CROSSFADE / 2);
    const dur = bgSlice + (i === 0 || i === bgCount - 1 ? CROSSFADE / 2 : CROSSFADE);
    const clipDur = Math.min(dur, total - start);
    const id = `bg${i}`;
    clips.push(`
      <div id="${id}" class="clip" data-start="${start}" data-duration="${clipDur}" data-track-index="${i}"
           style="position:absolute;inset:0;overflow:hidden;opacity:${i === 0 ? 1 : 0};">
        <img src="${rel}" alt=""
             style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transform-origin:center;"
             data-bg-idx="${i}"/>
      </div>`);
    // Ken Burns drift: slow zoom + pan across each bg's window.
    tl.push(`tl.fromTo('#${id} img', { scale: 1.02, x: 0, y: 0 }, { scale: 1.18, x: -50, y: ${i % 2 ? -30 : 30}, duration: ${clipDur}, ease: 'none' }, ${start});`);
    if (i > 0) {
      tl.push(`tl.to('#${id}', { opacity: 1, duration: ${CROSSFADE}, ease: 'power1.inOut' }, ${start});`);
      tl.push(`tl.to('#bg${i - 1}', { opacity: 0, duration: ${CROSSFADE}, ease: 'power1.inOut' }, ${start});`);
    }
  });

  // Fallback gradient when no bg images at all.
  if (!bgRels.length) {
    const grad = `linear-gradient(135deg, #04060f 0%, #0b1224 45%, ${accent}33 100%)`;
    clips.push(`<div class="clip" data-start="0" data-duration="${total}" data-track-index="0" style="position:absolute;inset:0;background:${grad};"></div>`);
  }

  // ── Legibility overlays ───────────────────────────────────────────────
  const overlayTrack = bgCount + 1;
  clips.push(`
    <div class="clip" data-start="0" data-duration="${total}" data-track-index="${overlayTrack}"
         style="position:absolute;inset:0;background:linear-gradient(180deg, rgba(4,6,15,0.60) 0%, rgba(4,6,15,0.15) 38%, rgba(4,6,15,0.88) 100%);pointer-events:none;"></div>
    <div class="clip" data-start="0" data-duration="${total}" data-track-index="${overlayTrack + 1}"
         style="position:absolute;inset:0;background:linear-gradient(90deg, rgba(4,6,15,0.70) 0%, rgba(4,6,15,0.15) 55%, rgba(4,6,15,0.0) 100%);pointer-events:none;"></div>
    <div class="clip" data-start="0" data-duration="${total}" data-track-index="${overlayTrack + 2}"
         style="position:absolute;inset:0;background:radial-gradient(ellipse at 25% 30%, ${accent}22 0%, transparent 55%);mix-blend-mode:screen;pointer-events:none;"></div>`);

  // ── Category badge ────────────────────────────────────────────────────
  const badgeEnd = Math.min(introW.end + 1.0, titleW.start + 1.2);
  clips.push(`
    <div id="badge" class="clip" data-start="${introW.start}" data-duration="${Math.max(1.5, badgeEnd - introW.start)}" data-track-index="${overlayTrack + 3}"
         style="position:absolute;top:90px;left:120px;display:inline-flex;align-items:center;gap:14px;
                font:600 30px 'Inter',-apple-system,system-ui,sans-serif;letter-spacing:5px;text-transform:uppercase;
                color:${accent};padding:16px 28px;border:2px solid ${accent};border-radius:999px;
                backdrop-filter:blur(10px);background:rgba(4,6,15,0.40);">
      <span style="width:8px;height:8px;background:${accent};border-radius:50%;box-shadow:0 0 14px ${accent};"></span>
      ${esc(item.category || 'AI')}
    </div>`);
  tl.push(`tl.from('#badge', { opacity: 0, x: -60, duration: 0.6, ease: 'power3.out' }, ${introW.start});`);
  tl.push(`tl.to('#badge', { opacity: 0, y: -20, duration: 0.5, ease: 'power2.in' }, ${badgeEnd - 0.5});`);

  // ── Title — on screen from the start, dims during beats, returns at end
  const titleFontSize = title.length > 110 ? 56 : title.length > 80 ? 68 : title.length > 55 ? 80 : 92;
  const titleStart = 0.3;
  const titleEnd = sourceW.start;
  clips.push(`
    <div id="title" class="clip" data-start="${titleStart}" data-duration="${titleEnd - titleStart}" data-track-index="${overlayTrack + 4}"
         style="position:absolute;top:260px;left:120px;right:120px;
                font:800 ${titleFontSize}px 'Inter',-apple-system,system-ui,sans-serif;
                line-height:1.05;color:#fff;letter-spacing:-1.5px;
                text-shadow:0 8px 40px rgba(0,0,0,0.70);">${esc(title)}</div>`);
  tl.push(`tl.from('#title', { opacity: 0, y: 60, duration: 0.9, ease: 'power3.out' }, ${titleStart});`);
  if (beats.length) {
    tl.push(`tl.to('#title', { opacity: 0.25, duration: 0.8, ease: 'power2.inOut' }, ${beatsW.start - 0.2});`);
    tl.push(`tl.to('#title', { opacity: 1, duration: 0.6, ease: 'power2.inOut' }, ${titleEnd - 1.2});`);
  }
  tl.push(`tl.to('#title', { opacity: 0, y: -20, duration: 0.6, ease: 'power2.in' }, ${titleEnd - 0.6});`);

  // ── Beats — each line appears within its sub-window of the beats phase
  beats.forEach((b, i) => {
    const id = `beat${i + 1}`;
    const win = beatWindows[i] || { start: beatsW.start + i * 4, end: beatsW.end };
    const start = win.start;
    const dur = Math.max(2.0, win.end - win.start);
    clips.push(`
      <div id="${id}" class="clip" data-start="${start}" data-duration="${dur}" data-track-index="${overlayTrack + 5 + i}"
           style="position:absolute;top:600px;left:120px;right:180px;max-width:1400px;
                  font:500 34px 'Inter',-apple-system,system-ui,sans-serif;line-height:1.38;
                  color:#e2e8f0;text-shadow:0 4px 20px rgba(0,0,0,0.65);">
        <span style="display:inline-block;width:36px;height:3px;background:${accent};vertical-align:middle;margin-right:22px;transform:translateY(-6px);box-shadow:0 0 12px ${accent};"></span>${esc(b)}
      </div>`);
    tl.push(`tl.from('#${id}', { opacity: 0, y: 25, duration: 0.7, ease: 'power3.out' }, ${start});`);
    tl.push(`tl.to('#${id}', { opacity: 0, y: -10, duration: 0.5, ease: 'power2.in' }, ${start + dur - 0.5});`);
  });

  // ── Source stamp ──────────────────────────────────────────────────────
  const sourceTrack = overlayTrack + 5 + beats.length + 1;
  clips.push(`
    <div id="source" class="clip" data-start="${sourceW.start}" data-duration="${total - sourceW.start}" data-track-index="${sourceTrack}"
         style="position:absolute;bottom:110px;left:120px;
                font:600 26px 'Inter',-apple-system,system-ui,sans-serif;color:${accent};
                letter-spacing:4px;text-transform:uppercase;">
      Source &nbsp;·&nbsp; ${esc(source)}
    </div>`);
  tl.push(`tl.from('#source', { opacity: 0, x: -30, duration: 0.7, ease: 'power3.out' }, ${sourceW.start});`);

  // ── Brand + animated accent bar (always on) ───────────────────────────
  clips.push(`
    <div id="brand" class="clip" data-start="0" data-duration="${total}" data-track-index="${sourceTrack + 1}"
         style="position:absolute;bottom:110px;right:120px;
                font:700 22px 'Inter',-apple-system,system-ui,sans-serif;color:rgba(255,255,255,0.55);
                letter-spacing:6px;text-transform:uppercase;">treasurehunt.alexandrudan.com</div>
    <div id="bar" class="clip" data-start="0" data-duration="${total}" data-track-index="${sourceTrack + 2}"
         style="position:absolute;bottom:70px;left:120px;height:3px;background:${accent};
                box-shadow:0 0 18px ${accent};transform-origin:left center;"></div>`);
  tl.push(`tl.fromTo('#bar', { width: 0 }, { width: 1680, duration: ${total - 1}, ease: 'power1.inOut' }, 0.5);`);

  // ── Big stat callouts — animate when narrator says a number ──────────
  const statTrackBase = sourceTrack + 200;
  let statClips = '';
  let statTl = '';
  if (transcript && transcript.length) {
    const stats = extractStats(transcript);
    stats.forEach((s, i) => {
      const startAbs = s.start + LEAD;
      const dur = Math.max(1.8, (s.end - s.start) + 1.4);
      const id = `stat${i}`;
      statClips += `
      <div id="${id}" class="clip stat" data-start="${startAbs.toFixed(3)}" data-duration="${dur.toFixed(3)}" data-track-index="${statTrackBase + i}">
        <span class="stat-num">${esc(s.label)}</span>
      </div>`;
      statTl += `\n      tl.fromTo('#${id} .stat-num', { scale: 0.7, opacity: 0, y: 20 }, { scale: 1, opacity: 1, y: 0, duration: 0.55, ease: 'back.out(2.1)' }, ${startAbs.toFixed(3)});`;
      statTl += `\n      tl.to('#${id} .stat-num', { opacity: 0, y: -12, duration: 0.5, ease: 'power2.in' }, ${(startAbs + dur - 0.5).toFixed(3)});`;
    });
  }

  // ── Subtitle captions — verbatim narration, chunked ───────────────────
  // Positioned at bottom-center so the big-beat text up top and the
  // source/brand strip at the very bottom stay legible.
  const subtitleTrackBase = sourceTrack + 3;
  let subtitleClips = '';
  let subtitleTl = '';
  if (transcript && transcript.length) {
    const chunks = captionChunks(transcript);
    chunks.forEach((c, i) => {
      const startAbs = c.start + LEAD;
      const dur = Math.max(0.4, c.end - c.start);
      const id = `sub${i}`;
      subtitleClips += `
      <div id="${id}" class="clip subtitle" data-start="${startAbs.toFixed(3)}" data-duration="${dur.toFixed(3)}" data-track-index="${subtitleTrackBase + i}">
        <span class="sub-pill">${esc(c.text)}</span>
      </div>`;
      subtitleTl += `\n      tl.from('#${id}', { opacity: 0, y: 12, duration: 0.28, ease: 'power2.out' }, ${startAbs.toFixed(3)});`;
      subtitleTl += `\n      tl.to('#${id}', { opacity: 0, duration: 0.22, ease: 'power1.in' }, ${(startAbs + dur - 0.22).toFixed(3)});`;
    });
  }

  // ── Audio track ───────────────────────────────────────────────────────
  const audioTrack = subtitleTrackBase + 100;
  let audioEl = '';
  if (audioRel) {
    audioEl = `
    <audio id="narration" class="clip" data-start="${LEAD}" data-duration="${audioDuration || total - LEAD}" data-track-index="${audioTrack}"
           src="${audioRel}" preload="auto"></audio>`;
  }

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body {
        margin: 0; width: 1920px; height: 1080px; overflow: hidden;
        background: #04060f;
        font-family: 'Inter', -apple-system, system-ui, sans-serif;
        -webkit-font-smoothing: antialiased;
      }
      .clip { position: absolute; }
      .subtitle {
        left: 0; right: 0; bottom: 180px;
        display: flex; justify-content: center; align-items: center;
        pointer-events: none;
      }
      .sub-pill {
        display: inline-block;
        max-width: 1600px;
        padding: 18px 36px;
        font: 600 38px 'Inter', -apple-system, system-ui, sans-serif;
        line-height: 1.25;
        letter-spacing: -0.2px;
        color: #fff;
        text-align: center;
        background: rgba(4, 6, 15, 0.72);
        backdrop-filter: blur(14px);
        border-radius: 14px;
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.55);
        text-shadow: 0 2px 10px rgba(0, 0, 0, 0.6);
      }
      .stat {
        top: 60px; right: 120px;
        display: flex; align-items: center; justify-content: flex-end;
        pointer-events: none;
      }
      .stat-num {
        display: inline-block;
        font: 900 180px 'Inter', -apple-system, system-ui, sans-serif;
        letter-spacing: -6px;
        line-height: 1;
        color: ${accent};
        text-shadow: 0 12px 50px rgba(0, 0, 0, 0.7), 0 0 40px ${accent}55;
        padding: 24px 40px;
      }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${total}" data-width="1920" data-height="1080">
      ${clips.join('\n      ')}
      ${statClips}
      ${subtitleClips}
      ${audioEl}
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });
      ${tl.join('\n      ')}${statTl}${subtitleTl}
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`;
}

module.exports = { composeHTML };
