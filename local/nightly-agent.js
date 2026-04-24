#!/usr/bin/env node
// Toolkit the nightly Maestro routine calls. The parent Claude session
// orchestrates — this script does mechanical work (API calls, subprocess
// spawning, file writes) and emits compact JSON so the parent's context
// stays lean.
//
// Sub-commands:
//   fetch               Gather captures + app logs + project state
//                       Writes /tmp/maestro-fetch-<date>.json
//                       Prints a short summary to stdout
//   dispatch <plan>     Execute a routing plan JSON file:
//                       { routes: [{project, task, context, action?, source_capture_id?}], update_cursor_to?: iso }
//                       Writes tasks.md, spawns workers, prints compact summary
//   sync-rules          Extract "Worker Rules" from CONSTITUTION.md → LESSONS.md
//                       so workers see the same rules the parent maintains.
//
// Env:
//   SUITE_API_KEY       bearer for all app APIs
//   GLOSS_URL           https://gloss-nc.fly.dev (fetch captures)
//   COMMS_URL/SCRIBE_URL/BLACK_URL/TEND_URL   (app log collection; optional)

import { readFile, writeFile, mkdir } from 'fs/promises';
import { exec as execCallback } from 'child_process';
import { promisify } from 'util';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { scanProjects } from './project-scanner.js';
import { startWorker } from './worker.js';
import { appendTask, appendNote } from './doc-updater.js';

const exec = promisify(execCallback);

// Project → Fly.io app name. Set via env so CI and test environments don't
// accidentally deploy to production. The nightly routine only ships projects
// whose Fly app name is explicitly configured; others commit-and-push only.
const FLY_APPS = {
  gloss: process.env.GLOSS_FLY_APP || (process.env.GLOSS_URL?.includes('gloss-nc') ? 'gloss-nc' : null),
  comms: process.env.COMMS_FLY_APP || null,
  scribe: process.env.SCRIBE_FLY_APP || null,
  black: process.env.BLACK_FLY_APP || null,
  tend: process.env.TEND_FLY_APP || null,
};
const SHIP_ENABLED = process.env.NIGHTLY_SHIP !== 'false';
const HEALTH_TIMEOUT_MS = 90_000;

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = process.env.MAESTRO_ROOT || join(__dirname, '..');
const CONSTITUTION_PATH = process.env.MAESTRO_CONSTITUTION_PATH || join(ROOT, 'CONSTITUTION.md');
const LESSONS_PATH = process.env.MAESTRO_LESSONS_PATH || join(ROOT, 'LESSONS.md');
const CURSOR_PATH = process.env.MAESTRO_CURSOR_PATH || join(ROOT, 'local/.nightly-cursor.json');

const SUITE_API_KEY = process.env.SUITE_API_KEY || process.env.API_KEY;
const GLOSS_URL = (process.env.GLOSS_URL || '').replace(/\/$/, '');
const APP_LOG_URLS = {
  gloss: process.env.GLOSS_URL,
  comms: process.env.COMMS_URL,
  scribe: process.env.SCRIBE_URL,
  black: process.env.BLACK_URL,
  tend: process.env.TEND_URL,
};

// ── helpers ───────────────────────────────────────────────────────────────────

