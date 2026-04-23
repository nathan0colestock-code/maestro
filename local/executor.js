import { exec as execCallback } from 'child_process';
import { promisify } from 'util';
import { appendTask, appendNote, appendDocNote } from './doc-updater.js';
import { startWorker } from './worker.js';

const exec = promisify(execCallback);

const PROJECT_PATHS = {
  flock: '/Users/nathancolestock/flock',
  gloss: '/Users/nathancolestock/gloss',
  tend: '/Users/nathancolestock/tend',
  comms: '/Users/nathancolestock/comms',
  maestro: '/Users/nathancolestock/maestro',
  scribe: '/Users/nathancolestock/scribe',
  black: '/Users/nathancolestock/black',
};

// Suite deployment map: project name → Fly.io app name. Used by the deployer
// when closing the overnight loop. Projects not in this map won't auto-deploy
// (they're still orchestrated for local work).
const FLY_DEPLOY_MAP = {
  comms: 'comms-nc',
  gloss: 'gloss-nc',
  black: 'black-hole',
  scribe: 'scribe-nc',
  maestro: 'maestro-nc', // deploys the cloud subdirectory
};

const AUTO_LAUNCH = process.env.AUTO_LAUNCH_SESSIONS !== 'false';
const AUTO_MERGE_ON_TESTS_PASS = process.env.AUTO_MERGE_ON_TESTS_PASS === 'true';

export function isAutoLaunchEnabled() { return AUTO_LAUNCH; }
export function isAutoMergeEnabled() { return AUTO_MERGE_ON_TESTS_PASS; }
export function getProjectPath(name) { return PROJECT_PATHS[name]; }
export function getFlyApp(name) { return FLY_DEPLOY_MAP[name]; }

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'set';
}

// Legacy single-task dispatch (used by drainLegacyTasks for pre-feature-set tasks).
export async function dispatchTask({
  projectName, projectPath, taskId, text, context,
  priorQA = [], captureId = null,
  sessionStrategy = 'new_session', projectIsActive = false,
  fileToTasksMd = true, cloudApi, projectStats = null,
}) {
  if (fileToTasksMd) await appendTask(projectPath, text, context);

  const shouldWork = AUTO_LAUNCH && sessionStrategy === 'new_session' && !projectIsActive;
  if (!shouldWork) {
    return { status: projectIsActive ? 'queued_for_active_session' : 'queued' };
  }

  const meta = startWorker({
    projectName, projectPath, task: text, context, priorQA, projectStats,
    onStart: async ({ runId, sessionId, started }) => {
      await cloudApi?.('POST', '/api/worker/start', {
        run_id: runId, session_id: sessionId,
        project_name: projectName, capture_id: captureId, task_id: taskId,
        task: text, context, started_at: started,
      }).catch(err => console.error('  [worker] start notify failed:', err.message));
    },
    onEnd: async ({ runId, ended, status, summary, cost, durationMs, questions }) => {
      await cloudApi?.('POST', `/api/worker/${runId}/end`, {
        ended_at: ended, status, summary, cost_usd: cost, duration_ms: durationMs, questions,
      }).catch(err => console.error('  [worker] end notify failed:', err.message));
    },
  });
  return meta ? { status: 'worker_started', run_id: meta.runId } : { status: 'worker_busy_queued' };
}

