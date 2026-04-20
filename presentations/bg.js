// Background image generator — content-aware, phase-matched.
// For each item, generates one background per narration phase so the
// visual matches what the narrator is saying at that moment.
// Prompts are derived from the beat text + item tags so the image
// reinforces the spoken content.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ASSETS_DIR = path.join(__dirname, 'assets');

function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (!m) continue;
    const [, key, rawVal = ''] = m;
    if (process.env[key] != null) continue;
    process.env[key] = rawVal.replace(/^['"]|['"]$/g, '');
  }
}
loadEnv();

const CAT_PALETTE = {
  AI:            ['electric cobalt and deep near-black', 'teal aurora and charcoal', 'midnight violet and ink', 'sapphire and carbon'],
  Research:      ['ultraviolet and graphite', 'amethyst and near-black', 'plum twilight and ink', 'indigo and carbon'],
  'Top Tweets':  ['warm amber and deep bronze', 'burnt orange and charcoal', 'gold dusk and ink', 'copper and carbon'],
  Startups:      ['jade and slate', 'emerald noir and charcoal', 'forest midnight and ink', 'teal and carbon'],
  Cybersecurity: ['blood crimson and graphite', 'dark scarlet and charcoal', 'deep garnet and ink', 'maroon and carbon'],
  Quantum:       ['iridescent fuchsia and near-black', 'aqua prism and charcoal', 'sapphire mist and ink', 'violet nebula and carbon'],
  Viral:         ['neon cyan and ink', 'electric magenta and charcoal', 'ultramarine and near-black', 'deep cyan and carbon'],
};

// Broad subject hooks — what kind of visual fits the topic family.
// Looked up by item tags; first hit wins. Intended to steer toward
// concrete imagery rather than abstract gradient mood boards.
const SUBJECT_HOOKS = [
  { match: /tts|voice|audio|speech|asr|whisper|live/i,
    visual: 'glowing audio waveforms and concentric sound-wave circles, studio microphone silhouette in deep shadow, spectrogram bands' },
  { match: /robot|embodied|manipulat|robotic/i,
    visual: 'silhouetted articulated robotic arm in industrial lab, sparse mechanical geometry, long shadows' },
  { match: /image|vision|multimod|visual|ocr/i,
    visual: 'abstract camera aperture geometry, ghosted lens flare, pixel-grid dissolve, photographic bokeh' },
  { match: /benchmark|score|eval|swe|mmlu|aime|percent|leaderboard/i,
    visual: 'minimalist bar-chart silhouettes receding into fog, glowing data ridges, abstract scoreboard mist' },
  { match: /mcp|agent|skill|harness|workflow|tool/i,
    visual: 'interlocking circuit rings, concentric orchestration nodes, connection filaments in deep space' },
  { match: /quantum|qubit|lattice/i,
    visual: 'interference-pattern wave lattice, iridescent crystal geometry, subatomic bloom' },
  { match: /code|coding|repo|github|compiler|python|typescript/i,
    visual: 'abstract terminal glow, soft typography-free code cascade as vertical light streams, monospace mist' },
  { match: /train|pretrain|synthetic|data|dataset/i,
    visual: 'river of luminous data motes flowing into a distillation column, particle streams converging' },
  { match: /model|llm|foundation|transformer/i,
    visual: 'silken layered neural topography, cascading activation bands, organic flowing channels' },
  { match: /chip|silicon|nvidia|gpu|hardware/i,
    visual: 'macro abstract silicon die texture, metallic traces, glowing channel edges, shallow depth' },
  { match: /finance|market|trading|ticker|quant/i,
    visual: 'abstract candlestick ridge silhouettes, luminous grid, subtle chart mist, editorial' },
  { match: /security|cyber|vulnerability|exploit|breach/i,
    visual: 'fractured firewall geometry, cracked shield with red light bleed, dark server corridor' },
  { match: /startup|funding|ipo|vc|round/i,
    visual: 'dawn skyline silhouette with vertical beams of light rising, minimal, cinematic' },
  { match: /research|paper|arxiv|scholar|science/i,
    visual: 'overlapping translucent graph pages with faint ink glow, organic note textures, no readable text' },
];

const SHOT_COMPOSITION = [
  'wide atmospheric hero composition with volumetric light, strong negative space on the right',
  'close-up macro texture, shallow depth of field, iridescent highlights, bokeh',
  'architectural geometric pattern, angular crystalline structures, dramatic low-key lighting',
  'ethereal horizon with subtle gradient bands, calm negative space, photographic dusk',
];

