// Taste classifier wrapper.
// Delegates training + scoring to Python (nanolearn's PrototypeTextMahalanobis
// port in classifier/). Uses nanolearn's venv to avoid duplicating ~3GB of deps.

const path = require('path');
const { spawnSync } = require('child_process');
const fs = require('fs');

const PYTHON = '/Users/adan/work/claude/code/nanolearn/.venv/bin/python';
const CLASSIFIER_DIR = path.join(__dirname, 'classifier');
const TRAIN_PY = path.join(CLASSIFIER_DIR, 'train.py');
const SCORE_PY = path.join(CLASSIFIER_DIR, 'score.py');
const MODEL_PATH = path.join(CLASSIFIER_DIR, 'model.npz');

function available() {
  return fs.existsSync(PYTHON) && fs.existsSync(TRAIN_PY);
}

function modelExists() {
  return fs.existsSync(MODEL_PATH);
}

function train() {
  if (!available()) return { ok: false, error: 'classifier not installed' };
  const r = spawnSync(PYTHON, [TRAIN_PY], { cwd: __dirname, encoding: 'utf8' });
  if (r.status !== 0) {
    return { ok: false, error: (r.stderr || '').trim() || `exit ${r.status}` };
  }
  try {
    return { ok: true, report: JSON.parse(r.stdout.trim()) };
  } catch {
    return { ok: true, report: { raw: r.stdout.trim() } };
  }
}

function scoreItems(items) {
  if (!available() || !modelExists() || !items || !items.length) return {};
  const r = spawnSync(PYTHON, [SCORE_PY], {
    cwd: __dirname,
    encoding: 'utf8',
    input: JSON.stringify(items),
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status !== 0) return {};
  try {
    const arr = JSON.parse(r.stdout.trim());
    const byId = {};
    for (const row of arr) byId[row.id] = row;
    return byId;
  } catch {
    return {};
  }
}

module.exports = { available, modelExists, train, scoreItems };