async function bearerFetch(url, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${SUITE_API_KEY}` },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function bearerPost(url, body, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SUITE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function readJsonMaybe(path, fallback = null) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}

async function writeJson(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2));
}

async function readOptional(path) {
  try { return await readFile(path, 'utf8'); } catch { return ''; }
}

function summarizeEvents(events) {
  if (!Array.isArray(events)) return { count: 0, top: [] };
  const byKey = new Map();
  for (const e of events) {
    const key = `${e.event || e.level || 'unknown'} ${String(e.ctx || e.message || '').slice(0, 80)}`.trim();
    byKey.set(key, (byKey.get(key) || 0) + 1);
  }
  const top = [...byKey.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([k, n]) => ({ pattern: k, count: n }));
  return { count: events.length, top };
}

function extractSection(text, heading) {
  if (!text) return '';
  const idx = text.indexOf(heading);
  if (idx === -1) return '';
  const start = idx + heading.length;
  const next = text.indexOf('\n## ', start);
  return text.slice(start, next === -1 ? undefined : next).trim();
}

// ── ship pipeline ─────────────────────────────────────────────────────────────
// After a worker commits to its feature branch, this runs tests, merges to
// main, pushes, and (if the project has a Fly app configured) deploys.
// On ANY failure past the merge it reverts — both git (via git revert on the
// merge commit) and Fly (via `fly releases rollback -y`).

async function sh(cmd, opts = {}) {
  return exec(cmd, { maxBuffer: 8 * 1024 * 1024, ...opts });
}

async function currentBranch(cwd) {
  const { stdout } = await sh('git branch --show-current', { cwd });
  return stdout.trim();
}

async function hasTestScript(cwd) {
  try {
    const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'));
    return Boolean(pkg.scripts?.test);
  } catch {
    return false;
  }
}

async function runProjectTests(cwd) {
  if (!(await hasTestScript(cwd))) return { ok: true, skipped: 'no-test-script' };
  try {
    const { stdout, stderr } = await sh('npm test --silent', { cwd, timeout: 10 * 60_000 });
    return { ok: true, stdout: (stdout || '').slice(-4000), stderr: (stderr || '').slice(-4000) };
  } catch (err) {
    return {
      ok: false,
      stdout: (err.stdout || '').slice(-4000),
      stderr: (err.stderr || err.message || '').slice(-4000),
    };
  }
}

async function shipProjectChanges({ projectName, projectPath, runId }) {
  const log = [];
  const note = (msg) => { log.push(msg); };

  let branch;
  try { branch = await currentBranch(projectPath); }
  catch (e) { return { ok: false, phase: 'detect-branch', error: e.message, log }; }

  if (!branch || branch === 'main' || branch === 'master') {
    return { ok: false, phase: 'detect-branch', error: `not on a feature branch (current: ${branch || 'detached'})`, log };
  }
  note(`branch: ${branch}`);

  try {
    const { stdout } = await sh('git log origin/main..HEAD --oneline', { cwd: projectPath });
    if (!stdout.trim()) {
      return { ok: false, phase: 'detect-changes', error: 'no commits ahead of origin/main', log };
    }
    note(`commits ahead: ${stdout.trim().split('\n').length}`);
  } catch (e) {
    return { ok: false, phase: 'detect-changes', error: e.message, log };
  }

  // Phase 1: pre-merge tests on the feature branch
  const tests = await runProjectTests(projectPath);
  if (!tests.ok) {
    return { ok: false, phase: 'pre-merge-tests', error: (tests.stderr || 'tests failed').slice(0, 400), log, branch };
  }
  note(`tests: ${tests.skipped ? `skipped(${tests.skipped})` : 'passed'}`);

  // Phase 2: merge to main
  let mergeCommit;
  try {
    await sh('git checkout main', { cwd: projectPath });
    await sh('git pull --ff-only origin main', { cwd: projectPath }).catch(() => {
      // If main diverged or pull fails (network, etc.), proceed with local main.
      // This is safer than aborting — worker's base was origin/main already.
    });
    await sh(`git merge --no-ff --no-edit ${JSON.stringify(branch)}`, { cwd: projectPath });
    const { stdout } = await sh('git rev-parse HEAD', { cwd: projectPath });
    mergeCommit = stdout.trim();
    note(`merged ${branch} → main @ ${mergeCommit.slice(0, 8)}`);
  } catch (e) {
    await sh('git merge --abort', { cwd: projectPath }).catch(() => {});
    await sh('git checkout main', { cwd: projectPath }).catch(() => {});
    return { ok: false, phase: 'merge', error: (e.stderr || e.message).slice(0, 400), log, branch };
  }

  // Phase 3: push
  try {
    await sh('git push origin main', { cwd: projectPath });
    note('pushed to origin/main');
  } catch (e) {
    await sh('git reset --hard HEAD~1', { cwd: projectPath }).catch(() => {});
    return { ok: false, phase: 'push', error: (e.stderr || e.message).slice(0, 400), log, branch };
  }

  // Phase 4: deploy (only if Fly app is configured AND project is gloss — widen
  // as other apps get their fly apps wired in)
  const flyApp = FLY_APPS[projectName];
  if (!flyApp) {
    return { ok: true, phase: 'done', branch, merge_commit: mergeCommit, deployed: false, reason: 'no fly app configured', log };
  }

  try {
    note(`deploying to fly app "${flyApp}"`);
    await sh(`fly deploy -a ${flyApp} --remote-only`, { cwd: projectPath, timeout: 10 * 60_000 });
    note('deploy succeeded');
  } catch (e) {
    note(`deploy FAILED: ${(e.stderr || e.message).slice(0, 200)}`);
    // Revert: roll back Fly AND revert the merge commit on main
    await sh(`fly releases rollback -a ${flyApp} -y`, { timeout: 2 * 60_000 }).catch(err => {
      note(`fly rollback error: ${err.message}`);
    });
    try {
      await sh(`git revert -m 1 --no-edit ${mergeCommit}`, { cwd: projectPath });
      await sh('git push origin main', { cwd: projectPath });
      note('reverted merge commit on main');
    } catch (gerr) {
      note(`git revert error: ${gerr.message}`);
    }
    return { ok: false, phase: 'deploy', error: (e.stderr || e.message).slice(0, 400), log, branch, merge_commit: mergeCommit, reverted: true };
  }

  // Phase 5: post-deploy health check
  const appUrl = process.env[`${projectName.toUpperCase()}_URL`];
  if (appUrl) {
    try {
      const ok = await probeHealth(`${appUrl.replace(/\/$/, '')}/api/health`);
      if (!ok) {
        note('health check failed after deploy — rolling back');
        await sh(`fly releases rollback -a ${flyApp} -y`, { timeout: 2 * 60_000 }).catch(() => {});
        await sh(`git revert -m 1 --no-edit ${mergeCommit}`, { cwd: projectPath }).catch(() => {});
        await sh('git push origin main', { cwd: projectPath }).catch(() => {});
        return { ok: false, phase: 'post-deploy-health', error: 'health check failed', log, branch, merge_commit: mergeCommit, reverted: true };
      }
      note('health check passed');
    } catch (e) {
      note(`health check error: ${e.message}`);
    }
  }

  return { ok: true, phase: 'done', branch, merge_commit: mergeCommit, deployed: true, fly_app: flyApp, log };
}

async function probeHealth(url) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${SUITE_API_KEY}` } });
      if (res.ok || res.status === 401) return true; // 401 = app responding, auth just differs
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 5_000));
  }
  return false;
}

