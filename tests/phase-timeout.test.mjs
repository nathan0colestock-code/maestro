// M-I-05: withPhaseTimeout — race a phase against a deadline, typed error
// on timeout, clears the timer on normal resolution.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { withPhaseTimeout } from '../local/phase-timeout.js';

describe('withPhaseTimeout', () => {
  test('resolves when phase finishes before timeout', async () => {
    const r = await withPhaseTimeout('x', Promise.resolve(42), 500);
    assert.equal(r, 42);
  });

  test('rejects with PHASE_TIMEOUT when phase exceeds deadline', async () => {
    const slow = new Promise(r => setTimeout(() => r('too late'), 200));
    await assert.rejects(
      withPhaseTimeout('deploy', slow, 50),
      (err) => {
        assert.equal(err.code, 'PHASE_TIMEOUT');
        assert.equal(err.phase, 'deploy');
        assert.match(err.message, /timed out/);
        return true;
      },
    );
  });

  test('propagates rejection of the underlying phase', async () => {
    const rejected = Promise.reject(new Error('boom'));
    await assert.rejects(withPhaseTimeout('x', rejected, 500), /boom/);
  });
});
