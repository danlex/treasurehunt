// Gemini TTS for treasurehunt presentations.
// Calls gemini-2.5-flash-preview-tts with responseModalities=[AUDIO],
// receives raw 24kHz 16-bit mono PCM, wraps it as WAV, saves under
// presentations/audio/<id>.wav.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const AUDIO_DIR = path.join(__dirname, 'audio');

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

// Warmer, more human voice lineup — Enceladus is notably natural; Charon
// is authoritative but not stiff; Algieba has news-anchor timbre.
const VOICES = {
  AI:             'Enceladus',  // breathy, engaged
  Research:       'Charon',     // steady, analytical
  'Top Tweets':   'Algieba',    // anchor-like conversational
  Startups:       'Iapetus',    // confident, warm
  Cybersecurity:  'Orus',       // serious without being cold
  Quantum:        'Aoede',      // crisp, precise
  Viral:          'Puck',       // upbeat
};

// Humanize the title — the raw title contains em-dashes, slash separators,
// and unit notation that TTS pronounces awkwardly. Normalize for speech.
function spokenTitle(t) {
  return String(t || '')
    .replace(/—|–/g, ': ')
    .replace(/\$(\d+)B\b/g, '$1 billion dollars')
    .replace(/\$(\d+)M\b/g, '$1 million dollars')
    .replace(/\$(\d+(?:\.\d+)?)/g, '$1 dollars')
    .replace(/(\d+)K\b/g, '$1 thousand')
    .replace(/(\d+)x\b/gi, '$1 times')
    .replace(/%/g, ' percent')
    .replace(/\bvs\.?\b/gi, 'versus')
    .replace(/\//g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function spokenBeat(s) {
  return spokenTitle(s).replace(/\s*;\s*/g, '. ');
}

function narrationFromItem(item) {
  const title = spokenTitle(item.title || '');
  const sentences = String(item.summary || '')
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean);
  const beats = [];
  let buf = '';
  for (const s of sentences) {
    if ((buf + ' ' + s).trim().length > 220 && buf) { beats.push(buf.trim()); buf = s; }
    else buf = buf ? buf + ' ' + s : s;
    if (beats.length >= 2) break;
  }
  if (buf) beats.push(buf.trim());

  const body = [title + '.', ...beats.slice(0, 2).map(spokenBeat)]
    .filter(Boolean)
    .join(' ');
  return body;
}

// Wrap the spoken body with a delivery direction prepended — Gemini TTS
// honors style prompts that precede the content. The direction is not read
// aloud, so the transcript still matches the spoken body.
function ttsPromptFromItem(item) {
  const direction = 'Read the following as a warm, engaged tech news anchor — natural conversational pacing with varied intonation, brief natural pauses between sentences, never monotone, never robotic:';
  return `${direction} ${narrationFromItem(item)}`;
}

function wrapPcmAsWav(pcm, sampleRate = 24000, numChannels = 1, bitsPerSample = 16) {
  const byteRate   = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize   = pcm.length;
  const headerSize = 44;
  const buf = Buffer.alloc(headerSize + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);               // PCM
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  pcm.copy(buf, headerSize);
  return buf;
}

async function synthesize(item) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set in .env');

  if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });

  const spoken = narrationFromItem(item);
  const text = ttsPromptFromItem(item);
  const voice = process.env.GEMINI_TTS_VOICE || VOICES[item.category] || 'Enceladus';
  const model = process.env.GEMINI_TTS_MODEL || 'gemini-3.1-flash-tts-preview';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const body = {
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
      },
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini TTS ${res.status}: ${errText.slice(0, 300)}`);
  }
  const json = await res.json();
  const part = json.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
  const b64 = part?.inlineData?.data;
  const mime = part?.inlineData?.mimeType || '';
  if (!b64) throw new Error('no audio in response: ' + JSON.stringify(json).slice(0, 300));

  const pcm = Buffer.from(b64, 'base64');
  const sampleRateMatch = mime.match(/rate=(\d+)/);
  const sampleRate = sampleRateMatch ? Number(sampleRateMatch[1]) : 24000;
  const wav = wrapPcmAsWav(pcm, sampleRate);

  const outPath = path.join(AUDIO_DIR, `${item.id}.wav`);
  fs.writeFileSync(outPath, wav);
  const durationSec = pcm.length / (sampleRate * 2);
  // `script` is the SPOKEN body only — safe to feed into alignPhrases().
  // `prompt` is what we actually sent to the model (includes style direction).
  return { path: outPath, rel: `audio/${item.id}.wav`, durationSec, script: spoken, prompt: text, voice, model };
}

module.exports = { synthesize, narrationFromItem, ttsPromptFromItem };

if (require.main === module) {
  (async () => {
    const id = process.argv[2];
    if (!id) { console.error('usage: node presentations/tts.js <item-id>'); process.exit(1); }
    const all = [
      ...JSON.parse(fs.readFileSync(path.join(ROOT, 'posts.json'), 'utf8')),
      ...JSON.parse(fs.readFileSync(path.join(ROOT, 'queue.json'), 'utf8')),
    ];
    const item = all.find(x => x.id === id);
    if (!item) { console.error('no item:', id); process.exit(2); }
    try {
      const r = await synthesize(item);
      console.log(JSON.stringify({ ok: true, ...r }, null, 2));
    } catch (e) {
      console.error('TTS failed:', e.message);
      process.exit(3);
    }
  })();
}