// ── fetch ─────────────────────────────────────────────────────────────────────

async function cmdFetch() {
  const today = new Date().toISOString().slice(0, 10);
  const outPath = `/tmp/maestro-fetch-${today}.json`;

  const constitution = await readOptional(CONSTITUTION_PATH);
  const cursor = await readJsonMaybe(CURSOR_PATH, { since: null });
  const since = cursor.since || new Date(Date.now() - 24 * 3600 * 1000).toISOString();

  // Captures from Gloss capture section
  let captures = [];
  let capturesError = null;
  if (!GLOSS_URL || !SUITE_API_KEY) {
    capturesError = 'GLOSS_URL or SUITE_API_KEY missing';
  } else {
    try {
      const data = await bearerFetch(`${GLOSS_URL}/api/captures/since?since=${encodeURIComponent(since)}&limit=100`);
      captures = (data.captures || []).map(c => ({
        id: c.id,
        source_kind: c.source_kind,
        summary: c.summary || '',
        text: (c.raw_ocr_text || '').slice(0, 2000),
        captured_at: c.captured_at,
      }));
    } catch (err) {
      capturesError = err.message;
    }
  }

  // App logs (warn/error only, summarized)
  const logs_by_app = {};
  await Promise.all(Object.entries(APP_LOG_URLS).map(async ([app, url]) => {
    if (!url) return;
    try {
      const data = await bearerFetch(`${url.replace(/\/$/, '')}/api/logs/recent?limit=500`, 10_000);
      const events = (data.events || data.logs || []).filter(e =>
        /warn|error|fail/i.test(e.event || e.level || '')
      );
      logs_by_app[app] = summarizeEvents(events);
    } catch (err) {
      logs_by_app[app] = { error: err.message.slice(0, 80) };
    }
  }));

  // Project state
  const projects = (await scanProjects()).map(p => ({
    name: p.name,
    description: (p.description || '').slice(0, 200),
    goals: (p.goals || '').slice(0, 150),
    open_task_count: p.open_task_count,
    last_commit: p.last_commit,
  }));

  const full = { date: today, cursor_since: since, constitution, captures, captures_error: capturesError, logs_by_app, projects };
  await writeJson(outPath, full);

  // Compact stdout summary for parent session
  const nextCursor = captures.length
    ? captures[captures.length - 1].captured_at
    : since;

  console.log(JSON.stringify({
    date: today,
    fetch_file: outPath,
    cursor_since: since,
    next_cursor_candidate: nextCursor,
    captures_count: captures.length,
    captures_error: capturesError,
    captures_preview: captures.slice(0, 5).map(c => ({
      id: c.id,
      source_kind: c.source_kind,
      summary: c.summary || (c.text || '').slice(0, 80),
    })),
    logs_summary: Object.fromEntries(
      Object.entries(logs_by_app).map(([app, v]) => [
        app,
        v.error ? { error: v.error } : { warn_error_count: v.count, top_pattern: v.top[0] || null },
      ])
    ),
    projects: projects.map(p => ({ name: p.name, open_task_count: p.open_task_count })),
  }, null, 2));
}

