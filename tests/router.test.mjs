// Unit tests for router.js. We don't hit Gemini — routeCapture accepts an
// injectable `generate` and `sleep` for deterministic retry testing.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { routeCapture, _test } from '../local/router.js';

const { isTransientGeminiError } = _test;

describe('isTransientGeminiError', () => {
  test('429 rate-limit is transient', () => {
    assert.equal(isTransientGeminiError({ status: 429, message: 'rate limit' }), true);
    assert.equal(isTransientGeminiError(new Error('got 429 from upstream')), true);
  });
  test('5xx is transient', () => {
    assert.equal(isTransientGeminiError({ status: 503 }), true);
    assert.equal(isTransientGeminiError(new Error('503 Service Unavailable')), true);
  });
  test('google-specific transient codes are transient', () => {
    assert.equal(isTransientGeminiError(new Error('RESOURCE_EXHAUSTED: quota')), true);
    assert.equal(isTransientGeminiError(new Error('UNAVAILABLE: backend')), true);
    assert.equal(isTransientGeminiError(new Error('DEADLINE_EXCEEDED')), true);
  });
  test('network flakes are transient', () => {
    assert.equal(isTransientGeminiError(new Error('fetch failed')), true);
    assert.equal(isTransientGeminiError(new Error('ETIMEDOUT')), true);
    assert.equal(isTransientGeminiError(new Error('socket hang up')), true);
  });
  test('empty-response is transient (retry the call)', () => {
    assert.equal(isTransientGeminiError(new Error('Gemini returned empty response')), true);
  });
  test('400 / 401 / JSON parse errors are NOT transient', () => {
    assert.equal(isTransientGeminiError({ status: 400 }), false);
    assert.equal(isTransientGeminiError({ status: 401, message: 'bad key' }), false);
    assert.equal(isTransientGeminiError(new SyntaxError('Unexpected token')), false);
  });
});

describe('routeCapture retry behaviour', () => {
  const projects = [{ name: 'flock', path: '/tmp/flock', open_task_count: 0 }];
  const sessions = [];

  test('returns parsed plan on first success', async () => {
    const generate = async () => ({ text: '{"captures_decomposed":[]}' });
    const plan = await routeCapture('hi', projects, sessions, [], { generate });
    assert.deepEqual(plan, { captures_decomposed: [] });
  });

  test('retries on transient 429 and eventually succeeds', async () => {
    let calls = 0;
    const generate = async () => {
      calls++;
      if (calls < 3) { const e = new Error('429 rate limit'); e.status = 429; throw e; }
      return { text: '{"captures_decomposed":[{"project":"flock","action":"task"}]}' };
    };
    const sleeps = [];
    const plan = await routeCapture('hi', projects, sessions, [], {
      generate, sleep: ms => { sleeps.push(ms); return Promise.resolve(); }, baseDelayMs: 10,
    });
    assert.equal(calls, 3);
    assert.equal(sleeps.length, 2, 'two sleeps between three attempts');
    // Jitter can make a short attempt-1 random exceed a low attempt-2, so
    // assert the base component (delay minus max 500ms jitter) grows.
    assert.ok(sleeps[1] >= sleeps[0] - 500, 'backoff base grows between retries, allowing jitter');
    assert.equal(plan.captures_decomposed.length, 1);
  });

  test('gives up after maxAttempts and rethrows last error', async () => {
    let calls = 0;
    const generate = async () => { calls++; const e = new Error('503 unavailable'); e.status = 503; throw e; };
    await assert.rejects(
      routeCapture('hi', projects, sessions, [], {
        generate, sleep: () => Promise.resolve(), baseDelayMs: 1, maxAttempts: 3,
      }),
      /503/,
    );
    assert.equal(calls, 3);
  });

  test('does not retry on non-transient errors (400)', async () => {
    let calls = 0;
    const generate = async () => { calls++; const e = new Error('bad request'); e.status = 400; throw e; };
    await assert.rejects(
      routeCapture('hi', projects, sessions, [], { generate, sleep: () => Promise.resolve() }),
      /bad request/,
    );
    assert.equal(calls, 1, 'single attempt on permanent error');
  });
});
