import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildValidatorPrompt,
  parseDecision,
  validate,
  validateAll,
} from '../local/opus-validator.js';

test('buildValidatorPrompt includes target + current code + patch hint', () => {
  const p = buildValidatorPrompt({
    suggestion: {
      target_file: 'local/router.js',
      description: 'Add retry',
      patch_hint: 'wrap Gemini call in withRetry()',
      confidence: 0.9,
    },
    currentCode: 'export function routeCapture() {}',
    recentLog: 'abc feat: router refactor',
  });
  assert.match(p, /local\/router\.js/);
  assert.match(p, /Add retry/);
  assert.match(p, /wrap Gemini call/);
  assert.match(p, /export function routeCapture/);
  assert.match(p, /abc feat: router refactor/);
});

test('parseDecision: approve JSON', () => {
  const r = parseDecision('{"decision":"approve","reason":"looks good"}');
  assert.equal(r.decision, 'approve');
  assert.equal(r.reason, 'looks good');
});

test('parseDecision: refine requires refined_hint', () => {
  assert.throws(() => parseDecision('{"decision":"refine","reason":"stale"}'));
  const r = parseDecision('{"decision":"refine","reason":"stale","refined_hint":"do X instead"}');
  assert.equal(r.decision, 'refine');
  assert.equal(r.refined_hint, 'do X instead');
});

test('parseDecision: tolerates markdown fences', () => {
  const raw = '```json\n{"decision":"skip","reason":"already done"}\n```';
  const r = parseDecision(raw);
  assert.equal(r.decision, 'skip');
});

test('parseDecision: tolerates prose + JSON', () => {
  const raw = 'I think this is already done.\n{"decision":"skip","reason":"already done"}\n';
  const r = parseDecision(raw);
  assert.equal(r.decision, 'skip');
});

test('parseDecision: invalid decision throws', () => {
  assert.throws(() => parseDecision('{"decision":"maybe","reason":"idk"}'));
});

test('parseDecision: no JSON throws', () => {
  assert.throws(() => parseDecision('looking at the code, it seems fine'));
});

test('validate: no target_file returns skip', async () => {
  const v = await validate({});
  assert.equal(v.decision, 'skip');
  assert.match(v.reason, /no target_file/);
});

test('validate: unreadable file returns skip', async () => {
  const v = await validate(
    { target_file: 'does/not/exist.js' },
    { readFileImpl: async () => { const e = new Error('nope'); e.code = 'ENOENT'; throw e; } },
  );
  assert.equal(v.decision, 'skip');
  assert.match(v.reason, /unreadable/);
});

test('validate: approve path passes current code to runner', async () => {
  let captured = null;
  const runClaude = async (sys, user) => {
    captured = user;
    return '{"decision":"approve","reason":"looks good"}';
  };
  const v = await validate(
    { target_file: 'local/router.js', description: 'add retry', patch_hint: 'wrap' },
    {
      readFileImpl: async () => 'CURRENT CODE CONTENT',
      runClaude,
    },
  );
  assert.equal(v.decision, 'approve');
  assert.match(captured, /CURRENT CODE CONTENT/);
  assert.match(captured, /wrap/);
});

test('validate: claude failure falls back to skip (fail-closed)', async () => {
  const runClaude = async () => { throw new Error('spawn failed'); };
  const v = await validate(
    { target_file: 'local/router.js', description: 'add retry' },
    {
      readFileImpl: async () => 'code',
      runClaude,
    },
  );
  assert.equal(v.decision, 'skip');
  assert.match(v.reason, /claude invocation failed/);
});

test('validate: parse error falls back to skip (fail-closed)', async () => {
  const runClaude = async () => 'Looking at the code, it seems fine';
  const v = await validate(
    { target_file: 'local/router.js', description: 'add retry' },
    {
      readFileImpl: async () => 'code',
      runClaude,
    },
  );
  assert.equal(v.decision, 'skip');
  assert.match(v.reason, /parse error/);
});

test('validateAll: sorts suggestions into kept vs dropped, refines patch_hint', async () => {
  const suggestions = [
    { target_file: 'local/router.js', description: 'r1', patch_hint: 'h1' },
    { target_file: 'local/worker.js', description: 'r2', patch_hint: 'h2' },
    { target_file: 'local/deployer.js', description: 'r3', patch_hint: 'old-hint' },
  ];
  const decisions = {
    'local/router.js':   '{"decision":"approve","reason":"ok"}',
    'local/worker.js':   '{"decision":"skip","reason":"already done"}',
    'local/deployer.js': '{"decision":"refine","reason":"stale","refined_hint":"NEW HINT"}',
  };
  let call = 0;
  const runClaude = async (_sys, user) => {
    call++;
    const f = suggestions[call - 1].target_file;
    return decisions[f];
  };
  const { kept, dropped } = await validateAll(suggestions, {
    readFileImpl: async () => 'x',
    runClaude,
  });
  assert.equal(kept.length, 2);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].target_file, 'local/worker.js');
  const refined = kept.find(k => k.target_file === 'local/deployer.js');
  assert.equal(refined.patch_hint, 'NEW HINT');
});
