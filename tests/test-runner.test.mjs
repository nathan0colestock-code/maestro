// Unit tests for test-runner.js. Focuses on: picks right command per project,
// handles missing test script gracefully, reports failure details.

import { test } from 'node:test';
import assert from 'node:assert';
import { runProjectTests } from '../local/test-runner.js';

test('runProjectTests: unknown project returns error, not crash', async () => {
  const r = await runProjectTests('not-a-real-project-xyz');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /no project path/);
});
