// Deploy + health-check + auto-revert helper for the Maestro overnight loop.
//
// Called by the daemon AFTER a feature set is merged to main. Runs `fly deploy`
// on the target app, polls /api/status until it returns { ok: true }, and if
// the health check fails it rolls back both Fly (`fly releases rollback`) and
// git (creates a revert commit on main). The feature set is marked
// `deploy_failed_reverted` so Maestro can surface it for re-work.
//
// Production safety: the goal is "user's apps are always up". If a deploy is
// bad, we revert rather than leave broken code in prod.

import { exec as execCallback } from 'child_process';
import { promisify } from 'util';
import { getFlyApp, getProjectPath } from './executor.js';

const exec = promisify(execCallback);

const SUITE_API_KEY = process.env.SUITE_API_KEY || '';
const HEALTH_CHECK_ATTEMPTS = 24; // 24 × 5s = 2 min max wait
const HEALTH_CHECK_INTERVAL_MS = 5_000;
const FLY_DEPLOY_TIMEOUT_MS = 600_000; // 10 min
const FLY_ROLLBACK_TIMEOUT_MS = 180_000; // 3 min

// maestro cloud deploys from maestro/cloud, not the repo root.
function getDeployCwd(projectName) {
  if (projectName === 'maestro') return '/Users/nathancolestock/maestro/cloud';
  return getProjectPath(projectName);
}

async function healthCheck(flyApp) {
  const url = `https://${flyApp}.fly.dev/api/status`;
  for (let i = 0; i < HEALTH_CHECK_ATTEMPTS; i++) {
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${SUITE_API_KEY}` },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const body = await res.json();
        if (body?.ok === true) return { ok: true, body };
      }
    } catch { /* transient, keep polling */ }
    await new Promise(r => setTimeout(r, HEALTH_CHECK_INTERVAL_MS));
  }
  return { ok: false, error: `health check failed after ${HEALTH_CHECK_ATTEMPTS} attempts` };
}

async function flyRollback(flyApp) {
  try {
    const { stdout } = await exec(
      `fly releases rollback -a ${flyApp} --yes`,
      { timeout: FLY_ROLLBACK_TIMEOUT_MS }
    );
    return { ok: true, stdout };
  } catch (err) {
    return { ok: false, error: err.stderr?.toString() || err.message };
  }
}

async function gitRevertMerge(projectPath, mergeSha) {
  try {
    // -m 1 picks the first parent (main) as the "mainline" side to preserve.
    await exec(
      `cd "${projectPath}" && git revert -m 1 --no-edit ${mergeSha}`,
      { timeout: 60_000 }
    );
    // Push the revert so remote matches local.
    await exec(
      `cd "${projectPath}" && git push origin main`,
      { timeout: 60_000 }
    ).catch(() => {}); // push is best-effort; local revert is what matters
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.stderr?.toString() || err.message };
  }
}

async function getLastMergeSha(projectPath) {
  try {
    const { stdout } = await exec(
      `cd "${projectPath}" && git log -1 --merges --format=%H`,
      { timeout: 10_000 }
    );
    return stdout.trim() || null;
  } catch { return null; }
}

// Deploy a single project to Fly, health-check, auto-revert on failure.
// Returns { ok, deployedAt?, revertedAt?, error?, flyApp, skipped? }.
export async function deployProject(projectName) {
  const flyApp = getFlyApp(projectName);
  if (!flyApp) return { ok: true, skipped: 'no-fly-app-mapping', projectName };

  const cwd = getDeployCwd(projectName);
  if (!cwd) return { ok: false, error: `no deploy cwd for ${projectName}`, flyApp };

  const projectPath = getProjectPath(projectName);
  const mergeSha = projectPath ? await getLastMergeSha(projectPath) : null;

  console.log(`[deploy] ${projectName} → ${flyApp} (cwd: ${cwd}${mergeSha ? `, merge ${mergeSha.slice(0, 8)}` : ''})`);

  // Phase 1: fly deploy
  let deployStdout = '', deployStderr = '';
  try {
    const r = await exec(
      `cd "${cwd}" && fly deploy -a ${flyApp} --wait-timeout 300`,
      { timeout: FLY_DEPLOY_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 }
    );
    deployStdout = r.stdout;
    deployStderr = r.stderr;
  } catch (err) {
    console.error(`[deploy] ${flyApp} fly-deploy failed:`, err.message);
    // fly deploy itself failed — nothing to roll back (no bad release live).
    // But the merge on git is still in place. Revert it so main matches prod.
    if (mergeSha && projectPath) {
      const rev = await gitRevertMerge(projectPath, mergeSha);
      return {
        ok: false, flyApp, projectName,
        error: `fly deploy failed: ${err.message}`,
        git_revert: rev,
      };
    }
    return { ok: false, flyApp, projectName, error: `fly deploy failed: ${err.message}` };
  }

  // Phase 2: health check
  const health = await healthCheck(flyApp);
  if (health.ok) {
    console.log(`[deploy] ${flyApp} ✓ healthy`);
    return {
      ok: true, flyApp, projectName,
      deployedAt: new Date().toISOString(),
      status_body: health.body,
    };
  }

  // Phase 3: deploy succeeded but health failed — roll back fly + git.
  console.error(`[deploy] ${flyApp} ✗ unhealthy — reverting`);
  const fly = await flyRollback(flyApp);
  let git = { skipped: 'no-merge-sha' };
  if (mergeSha && projectPath) {
    git = await gitRevertMerge(projectPath, mergeSha);
  }
  // Give the rolled-back release a moment to be live, then re-check.
  const postRevert = await healthCheck(flyApp);
  return {
    ok: false, flyApp, projectName,
    error: 'post-deploy health check failed',
    revertedAt: new Date().toISOString(),
    fly_rollback: fly,
    git_revert: git,
    post_revert_healthy: postRevert.ok,
  };
}

// Deploy a list of project names sequentially (safer than parallel — fly can
// get rate-limited on concurrent deploys from the same account).
export async function deployProjects(projectNames) {
  const results = [];
  for (const name of projectNames) {
    results.push(await deployProject(name));
  }
  const failed = results.filter(r => !r.ok && !r.skipped);
  return { ok: failed.length === 0, results, failed };
}