function visualHookFor(item, phaseText = '') {
  const tagsStr = (item.tags || []).join(' ');
  const haystack = `${tagsStr} ${item.title || ''} ${phaseText || ''}`;
  for (const hook of SUBJECT_HOOKS) {
    if (hook.match.test(haystack)) return hook.visual;
  }
  return 'flowing light ribbons and soft volumetric fog, abstract hero plate';
}

function promptFor(item, shotIndex, phaseText) {
  const cat = item.category || 'AI';
  const palette = (CAT_PALETTE[cat] || CAT_PALETTE.AI)[shotIndex % CAT_PALETTE.AI.length];
  const composition = SHOT_COMPOSITION[shotIndex % SHOT_COMPOSITION.length];
  const visual = visualHookFor(item, phaseText);
  return [
    'Editorial tech-news background plate, 16:9 landscape, cinematic grade.',
    'ABSOLUTELY NO text, NO letters, NO logos, NO UI, NO faces, NO people, NO hands.',
    `Subject: ${visual}.`,
    `Dominant palette: ${palette}.`,
    `Composition: ${composition}.`,
    'High-resolution abstract photography aesthetic, gentle negative space on the left so overlaid white typography reads cleanly. Cohesive with editorial news-magazine aesthetic.',
  ].join(' ');
}

async function callNanoBanana(prompt, key) {
  const model = process.env.GEMINI_IMAGE_MODEL || 'nano-banana-pro-preview';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ['IMAGE'] },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini Image ${res.status}: ${errText.slice(0, 300)}`);
  }
  const json = await res.json();
  const parts = json.candidates?.[0]?.content?.parts || [];
  const imgPart = parts.find(p => p.inlineData && /image/.test(p.inlineData.mimeType || ''));
  if (!imgPart) throw new Error('no image in response: ' + JSON.stringify(json).slice(0, 300));
  return Buffer.from(imgPart.inlineData.data, 'base64');
}

// phaseTexts (optional): array of strings, one per image to be generated,
// used to steer each prompt to the beat being narrated at that moment.
// startIndex: filename index to start writing at (so callers can reserve
// earlier slots for other sources like media.js OG images).
async function generateMany(item, { count = 4, force = false, phaseTexts = null, startIndex = 0 } = {}) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set in .env');
  if (!fs.existsSync(ASSETS_DIR)) fs.mkdirSync(ASSETS_DIR, { recursive: true });

  const out = [];
  for (let i = 0; i < count; i++) {
    const slot = startIndex + i;
    const outPath = path.join(ASSETS_DIR, `${item.id}-${slot}.png`);
    if (!force && fs.existsSync(outPath)) {
      out.push({ path: outPath, rel: `assets/${item.id}-${slot}.png`, cached: true });
      continue;
    }
    const phaseText = phaseTexts && phaseTexts[i];
    const prompt = promptFor(item, i, phaseText);
    try {
      const png = await callNanoBanana(prompt, key);
      fs.writeFileSync(outPath, png);
      out.push({ path: outPath, rel: `assets/${item.id}-${slot}.png`, prompt, phaseText, cached: false });
    } catch (e) {
      console.error(`bg[${i}] failed:`, e.message);
      if (out.length) out.push({ ...out[0], fallback: true });
      else throw e;
    }
  }
  return out;
}

async function generate(item, opts) {
  const r = await generateMany(item, { count: 1, ...opts });
  return r[0];
}

module.exports = { generate, generateMany, promptFor, visualHookFor };

if (require.main === module) {
  (async () => {
    const id = process.argv[2];
    if (!id) { console.error('usage: node presentations/bg.js <item-id> [count]'); process.exit(1); }
    const count = Number(process.argv[3] || 4);
    const all = [
      ...JSON.parse(fs.readFileSync(path.join(ROOT, 'posts.json'), 'utf8')),
      ...JSON.parse(fs.readFileSync(path.join(ROOT, 'queue.json'), 'utf8')),
    ];
    const item = all.find(x => x.id === id);
    if (!item) { console.error('no item:', id); process.exit(2); }
    try {
      const r = await generateMany(item, { count, force: true });
      console.log(JSON.stringify(r.map(x => ({ rel: x.rel, prompt: (x.prompt || '').slice(0, 200) + '...' })), null, 2));
    } catch (e) {
      console.error('bg failed:', e.message);
      process.exit(3);
    }
  })();
}