// Feature-set bundle dispatch — one worker handles all tasks on one branch.
// For integration sets (extra_projects non-empty) the worker gets --add-dir
// for each peer project and is instructed to write a shared contract spec first.
export async function dispatchFeatureSet({ projectName, projectPath, featureSet, cloudApi, projectStats = null }) {
  if (!AUTO_LAUNCH) return { status: 'auto_launch_disabled' };

  const branch = `maestro/${slugify(featureSet.title)}`;
  const extras = Array.isArray(featureSet.extra_projects) ? featureSet.extra_projects : [];
  const extraPaths = extras.map(p => PROJECT_PATHS[p]).filter(Boolean);

  // Dedupe task rows by normalized (text, context). Absorbed feature sets
  // often contain N near-identical rows (one per per-project split the
  // router produced before we caught the fan-out) — rendering all N into
  // the worker prompt is noise that invites the model to over-scope.
  const seen = new Set();
  const taskLines = featureSet.tasks
    .filter(t => {
      const key = `${(t.text || '').trim().toLowerCase()}|${(t.context || '').trim().toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((t, i) => `${i + 1}. ${t.text}${t.context ? ` — ${t.context}` : ''}`).join('\n');

  const integrationSection = extras.length ? `

## Integration across projects

This feature set spans: **${projectName}** (primary, your cwd) + ${extras.map(p => `**${p}**`).join(', ')}.
Peer project directories are accessible via --add-dir:
${extraPaths.map((p, i) => `- ${extras[i]} → ${p}`).join('\n')}

Workflow:
1. **Write the contract first.** Create \`docs/INTEGRATIONS/${slugify(featureSet.title)}.md\` in the primary repo describing the API/schema/events both sides will speak. Reference any existing types or endpoints you find in the peer repos by reading their code.
2. **Create a \`${branch}\` branch in EVERY involved repo** (primary + each peer). For each peer, cd into its directory and run \`git checkout -b ${branch}\` (or \`git checkout ${branch}\` if it exists).
3. **Implement the callee/provider side first** (typically in ${projectName} since it owns the contract), commit.
4. **Implement the caller/consumer side(s)** in each peer repo, commit in each peer.
5. Do not push or merge — the developer reviews and merges from the Maestro UI.` : '';

  const bundlePrompt = `${featureSet.title}

${featureSet.description || ''}

Tasks in this feature set:
${taskLines}${integrationSection}

Create a branch named \`${branch}\` and implement all tasks on it. Commit each task (or logical chunk) separately with a clear message. Do not merge to main — the developer will review and merge themselves.`;

  const meta = startWorker({
    projectName, projectPath, task: bundlePrompt, context: null, priorQA: [],
    addDirs: extraPaths, peerProjects: extras, projectStats,
    onStart: async ({ runId, sessionId, started }) => {
      await cloudApi?.('POST', '/api/worker/start', {
        run_id: runId, session_id: sessionId, project_name: projectName,
        feature_set_id: featureSet.id,
        task: featureSet.title, context: featureSet.description,
        started_at: started,
      }).catch(err => console.error('  [worker] start notify failed:', err.message));
      await cloudApi?.('POST', `/api/feature-sets/${featureSet.id}/status`, {
        status: 'running', branch_name: branch, run_id: runId,
      }).catch(() => {});
    },
    onEnd: async ({ runId, ended, status, summary, cost, durationMs, questions }) => {
      await cloudApi?.('POST', `/api/worker/${runId}/end`, {
        ended_at: ended, status, summary, cost_usd: cost, duration_ms: durationMs, questions,
      }).catch(() => {});
      // When the worker reports 'done' AND the user has opted into full
      // autonomy (AUTO_MERGE_ON_TESTS_PASS=true), skip the "wait for the
      // developer to tap merge" step and promote the feature set directly to
      // merge_requested. The daemon's processMergeRequests loop will re-run
      // tests, merge, deploy, and auto-revert on failure.
      let fsStatus;
      if (status === 'done') {
        fsStatus = AUTO_MERGE_ON_TESTS_PASS ? 'merge_requested' : 'done';
        if (AUTO_MERGE_ON_TESTS_PASS) {
          console.log(`  [auto-merge] ${projectName} feature set #${featureSet.id} → merge_requested (AUTO_MERGE_ON_TESTS_PASS=true)`);
        }
      } else if (status === 'needs_answer') {
        fsStatus = 'needs_answer';
      } else {
        fsStatus = 'failed';
      }
      await cloudApi?.('POST', `/api/feature-sets/${featureSet.id}/status`, {
        status: fsStatus, branch_name: branch,
      }).catch(() => {});
    },
  });
  return meta ? { status: 'worker_started', run_id: meta.runId, branch } : { status: 'worker_busy_queued' };
}

async function mergeOne(projectPath, branchName) {
  await exec(`cd "${projectPath}" && git fetch --all --quiet || true`);
  const { stdout: curBranch } = await exec(`cd "${projectPath}" && git rev-parse --abbrev-ref HEAD`);
  if (curBranch.trim() !== 'main') {
    await exec(`cd "${projectPath}" && git checkout main`);
  }
  const { stdout: status } = await exec(`cd "${projectPath}" && git status --porcelain`);
  if (status.trim()) throw new Error(`working tree not clean in ${projectPath}`);
  // Only merge if the branch actually exists in this repo (peer repos may have
  // no changes and therefore no maestro branch).
  const { stdout: hasBranch } = await exec(`cd "${projectPath}" && git branch --list ${branchName}`);
  if (!hasBranch.trim()) return { skipped: true };
  await exec(`cd "${projectPath}" && git merge --no-ff --no-edit ${branchName}`);
  return { skipped: false };
}

// Local git merge across primary + any extra projects. No push.
export async function mergeFeatureSet({ projectPath, branchName, extraProjectPaths = [] }) {
  const targets = [projectPath, ...extraProjectPaths];
  const failures = [];
  const merged = [];
  for (const p of targets) {
    try {
      const r = await mergeOne(p, branchName);
      if (!r.skipped) merged.push(p);
    } catch (err) {
      failures.push({ path: p, error: err.stderr?.toString() || err.message });
    }
  }
  if (failures.length) return { ok: false, error: failures.map(f => `${f.path}: ${f.error}`).join('; '), merged };
  return { ok: true, merged };
}

// Capture → routing plan executor. Now feature-set aware.
export async function executeRoutingPlan(routingPlan, captureId, { cloudApi, sessionsByProject } = {}) {
  const { captures_decomposed } = routingPlan;
  if (!captures_decomposed?.length) {
    console.log('  Router returned empty routing plan');
    return [];
  }

  const results = [];

  for (const item of captures_decomposed) {
    const projectPath = PROJECT_PATHS[item.project];
    if (!projectPath) {
      console.warn(`  Unknown project: ${item.project} — skipping`);
      continue;
    }

    console.log(`  → [${item.project}] ${item.action}: ${item.text.slice(0, 80)}`);

    try {
      if (item.action === 'task') {
        // Resolve feature set: use existing id or create new
        let featureSetId = item.feature_set_id || null;
        if (!featureSetId && item.new_feature_set?.title) {
          const extras = item.is_integration && Array.isArray(item.integration_projects)
            ? item.integration_projects.filter(p => p && p !== item.project && PROJECT_PATHS[p])
            : [];
          const fs = await cloudApi('POST', '/api/feature-sets', {
            project_name: item.project,
            title: item.new_feature_set.title,
            description: item.new_feature_set.description,
            extra_projects: extras.length ? extras : undefined,
          });
          featureSetId = fs?.id || null;
          if (featureSetId) {
            const tag = extras.length ? ` [integration: +${extras.join(', ')}]` : '';
            console.log(`    ↳ new feature set #${featureSetId} "${item.new_feature_set.title}"${tag}`);
          }
        }

        const row = await cloudApi('POST', '/api/tasks', {
          project_name: item.project,
          capture_id: captureId,
          text: item.text,
          context: item.context,
          feature_set_id: featureSetId,
        });

        // Also file to the project's tasks.md as a visible breadcrumb
        await appendTask(projectPath, item.text, item.context);

        results.push({
          project: item.project, action: 'task',
          task_id: row?.id || null, feature_set_id: featureSetId,
          status: 'queued_in_feature_set',
        });
      } else if (item.action === 'note') {
        await appendNote(projectPath, item.text);
        results.push({ project: item.project, action: 'note', status: 'done' });
      } else if (item.action === 'doc') {
        await appendDocNote(projectPath, item.text);
        results.push({ project: item.project, action: 'doc', status: 'done' });
      }
    } catch (err) {
      console.error(`  Error executing ${item.action} for ${item.project}:`, err.message);
      results.push({ project: item.project, action: item.action, status: 'error', error: err.message });
    }
  }

  return results;
}