// ── dispatch ──────────────────────────────────────────────────────────────────

async function cmdDispatch(planPath) {
  if (!planPath) {
    console.error('dispatch requires a plan JSON path');
    process.exit(2);
  }
  const plan = await readJsonMaybe(planPath);
  if (!plan || !Array.isArray(plan.routes)) {
    console.error('plan must be JSON with `routes` array');
    process.exit(2);
  }

  const projects = await scanProjects();
  const byName = Object.fromEntries(projects.map(p => [p.name, p]));

  const byProject = {};
  const skipped = [];
  for (const r of plan.routes) {
    if (!byName[r.project]) { skipped.push({ route: r, reason: 'unknown_project' }); continue; }
    if (!r.task) { skipped.push({ route: r, reason: 'missing_task' }); continue; }
    (byProject[r.project] ||= []).push(r);
  }

  for (const [name, routes] of Object.entries(byProject)) {
    for (const r of routes) {
      try {
        if (r.action === 'note') await appendNote(byName[name].path, r.task);
        else await appendTask(byName[name].path, r.task, r.context);
      } catch (err) {
        skipped.push({ route: r, reason: `write_failed: ${err.message}` });
      }
    }
  }

  const results = [];
  await Promise.all(Object.entries(byProject).map(([name, routes]) => {
    const taskRoutes = routes.filter(r => r.action !== 'note');
    if (taskRoutes.length === 0) return Promise.resolve();
    const proj = byName[name];
    const task = taskRoutes.map(r => `- ${r.task}`).join('\n');
    const context = taskRoutes.map(r => r.context).filter(Boolean).join('; ');
    const sourceCaptureIds = Array.from(new Set(
      taskRoutes.map(r => r.source_capture_id).filter(Boolean)
    ));
    return new Promise(resolve => {
      const out = { project: name, status: 'pending', run_id: null, source_capture_ids: sourceCaptureIds };
      const started = startWorker({
        projectName: name,
        projectPath: proj.path,
        task,
        context,
        priorQA: [],
        onStart: ({ runId }) => { out.run_id = runId; },
        onEnd: ({ status, summary, cost, durationMs, questions }) => {
          out.status = status;
          out.cost_usd = cost ?? null;
          out.duration_min = Math.round((durationMs ?? 0) / 60000);
          out.summary = (summary || '').slice(0, 600);
          out.questions = questions || [];
          results.push(out);
          resolve();
        },
      });
      if (!started) { out.status = 'blocked'; results.push(out); resolve(); }
    });
  }));

  // Ship each project whose worker finished with status=done. Runs sequentially
  // per project so test/merge/deploy operations don't race on a shared repo.
  const ships = [];
  for (const r of results) {
    if (r.status !== 'done') continue;
    if (!SHIP_ENABLED) {
      ships.push({ project: r.project, run_id: r.run_id, ok: false, phase: 'disabled', reason: 'NIGHTLY_SHIP=false' });
      continue;
    }
    const proj = byName[r.project];
    if (!proj) continue;
    try {
      const ship = await shipProjectChanges({ projectName: r.project, projectPath: proj.path, runId: r.run_id });
      ships.push({ project: r.project, run_id: r.run_id, ...ship });
      r.shipped = ship.ok;
      r.ship_phase = ship.phase;
    } catch (err) {
      ships.push({ project: r.project, run_id: r.run_id, ok: false, phase: 'unhandled', error: err.message });
      r.shipped = false;
    }
  }

  // Annotate originating Gloss captures ONLY when the change actually shipped
  // (tests passed, merged, pushed, and — if applicable — deployed). Otherwise
  // annotate with the truthful status so Nathan isn't told "shipped" for code
  // that's sitting on a feature branch.
  const annotations = [];
  for (const r of results) {
    const shipEntry = ships.find(s => s.run_id === r.run_id);
    for (const captureId of r.source_capture_ids || []) {
      if (!captureId || typeof captureId !== 'string') continue;
      let note;
      if (shipEntry?.ok && shipEntry.deployed) {
        note = `deployed to ${r.project} (${shipEntry.fly_app}, commit ${shipEntry.merge_commit?.slice(0, 8)})`;
      } else if (shipEntry?.ok) {
        note = `merged to ${r.project}/main (commit ${shipEntry.merge_commit?.slice(0, 8)}) — no fly app configured, not deployed`;
      } else if (r.status === 'done' && shipEntry) {
        note = `built in ${r.project} on branch ${shipEntry.branch || '?'} — ship failed at ${shipEntry.phase}${shipEntry.reverted ? ' (reverted)' : ''}: ${shipEntry.error?.slice(0, 160) || ''}`;
      } else if (r.status === 'done') {
        note = `built in ${r.project} (run ${r.run_id?.slice(0, 8)}) — not shipped (NIGHTLY_SHIP disabled)`;
      } else {
        note = `attempted in ${r.project} — worker ${r.status}`;
      }
      try {
        await bearerPost(
          `${GLOSS_URL}/api/captures/${encodeURIComponent(captureId)}/annotate`,
          { note },
        );
        annotations.push({ capture_id: captureId, project: r.project, status: 'annotated' });
      } catch (err) {
        annotations.push({ capture_id: captureId, project: r.project, status: 'annotate_failed', error: err.message });
      }
    }
  }

  if (plan.update_cursor_to) {
    await writeJson(CURSOR_PATH, { since: plan.update_cursor_to });
  }

  console.log(JSON.stringify({
    routes_received: plan.routes.length,
    routes_skipped: skipped,
    workers: results,
    ships,
    annotations,
    cursor_updated_to: plan.update_cursor_to || null,
  }, null, 2));
}

