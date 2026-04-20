// Tweet reviser powered by `claude -p` (subprocess).
// Uses the user's local Claude Code CLI — no new API key needed.
// Given item context + current draft + an instruction (plus optional chat
// history), returns a revised draft that obeys X's rules.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const CLAUDE_BIN = process.env.CLAUDE_BIN || '/Users/adan/.local/bin/claude';
const CLAUDE_MODEL = process.env.CLAUDE_TWEET_MODEL || 'haiku';

const URL_WEIGHT = 23;
function xCharCount(text) {
  return text.replace(/https?:\/\/\S+/g, 'x'.repeat(URL_WEIGHT)).length;
}

function systemPromptFor(item) {
  return [
    'You are rewriting tweets for @KryptonAi — a human-run tech news feed. Your job is to make the draft sound like a person typed it, not an AI content machine.',
    '',
    `Budget: up to ${TWEET_MAX} characters (X Premium; URLs count as 23 chars).`,
    '',
    'HARD RULES',
    '1. Preserve every concrete number from the source — percentages, dollar amounts, multipliers, star counts. Never invent numbers.',
    '2. Keep the primary-source URL on its own line at the end unless the user explicitly removes it.',
    '3. Output ONLY the revised tweet text. No preface ("Here\'s..."), no quotes around it, no markdown fences, no commentary.',
    '',
    'BANNED — these read as AI slop, never use them',
    '• Labels: "Why it matters", "Why it matters ↓", "The numbers:", "Translation:", "TL;DR:", "Bottom line:", "Key takeaway:", "In short:"',
    '• Marketing vocabulary: "game-changer", "revolutionary", "groundbreaking", "cutting-edge", "state-of-the-art", "paradigm shift", "leverage", "synergy", "disrupt/disruption", "unprecedented", "world-class"',
    '• Predictive filler: "Expect X within N days", "Watch this space", "This is only the beginning"',
    '• Emoji scaffolding (📊 ✨ 🚀 🔥 lines). At most ONE emoji in the whole tweet, only if it earns its place.',
    '• Repetitive starters ("This means...", "This is...", "This marks...")',
    '• "->" arrows, "|" separators, ALL-CAPS shouting',
    '',
    'VOICE',
    '• Sound like a knowledgeable person typing one-handed, not an agency template.',
    '• Vary sentence length — mix short punches with fuller sentences.',
    '• Concrete over abstract: "73.4 on SWE-bench Verified" beats "strong coding scores."',
    '• Opinions and reactions are welcome when the facts support them.',
    '• Contractions are fine (it\'s, that\'s, they\'ve). Write how people talk.',
    '• Lead with the most striking fact, not a formula.',
    '',
    'SHAPE (flexible — follow the content, not a rigid template)',
    '• Open with one crisp line — the news itself, or the most striking stat.',
    '• Middle: concrete details woven into prose. Line breaks between sentences when each deserves its own weight.',
    '• If the piece earns a closing thought, add one short line. No label, just the thought.',
    '• End with the URL on its own line.',
    '',
    'NEWS CONTEXT:',
    `Title: ${item.title || ''}`,
    `Summary: ${item.summary || ''}`,
    `Category: ${item.category || ''}`,
    `Source: ${item.source || ''}`,
    `Primary URL: ${item.primarySource || item.url || ''}`,
    `Why It Matters: ${item.whyItMatters || ''}`,
  ].join('\n');
}

function buildUserMessage({ currentText, instruction, history = [] }) {
  const parts = [];
  if (history.length) {
    parts.push('PREVIOUS CONVERSATION:');
    for (const turn of history) {
      const who = turn.role === 'assistant' || turn.role === 'model' ? 'YOU' : 'USER';
      parts.push(`${who}: ${turn.text}`);
    }
    parts.push('');
  }
  parts.push('CURRENT DRAFT:');
  parts.push(currentText);
  parts.push('');
  parts.push('INSTRUCTION:');
  parts.push(instruction);
  parts.push('');
  parts.push('Reply with ONLY the revised tweet text. Nothing else.');
  return parts.join('\n');
}

function runClaude({ systemPrompt, userMessage, model, timeoutMs = 60000 }) {
  return new Promise((resolve, reject) => {
    // Note: cannot use --bare because that requires an explicit
    // ANTHROPIC_API_KEY. The user's CLI is OAuth-logged, so we run the
    // default mode which uses the existing session credentials.
    const args = [
      '-p',
      '--model', model,
      '--append-system-prompt', systemPrompt,
      '--output-format', 'text',
      '--disallowedTools', 'Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,Agent,Task',
    ];
    const proc = spawn(CLAUDE_BIN, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    const to = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      reject(new Error(`claude timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.on('close', code => {
      clearTimeout(to);
      if (code !== 0) return reject(new Error(`claude exit ${code}: ${stderr.slice(-500)}`));
      resolve(stdout);
    });
    proc.on('error', reject);
    proc.stdin.end(userMessage);
  });
}

async function revise({ item, currentText, instruction, history = [] }) {
  const systemPrompt = systemPromptFor(item);
  const userMessage = buildUserMessage({ currentText, instruction, history });
  const raw = await runClaude({ systemPrompt, userMessage, model: CLAUDE_MODEL });
  const cleaned = raw
    .trim()
    .replace(/^```[\w]*\n?|\n?```$/g, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();
  const chars = xCharCount(cleaned);
  return { text: cleaned, chars, overLimit: chars > TWEET_MAX };
}

module.exports = { revise, xCharCount };

if (require.main === module) {
  (async () => {
    const id = process.argv[2];
    const instruction = process.argv.slice(3).join(' ') || 'Make it punchier.';
    if (!id) { console.error('usage: node tweet-chat.js <id> <instruction>'); process.exit(1); }
    const all = [
      ...JSON.parse(fs.readFileSync('posts.json', 'utf8')),
      ...JSON.parse(fs.readFileSync('queue.json', 'utf8')),
    ];
    const item = all.find(x => x.id === id);
    if (!item) { console.error('no item'); process.exit(2); }
    const { composeTweet } = require('./tweet');
    const currentText = composeTweet(item);
    console.log('BEFORE:\n' + currentText);
    console.log('---');
    try {
      const r = await revise({ item, currentText, instruction, history: [] });
      console.log('AFTER:\n' + r.text);
      console.log(`--- chars: ${r.chars}${r.overLimit ? ' (OVER LIMIT)' : ''}`);
    } catch (e) {
      console.error('revise failed:', e.message);
      process.exit(3);
    }
  })();
}
