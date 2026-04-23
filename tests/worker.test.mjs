// Unit tests for worker.js — we only test the pure parsing + prompt-building
// pieces; actually spawning `claude -p` is an integration concern exercised
// manually via the dashboard.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerSource = readFileSync(join(__dirname, '..', 'local', 'worker.js'), 'utf8');

// The worker.js module doesn't export parseQuestions, so reimplement the exact
// regex here and assert its behaviour. If worker.js changes its pattern, update
// here — this test pins the contract.
function parseQuestions(summary) {
  if (!summary) return [];
  const out = [];
  for (const line of summary.split('\n')) {
    const m = line.match(/^\s*QUESTION:\s*(.+)\s*$/i);
    if (m) out.push(m[1].trim());
  }
  return out;
}

describe('worker QUESTION parsing', () => {
  test('the test matches the implementation in worker.js', () => {
    // Guard rail: if worker.js regex drifts, this test reminds us to update.
    assert.match(workerSource, /\^\\s\*QUESTION:\\s\*\(\.\+\)\\s\*\$/i,
      'worker.js QUESTION regex must match the one pinned here');
  });

  test('extracts a single question at the end of summary', () => {
    const s = 'Did some work.\nQUESTION: should the button be blue?';
    assert.deepEqual(parseQuestions(s), ['should the button be blue?']);
  });

  test('extracts multiple questions', () => {
    const s = 'Stuck.\nQUESTION: first?\nQUESTION: second?\nQUESTION: third?';
    assert.deepEqual(parseQuestions(s), ['first?', 'second?', 'third?']);
  });

  test('ignores lines without QUESTION: prefix', () => {
    const s = 'I question the design.\nSome note.\nQUESTION: real one?';
    assert.deepEqual(parseQuestions(s), ['real one?']);
  });

  test('handles leading whitespace', () => {
    const s = '   QUESTION:   indented with spaces?   ';
    assert.deepEqual(parseQuestions(s), ['indented with spaces?']);
  });

  test('is case-insensitive for the prefix', () => {
    const s = 'question: lower?\nQuestion: mixed?';
    assert.deepEqual(parseQuestions(s), ['lower?', 'mixed?']);
  });

  test('returns empty array for empty / null summary', () => {
    assert.deepEqual(parseQuestions(''), []);
    assert.deepEqual(parseQuestions(null), []);
    assert.deepEqual(parseQuestions(undefined), []);
  });

  test('returns empty when no QUESTION: lines', () => {
    assert.deepEqual(parseQuestions('Just a normal summary.\nMore text.'), []);
  });
});

describe('worker exports', () => {
  test('module exports getActiveRunCount, hasActiveWorker, startWorker', async () => {
    const mod = await import('../local/worker.js');
    assert.equal(typeof mod.startWorker, 'function');
    assert.equal(typeof mod.getActiveRunCount, 'function');
    assert.equal(typeof mod.hasActiveWorker, 'function');
  });

  test('getActiveRunCount returns 0 for unknown project', async () => {
    const mod = await import('../local/worker.js');
    assert.equal(mod.getActiveRunCount('never-heard-of-this'), 0);
    assert.equal(mod.hasActiveWorker('never-heard-of-this'), false);
  });
});