// ── sync-rules ────────────────────────────────────────────────────────────────
// One-way sync: CONSTITUTION.md "Worker Rules" → LESSONS.md so workers see them.

async function cmdSyncRules() {
  const constitution = await readOptional(CONSTITUTION_PATH);
  const workerRules = extractSection(constitution, '## Worker Rules');
  const routingRules = extractSection(constitution, '## Routing Rules');

  const body = [
    '# Maestro Lessons',
    '',
    '_Mirrored from CONSTITUTION.md by nightly-agent.js. Edit the constitution, not this file._',
    '',
    '## Worker Rules',
    workerRules || '_(none yet)_',
    '',
    '## Routing Rules',
    routingRules || '_(none yet)_',
    '',
  ].join('\n');

  await writeFile(LESSONS_PATH, body);
  console.log(JSON.stringify({ lessons_path: LESSONS_PATH, worker_rules_lines: workerRules.split('\n').length }));
}

// ── main ──────────────────────────────────────────────────────────────────────

const cmd = process.argv[2];

const commands = {
  fetch: cmdFetch,
  dispatch: () => cmdDispatch(process.argv[3]),
  'sync-rules': cmdSyncRules,
};

(async () => {
  if (!commands[cmd]) {
    console.log(`Usage:
  node local/nightly-agent.js fetch              — dump context (writes /tmp/maestro-fetch-<date>.json)
  node local/nightly-agent.js dispatch <plan>    — execute a routing plan
  node local/nightly-agent.js sync-rules         — mirror CONSTITUTION.md → LESSONS.md
`);
    process.exit(cmd ? 2 : 0);
  }
  try {
    await commands[cmd]();
  } catch (err) {
    console.error('Fatal:', err.message);
    process.exit(1);
  }
})();
