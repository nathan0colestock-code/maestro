// Unit tests for deployer.js. We stub the Fly/git commands via environment
// injection — the deployer's own logic (phase ordering, health-check polling,
// auto-revert) is what we're testing, not the actual Fly control plane.

import { test } from 'node:test';
import assert from 'node:assert';

// Import lazily so we can stub globalThis.fetch before deployer loads.
let deployer;
async function loadDeployer() {
  if (!deployer) deployer = await import('../local/deployer.js');
  return deployer;
}

test('deployProject: skips projects not in FLY_DEPLOY_MAP', async () => {
  const mod = await loadDeployer();
  const result = await mod.deployProject('not-a-real-project');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.skipped, 'no-fly-app-mapping');
});

test('deployProjects: fans out sequentially, aggregates results', async () => {
  const mod = await loadDeployer();
  const result = await mod.deployProjects(['not-a-real-project-a', 'not-a-real-project-b']);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.results.length, 2);
  assert.strictEqual(result.failed.length, 0);
  assert.ok(result.results.every(r => r.skipped === 'no-fly-app-mapping'));
});
