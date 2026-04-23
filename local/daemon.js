import { scanProjects } from './project-scanner.js';
import { readSessions } from './session-reader.js';
import { routeCapture } from './router.js';
import { executeRoutingPlan, dispatchTask, dispatchFeatureSet, mergeFeatureSet, getProjectPath, isAutoLaunchEnabled, isAutoMergeEnabled } from './executor.js';
import { hasActiveWorker } from './worker.js';
import { synthesizeProject, clarifyFeatureSet } from './synthesis.js';
import { deployProject } from './deployer.js';
import { runProjectTests, runIntegrationTests, checkoutBranch, branchExists } from './test-runner.js';
import { getProjectStats, detectRegression } from './pipeline-stats.js';
import { readFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYSTEM_MD_PATH = resolve(__dirname, '..', 'SYSTEM.md');
let SUITE_SYSTEM_CONTEXT = '';

const CLOUD_URL = process.env.MAESTRO_CLOUD_URL || 'http://localhost:3750';
const SECRET = process.env.MAESTRO_SECRET || '';
const POLL_INTERVAL_MS = 30_000;
const FULL_SCAN_INTERVAL_MS = 5 * 60_000;
const SYNTHESIS_INTERVAL_MS = 30 * 60_000;
const CLARITY_INTERVAL_MS = 10 * 60_000;
const NIGHTLY_KICKOFF_HOUR = Number(process.env.NIGHTLY_KICKOFF_HOUR ?? 23);
const NIGHTLY_CATCHUP_CUTOFF_HOUR = Number(process.env.NIGHTLY_CATCHUP_CUTOFF_HOUR ?? 7);

let cachedProjects = [];
let cachedSessions = [];
let lastFullScan = 0;
let lastSynthesis = 0;
let lastClarity = 0;
let lastNightlyKickoff = null; // YYYY-MM-DD string of last fire

function headers() {
  return {
    'Content-Type': 'application/json',
    ...(SECRET ? { 'X-Maestro-Secret': SECRET } : {}),
  };
}

async function api(method, path, body) {
  const res = await fetch(`${CLOUD_URL}${path}`, {
    method,
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

async function fullScan() {
  console.log('[scan] Reading projects and sessions...');
  cachedProjects = await scanProjects();
  cachedSessions = await readSessions();
  lastFullScan = Date.now();

  await api('POST', '/api/state', {
    projects: cachedProjects,
    sessions: cachedSessions,
  });

  const activeCount = cachedSessions.filter(s => s.is_active).length;
  console.log(`[scan] ${cachedProjects.length} projects, ${activeCount} active Claude sessions`);
}

async function quickSessionScan() {
  cachedSessions = await readSessions();
}

function sessionsByProject() {
  return Object.fromEntries(cachedSessions.map(s => [s.project_name, s]));
}

async function openFeatureSets() {
  try {
    const sets = await api('GET', '/api/feature-sets');
    return sets
      .filter(s => s.status === 'collecting' || s.status === 'queued')
      .map(s => ({
        id: s.id,
        project_name: s.project_name,
        title: s.title,
        description: s.description,
        task_count: (s.tasks || []).length,
      }));
  } catch { return []; }
}

async function processQueue() {
  const queue = await api('GET', '/api/queue');
  if (!queue.length) return;

  console.log(`[queue] ${queue.length} capture(s) to process`);
  const openSets = await openFeatureSets();

  for (const capture of queue) {
    console.log(`[route] "${capture.text.slice(0, 80)}${capture.text.length > 80 ? '…' : ''}"`);

    try {
      const routingPlan = await routeCapture(capture.text, cachedProjects, cachedSessions, openSets);
      const results = await executeRoutingPlan(routingPlan, capture.id, {
        cloudApi: api,
        sessionsByProject: sessionsByProject(),
      });

      await api('POST', `/api/queue/${capture.id}/ack`, {
        routing_json: { plan: routingPlan, results },
      });
    } catch (err) {
      console.error(`[route] Error processing capture ${capture.id}:`, err.message);
    }
  }
}

// Legacy drain: any pending tasks with no feature_set_id (pre-feature-set era)
// keep running the old one-task-per-worker flow so in-flight work completes.
async function drainLegacyTasks() {
  if (!isAutoLaunchEnabled()) return;
  const sessions = sessionsByProject();

  for (const project of cachedProjects) {
    const session = sessions[project.name];
    if (session?.is_active === 1) continue;
    if (hasActiveWorker(project.name)) continue;

    let nextTask;
    try {
      nextTask = await api('GET', `/api/tasks/drain?project=${encodeURIComponent(project.name)}`);
    } catch (err) { continue; }
    if (!nextTask || nextTask.feature_set_id) continue;

    const projectPath = getProjectPath(project.name);
    if (!projectPath) continue;

    let priorQA = [];
    try { priorQA = await api('GET', `/api/tasks/${nextTask.id}/qa`); } catch {}

    console.log(`[drain-legacy] ${project.name} task #${nextTask.id}${priorQA.length ? ` (+${priorQA.length} answers)` : ''}`);
    let projectStats = null;
    try { projectStats = await getProjectStats(project.name, { lookback_days: 7 }); } catch {}
    try {
      await dispatchTask({
        projectName: project.name, projectPath,
        taskId: nextTask.id, text: nextTask.text, context: nextTask.context,
        priorQA, captureId: nextTask.capture_id,
        sessionStrategy: 'new_session', projectIsActive: false,
        fileToTasksMd: false, cloudApi: api, projectStats,
      });
    } catch (err) {
      console.error(`[drain-legacy] ${project.name} dispatch failed:`, err.message);
    }
  }
}

// Returns a key identifying the current overnight window: the calendar date of
// the 23:00 that started it. 01:30 Mon → "Sun" (Sunday night's window).
function overnightWindowKey(now) {
  const d = new Date(now);
  if (d.getHours() < NIGHTLY_KICKOFF_HOUR) d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

// Fire the kickoff whenever we're inside the overnight window (23:00 → catchup cutoff,
// default 07:00) and haven't already kicked off for that window. This means opening
// the laptop at 6am after sleeping through 11pm still catches last night's work —
// while opening at 9am waits for tonight.
async function maybeNightlyKickoff() {
  const now = new Date();
  const hour = now.getHours();
  const inWindow = hour >= NIGHTLY_KICKOFF_HOUR || hour < NIGHTLY_CATCHUP_CUTOFF_HOUR;
  if (!inWindow) return;

  const key = overnightWindowKey(now);
  if (lastNightlyKickoff === key) return;

  try {
    const res = await api('POST', '/api/feature-sets/nightly-kickoff');
    const label = hour >= NIGHTLY_KICKOFF_HOUR ? 'on-time' : 'catchup';
    console.log(`[nightly] ${label} kickoff — ${res.queued} feature set(s) queued at ${now.toTimeString().slice(0, 5)}`);
    lastNightlyKickoff = key;
  } catch (err) {
    console.error('[nightly] kickoff failed:', err.message);
  }
}

async function drainFeatureSets() {
  if (!isAutoLaunchEnabled()) return;
  const sessions = sessionsByProject();

  // Projects we've committed to a dispatched set in THIS tick. A set with
  // peers reserves every involved project so later dispatches in the same
  // pass can't pick up something that shares a peer.
  const reservedThisTick = new Set();

  // Fetch per-project candidates, then rank so narrow (own-only) sets run
  // before wide (peer-spanning) ones. Without this, a suite-wide set
  // (e.g. "remove app switcher from all 7 apps") drawn first blocks every
  // other project until it finishes — serializing the whole night on one
  // worker. Running own-only first lets independent projects start
  // immediately and leaves the peer-heavy set to run on whatever's free.
  const candidates = [];
  for (const project of cachedProjects) {
    const session = sessions[project.name];
    if (session?.is_active === 1) continue;
    if (hasActiveWorker(project.name)) continue;

    let set;
    try {
      set = await api('GET', `/api/feature-sets/drain?project=${encodeURIComponent(project.name)}`);
    } catch { continue; }
    if (!set) continue;

    const extras = Array.isArray(set.extra_projects) ? set.extra_projects : [];
    const involved = [project.name, ...extras.filter(p => p && p !== project.name)];
    candidates.push({ project, set, extras, involved });
  }

  candidates.sort((a, b) => {
    if (a.involved.length !== b.involved.length) return a.involved.length - b.involved.length;
    return String(a.set.updated_at).localeCompare(String(b.set.updated_at));
  });

  for (const { project, set, extras, involved } of candidates) {
    if (hasActiveWorker(project.name)) continue;
    if (reservedThisTick.has(project.name)) continue;

    const busyPeer = involved.find(p => hasActiveWorker(p) || reservedThisTick.has(p));
    if (busyPeer) {
      console.log(`[drain] ${project.name} feature set #${set.id} deferred — peer ${busyPeer} busy`);
      continue;
    }

    const projectPath = getProjectPath(project.name);
    if (!projectPath) continue;

    console.log(`[drain] ${project.name} → feature set #${set.id} "${set.title}" (${set.tasks.length} task(s))${extras.length ? ` [+peers: ${extras.join(', ')}]` : ''}`);
    let projectStats = null;
    try { projectStats = await getProjectStats(project.name, { lookback_days: 7 }); } catch {}
    try {
      const result = await dispatchFeatureSet({
        projectName: project.name, projectPath,
        featureSet: set, cloudApi: api, projectStats,
      });
      if (result?.status === 'worker_started') {
        for (const p of involved) reservedThisTick.add(p);
      }
    } catch (err) {
      console.error(`[drain] ${project.name} dispatch failed:`, err.message);
    }
  }
}

// In-flight pipeline lock. The pipeline takes ~1 min (test + merge + deploy +
// health + integration), and the daemon polls every 30s — without this, the
// second tick would re-trigger the pipeline before the first finished updating
// cloud status, causing duplicate deploys and transient-health-blip reverts.
const pipelineInFlight = new Set();

// Closed-loop merge pipeline: test branch → merge → deploy each project →
// health check → auto-revert on failure. The goal is that the user wakes up
// to either a green "merged_and_deployed" feature set or a clearly-marked
// failure that rolled production back to its previous good state.
async function processMergeRequests() {
  let requests;
  try { requests = await api('GET', '/api/feature-sets/merge-requested'); }
  catch { return; }

  for (const set of requests || []) {
    if (pipelineInFlight.has(set.id)) {
      // Already being processed in a previous tick — don't re-enter.
      continue;
    }
    pipelineInFlight.add(set.id);
    try {
      await runMergePipeline(set);
    } finally {
      pipelineInFlight.delete(set.id);
    }
  }
}

// Cancel check: poll cloud state and return true if the user has requested
// a cancel for this feature set. Caller aborts with status='cancelled' and a
// note naming the phase that was interrupted. Kept read-only so a transient
// network error doesn't falsely trip the abort.
async function checkCancel(setId, phaseName) {
  try {
    const fresh = await api('GET', `/api/feature-sets/${setId}`);
    if (fresh && fresh.cancel_requested) {
      console.log(`[pipeline] cancel requested on #${setId} — aborting before ${phaseName}`);
      await api('POST', `/api/feature-sets/${setId}/status`, {
        status: 'cancelled',
        note: `cancelled before ${phaseName}`,
      }).catch(() => {});
      return true;
    }
  } catch { /* network flake → assume not cancelled */ }
  return false;
}

async function runMergePipeline(set) {
  const projectPath = getProjectPath(set.project_name);
  if (!projectPath || !set.branch_name) return;
  const extras = Array.isArray(set.extra_projects) ? set.extra_projects : [];
  const extraPaths = extras.map(p => getProjectPath(p)).filter(Boolean);
  const allProjects = [set.project_name, ...extras];
  const scope = extras.length ? `${set.project_name}+${extras.join(',')}` : set.project_name;

  // Self-improvement signal: every phase emits { phase, started_at,
  // ended_at, duration_ms, status }. Persisted on the terminal status
  // update so pipeline-stats can aggregate across runs.
  const timings = [];
  // Pre-load project stats once so each phase end can cheaply check for
  // regressions without round-tripping to the cloud for every transition.
  let projectStats = {};
  try { projectStats = await getProjectStats(set.project_name, { lookback_days: 7 }); }
  catch { /* stats are advisory; silent failure is OK */ }
  const regressionNotes = [];

  const recordPhase = async (phase, startedAt, status) => {
    const endedAt = Date.now();
    const duration_ms = endedAt - startedAt;
    const entry = {
      phase,
      started_at: new Date(startedAt).toISOString(),
      ended_at: new Date(endedAt).toISOString(),
      duration_ms,
      status,
    };
    timings.push(entry);
    if (status === 'ok') {
      const reg = detectRegression(phase, duration_ms, projectStats);
      if (reg.is_regression) {
        regressionNotes.push(reg.note);
        // Soft-surface the regression on the feature_set note immediately
        // so the pipeline is observable even if it later succeeds.
        await api('POST', `/api/feature-sets/${set.id}/status`, {
          note: regressionNotes.join('; '),
        }).catch(() => {});
      }
    }
  };

  // ─── Phase 1: pre-merge tests on the feature branch ──────────────────
  // Test the primary project AND every extra that actually carries the
  // same branch name. An integration set where the primary is gloss but
  // the branch also exists in comms used to ship with comms tests never
  // running — now a red peer fails the pipeline before any merge happens.
  console.log(`[pipeline] ${scope} branch ${set.branch_name} — running pre-merge tests across ${allProjects.length} project(s)`);
  const preMergeStart = Date.now();
  for (const projectName of allProjects) {
    const path = getProjectPath(projectName);
    if (!path) continue;
    const hasBranch = await branchExists(path, set.branch_name);
    if (!hasBranch) {
      // Extra projects may be listed for context but not participate — skip.
      if (projectName === set.project_name) {
        console.error(`[pipeline] primary ${projectName} missing branch ${set.branch_name}`);
        await recordPhase('pre-merge-tests', preMergeStart, 'failed');
        await api('POST', `/api/feature-sets/${set.id}/status`, {
          status: 'merge_failed', note: `primary project ${projectName} has no branch ${set.branch_name}`,
          phase_timings: JSON.stringify(timings),
        }).catch(() => {});
        return;
      }
      console.log(`[pipeline] ${projectName} has no branch ${set.branch_name} — skipping peer test`);
      continue;
    }
    const checkout = await checkoutBranch(path, set.branch_name);
    if (!checkout.ok) {
      console.error(`[pipeline] checkout failed on ${projectName}: ${checkout.error}`);
      await recordPhase('pre-merge-tests', preMergeStart, 'failed');
      await api('POST', `/api/feature-sets/${set.id}/status`, {
        status: 'merge_failed', note: `checkout failed on ${projectName}: ${checkout.error}`,
        phase_timings: JSON.stringify(timings),
      }).catch(() => {});
      return;
    }
    const preTest = await runProjectTests(projectName);
    await checkout.restore();
    if (!preTest.ok) {
      console.error(`[pipeline] ${projectName} tests failed — not merging`);
      await recordPhase('pre-merge-tests', preMergeStart, 'failed');
      await api('POST', `/api/feature-sets/${set.id}/status`, {
        status: 'test_failed',
        note: `${projectName}: ${(preTest.stderr || preTest.error || '').slice(0, 1800)}`,
        phase_timings: JSON.stringify(timings),
      }).catch(() => {});
      return;
    }
    console.log(`[pipeline] ${projectName} tests ${preTest.skipped ? `skipped (${preTest.skipped})` : '✓'}`);
  }
  await recordPhase('pre-merge-tests', preMergeStart, 'ok');

  if (await checkCancel(set.id, 'merge')) return;

  // ─── Phase 2: merge to main (primary + extras) ──────────────────────
  const mergeStart = Date.now();
  let mergeResult;
  try {
    mergeResult = await mergeFeatureSet({
      projectPath, branchName: set.branch_name, extraProjectPaths: extraPaths,
    });
  } catch (err) {
    console.error(`[pipeline] merge error on ${set.project_name}:`, err.message);
    await recordPhase('merge', mergeStart, 'failed');
    await api('POST', `/api/feature-sets/${set.id}/status`, {
      status: 'merge_failed', note: err.message,
      phase_timings: JSON.stringify(timings),
    }).catch(() => {});
    return;
  }
  if (!mergeResult.ok) {
    console.error(`[pipeline] merge failed: ${mergeResult.error}`);
    await recordPhase('merge', mergeStart, 'failed');
    await api('POST', `/api/feature-sets/${set.id}/status`, {
      status: 'merge_failed', note: mergeResult.error,
      phase_timings: JSON.stringify(timings),
    }).catch(() => {});
    return;
  }
  console.log(`[pipeline] merged in ${mergeResult.merged?.length || 0} repo(s) — pushing`);

  // Push each merged repo so the Fly deploy builds from up-to-date main.
  // child_process is imported statically at the top of the file — there's no
  // reason to dynamic-import it once per repo inside this loop.
  for (const repoPath of mergeResult.merged || []) {
    try {
      await new Promise((res, rej) => {
        exec(`cd "${repoPath}" && git push origin main`, { timeout: 60_000 }, (err, stdout) => {
          if (err) rej(err); else res(stdout);
        });
      });
    } catch (err) {
      console.warn(`[pipeline] push failed for ${repoPath}: ${err.message} (continuing — fly deploys from local)`);
    }
  }
  await recordPhase('merge', mergeStart, 'ok');

  if (await checkCancel(set.id, 'deploy')) return;

  // ─── Phase 3: deploy each project, health-check, auto-revert on fail ─
  // If any deploy fails, we roll back EVERY already-successful sibling too.
  // Previous behavior left early-in-the-list projects live against a
  // reverted later-in-the-list project — quietly inconsistent prod.
  const deployStart = Date.now();
  const deployResults = [];
  for (const projectName of allProjects) {
    const r = await deployProject(projectName);
    deployResults.push(r);
    if (!r.ok && !r.skipped) {
      console.error(`[pipeline] deploy failed for ${projectName} — halting subsequent deploys`);
      break;
    }
  }

  const anyDeployFailed = deployResults.some(r => !r.ok && !r.skipped);
  if (anyDeployFailed) {
    await recordPhase('deploy', deployStart, 'failed');
    // Roll back every sibling that *did* deploy+health-check OK earlier
    // in the loop. Use dynamic import so this file stays aligned with the
    // existing import at the top; undeployProject is the new helper.
    const { undeployProject } = await import('./deployer.js');
    const siblingRollbacks = [];
    for (const r of deployResults) {
      if (r.ok && !r.skipped) {
        const back = await undeployProject(r.projectName);
        siblingRollbacks.push(back);
      }
    }
    await api('POST', `/api/feature-sets/${set.id}/status`, {
      status: 'deploy_failed_reverted',
      note: JSON.stringify({
        failed: deployResults.filter(r => !r.ok && !r.skipped).map(r => ({
          project: r.projectName, flyApp: r.flyApp, error: r.error,
          fly_rollback: r.fly_rollback, git_revert: r.git_revert,
          post_revert_healthy: r.post_revert_healthy,
        })),
        sibling_rollbacks: siblingRollbacks.map(r => ({
          project: r.projectName, flyApp: r.flyApp, ok: r.ok,
          fly_rollback: r.fly_rollback, git_revert: r.git_revert,
          post_revert_healthy: r.post_revert_healthy,
        })),
      }).slice(0, 4000),
      phase_timings: JSON.stringify(timings),
    }).catch(() => {});
    return;
  }
  await recordPhase('deploy', deployStart, 'ok');

  if (await checkCancel(set.id, 'integration-tests')) return;

  // ─── Phase 4: post-deploy integration tests (soft — logged, not blocking) ─
  const integrationStart = Date.now();
  const integration = await runIntegrationTests().catch(err => ({ ok: false, error: err.message }));
  if (!integration.ok) {
    console.warn(`[pipeline] integration tests failed post-deploy — surfacing`);
    await recordPhase('integration-tests', integrationStart, 'failed');
    await api('POST', `/api/feature-sets/${set.id}/status`, {
      status: 'integration_failed',
      note: ((integration.stderr || '') + '\n' + (integration.stdout || '')).slice(0, 3000),
      phase_timings: JSON.stringify(timings),
    }).catch(() => {});
    return;
  }
  await recordPhase('integration-tests', integrationStart, 'ok');

  // ─── Success: merged + deployed + integration-tested ─────────────────
  console.log(`[pipeline] ✓ ${scope} merged_and_deployed`);
  const successNote = JSON.stringify({
    deployed: deployResults.filter(r => r.ok && !r.skipped).map(r => ({
      project: r.projectName, flyApp: r.flyApp, at: r.deployedAt,
    })),
    ...(regressionNotes.length ? { regressions: regressionNotes } : {}),
  });
  await api('POST', `/api/feature-sets/${set.id}/status`, {
    status: 'merged_and_deployed',
    note: successNote,
    phase_timings: JSON.stringify(timings),
  }).catch(() => {});
}

async function runClarity() {
  if (Date.now() - lastClarity < CLARITY_INTERVAL_MS) return;
  lastClarity = Date.now();
  let sets;
  try { sets = await api('GET', '/api/feature-sets'); } catch { return; }

  const stale = (sets || []).filter(s =>
    s.status === 'collecting'
    && (s.tasks?.length || 0) >= 2
    && (!s.clarified_at || s.updated_at > s.clarified_at)
  );
  if (!stale.length) return;

  for (const set of stale) {
    try {
      const refined = await clarifyFeatureSet(set);
      if (refined && (refined.title !== set.title || refined.description !== set.description)) {
        await api('PATCH', `/api/feature-sets/${set.id}`, {
          title: refined.title, description: refined.description,
        });
        console.log(`[clarity] #${set.id} → "${refined.title}"`);
      }
      // Always mark checked so we don't re-refine an unchanged set every tick
      await api('POST', `/api/feature-sets/${set.id}/clarified`).catch(() => {});
    } catch (err) { console.error('[clarity] fail:', err.message); }
  }
}

async function runSynthesis() {
  if (Date.now() - lastSynthesis < SYNTHESIS_INTERVAL_MS) return;
  lastSynthesis = Date.now();

  for (const project of cachedProjects) {
    let tasks;
    try {
      const res = await fetch(`${CLOUD_URL}/api/projects`, { headers: headers() });
      if (!res.ok) continue;
      const all = await res.json();
      const p = all.find(x => x.name === project.name);
      tasks = p?.pending_tasks || [];
    } catch { continue; }
    if (tasks.length < 2) continue;

    try {
      const result = await synthesizeProject(project.name, tasks);
      for (const cluster of result.clusters || []) {
        if (!cluster.merge_ids?.length) continue;
        console.log(`[synth] ${project.name}: merging ${cluster.merge_ids.length} task(s) into #${cluster.keep_id}`);
        await api('POST', '/api/synthesis/merge', {
          project_name: project.name,
          keep_id: cluster.keep_id,
          merge_ids: cluster.merge_ids,
          merged_text: cluster.merged_text,
          detail: cluster.reason,
        }).catch(err => console.error('[synth] merge failed:', err.message));
      }
    } catch (err) {
      console.error(`[synth] ${project.name} failed:`, err.message);
    }
  }
}

async function tick() {
  const now = Date.now();

  if (now - lastFullScan > FULL_SCAN_INTERVAL_MS) {
    await fullScan();
  } else {
    await quickSessionScan();
    await api('POST', '/api/state', {
      projects: cachedProjects,
      sessions: cachedSessions,
    }).catch(() => {});
  }

  await processQueue();
  await maybeNightlyKickoff();
  await drainLegacyTasks();
  await drainFeatureSets();
  await processMergeRequests();
  await runClarity().catch(err => console.error('[clarity] tick error:', err.message));
  await runSynthesis().catch(err => console.error('[synth] tick error:', err.message));
}

async function main() {
  console.log('Maestro daemon starting...');
  console.log(`Cloud URL: ${CLOUD_URL}`);
  console.log(`Nightly kickoff hour: ${NIGHTLY_KICKOFF_HOUR}:00 local`);
  console.log(`Auto-merge on tests pass: ${isAutoMergeEnabled() ? 'ON' : 'off'}`);

  // Load SYSTEM.md so the router can inject suite-wide context into Gemini
  // prompts. Failure to load is non-fatal — the daemon still runs.
  try {
    SUITE_SYSTEM_CONTEXT = await readFile(SYSTEM_MD_PATH, 'utf8');
    console.log(`[system] loaded SYSTEM.md (${SUITE_SYSTEM_CONTEXT.length} chars)`);
  } catch (err) {
    console.warn(`[system] SYSTEM.md not loadable: ${err.message}`);
  }

  if (!process.env.GEMINI_API_KEY) {
    console.error('Error: GEMINI_API_KEY not set');
    process.exit(1);
  }

  await fullScan().catch(err => console.error('Initial scan failed:', err.message));
  await processQueue().catch(err => console.error('Initial queue check failed:', err.message));
  await drainLegacyTasks().catch(err => console.error('Initial legacy drain failed:', err.message));
  await drainFeatureSets().catch(err => console.error('Initial fs drain failed:', err.message));

  setInterval(async () => {
    try { await tick(); }
    catch (err) { console.error('[tick] Error:', err.message); }
  }, POLL_INTERVAL_MS);

  console.log(`Daemon running — polling every ${POLL_INTERVAL_MS / 1000}s`);
}

main();
