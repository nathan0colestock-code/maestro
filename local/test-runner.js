// Run a project's test suite and integration tests from the daemon.
//
// Two levels:
//   - runProjectTests(projectName): runs the project's own `npm test` (or
//     `node --test tests/`) — used as a pre-merge gate after a worker finishes.
//   - runIntegrationTests(): runs the suite-wide integration tests that live
//     in maestro/tests/integration — used as a post-deploy smoke test.
//
// Test failures here translate to feature-set statuses `test_failed` (pre-merge)
// or `integration_failed` (post-deploy).

import { exec as execCallback } from 'child_process';
import { promisify } from 'util';
import { getProjectPath } from './executor.js';

const exec = promisify(execCallback);

const PROJECT_TEST_TIMEOUT_MS = 180_000; // 3 min
const INTEGRATION_TEST_TIMEOUT_MS = 300_000; // 5 min

const MAESTRO_ROOT = '/Users/nathancolestock/maestro';

// Run the project's own test suite on the CURRENTLY CHECKED-OUT branch.
// Caller is responsible for checking out the branch/ref first.
export async function runProjectTests(projectName) {
  const projectPath = projectName === 'maestro' ? MAESTRO_ROOT : getProjectPath(projectName);
  if (!projectPath) {
    return { ok: false, error: `no project path for ${projectName}`, skipped: false };
  }

  // Check package.json for a test script; if none, skip (some projects legitimately
  // have no tests yet).
  let hasTestScript = false;
  try {
    const { stdout } = await exec(
      `cd "${projectPath}" && node -e "console.log(!!require('./package.json').scripts?.test)"`,
      { timeout: 5_000 }
    );
    hasTestScript = stdout.trim() === 'true';
  } catch { /* package.json unreadable — treat as no tests */ }

  if (!hasTestScript) {
    return { ok: true, skipped: 'no-test-script', projectName };
  }

  try {
    const { stdout, stderr } = await exec(
      `cd "${projectPath}" && npm test`,
      { timeout: PROJECT_TEST_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 }
    );
    return { ok: true, projectName, stdout, stderr };
  } catch (err) {
    return {
      ok: false,
      projectName,
      error: `tests failed (exit ${err.code ?? '?'})`,
      stdout: err.stdout || '',
      stderr: err.stderr || '',
    };
  }
}

// Run the suite-wide integration tests. These probe the DEPLOYED apps to
// verify cross-app contracts still hold (e.g. gloss can push a contact to
// comms, scribe can read gloss collections, maestro can poll everyone's
// /api/status). See maestro/tests/integration/README.md.
export async function runIntegrationTests() {
  try {
    const { stdout, stderr } = await exec(
      `cd "${MAESTRO_ROOT}" && node --test --test-reporter=spec tests/integration/*.test.mjs`,
      {
        timeout: INTEGRATION_TEST_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env }, // inherit SUITE_API_KEY + app URLs
      }
    );
    return { ok: true, stdout, stderr };
  } catch (err) {
    return {
      ok: false,
      error: `integration tests failed (exit ${err.code ?? '?'})`,
      stdout: err.stdout || '',
      stderr: err.stderr || '',
    };
  }
}

// Does this repo have a local branch with the given name? Used to decide
// whether a peer repo should be tested as part of an integration feature-set:
// only repos that actually participate (i.e. carry the branch) are tested.
export async function branchExists(projectPath, branchName) {
  try {
    await exec(
      `cd "${projectPath}" && git show-ref --verify --quiet refs/heads/${branchName}`,
      { timeout: 10_000 }
    );
    return true;
  } catch {
    return false;
  }
}

// Checkout a branch in a repo (used before runProjectTests on a feature-set branch).
// Restores the repo to `main` afterwards via the returned restore() callback.
export async function checkoutBranch(projectPath, branchName) {
  const stashLabel = `maestro-checkout-${Date.now()}`;
  let stashed = false;
  try {
    const { stdout: before } = await exec(
      `cd "${projectPath}" && git rev-parse --abbrev-ref HEAD`,
      { timeout: 10_000 }
    );
    // Stash stray edits so the checkout doesn't fail on dirty tree.
    const { stdout: dirty } = await exec(
      `cd "${projectPath}" && git status --porcelain`,
      { timeout: 10_000 }
    );
    if (dirty.trim()) {
      await exec(
        `cd "${projectPath}" && git stash push -u -m "${stashLabel}"`,
        { timeout: 15_000 }
      );
      stashed = true;
    }
    try {
      await exec(
        `cd "${projectPath}" && git checkout ${branchName}`,
        { timeout: 30_000 }
      );
    } catch (err) {
      // Unwind the stash if checkout fails so the caller sees their tree back.
      if (stashed) {
        await exec(`cd "${projectPath}" && git stash pop`, { timeout: 15_000 }).catch(() => {});
      }
      throw err;
    }
    return {
      ok: true,
      previousBranch: before.trim(),
      restore: async () => {
        await exec(
          `cd "${projectPath}" && git checkout ${before.trim()}`,
          { timeout: 30_000 }
        ).catch(() => {});
        if (stashed) {
          await exec(`cd "${projectPath}" && git stash pop`, { timeout: 15_000 }).catch(err => {
            console.warn(
              `[checkout] post-test stash pop conflicted in ${projectPath} — ` +
              `stash "${stashLabel}" kept; recover with \`git -C ${projectPath} stash list\`. ` +
              `err: ${err.stderr?.toString() || err.message}`
            );
          });
        }
      },
    };
  } catch (err) {
    return { ok: false, error: err.stderr?.toString() || err.message };
  }
}
