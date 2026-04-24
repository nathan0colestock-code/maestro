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
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { scanProjects } from './project-scanner.js';
import { startWorker } from './worker.js';
import { appendTask, appendNote } from './doc-updater.js';

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

  // Annotate originating Gloss captures so Nathan sees what shipped.
  const annotations = [];
  for (const r of results) {
    if (r.status !== 'done') continue;
    for (const captureId of r.source_capture_ids || []) {
      if (!captureId || typeof captureId !== 'string') continue;
      try {
        await bearerPost(
          `${GLOSS_URL}/api/captures/${encodeURIComponent(captureId)}/annotate`,
          { note: `shipped in ${r.project} (run ${r.run_id?.slice(0, 8) || '?'})` },
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
