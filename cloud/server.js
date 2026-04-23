import express from 'express';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { timingSafeEqual, createHash } from 'crypto';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import db from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3750;
const SECRET = process.env.MAESTRO_SECRET;
const PASSWORD = process.env.MAESTRO_PASSWORD;
const SUITE_API_KEY = process.env.SUITE_API_KEY;
const START_TIME = Date.now();

// Hash candidates before timing-safe compare so Buffers are always equal-length
// (avoids length leaks and handles non-ASCII inputs cleanly).
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ah = createHash('sha256').update(a).digest();
  const bh = createHash('sha256').update(b).digest();
  return timingSafeEqual(ah, bh);
}

// Read cloud package.json version once at startup
let PKG_VERSION = 'unknown';
try {
  PKG_VERSION = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8')).version || 'unknown';
} catch { /* ignore */ }

app.use(helmet({
  contentSecurityPolicy: false, // PWA uses inline bootstrap; revisit separately
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(join(__dirname, 'public')));

// Pre-auth brute-force protection. Login and capture are the two endpoints
// anyone on the internet can hit without credentials succeeding; throttle
// them per-IP.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too many attempts' },
});
const captureLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate limited' },
});

// Track the most recent daemon poll timestamp (in-memory is fine — it's a
// liveness heartbeat, not durable state).
let lastDaemonPing = null;

function bearerToken(req) {
  const h = req.headers['authorization'] || '';
  if (h.toLowerCase().startsWith('bearer ')) return h.slice(7).trim();
  return null;
}

function auth(req, res, next) {
  // Fail closed: if no credentials are configured, refuse rather than wave
  // everything through. Previously a missed Fly secret would make the whole
  // API publicly writable.
  if (!SECRET && !PASSWORD && !SUITE_API_KEY) {
    return res.status(503).json({ error: 'auth not configured' });
  }
  const providedSecret = req.headers['x-maestro-secret'];
  const providedPassword = req.headers['x-maestro-password'];
  const token = bearerToken(req);
  if (SECRET && providedSecret && safeEqual(providedSecret, SECRET)) return next();
  if (PASSWORD && providedPassword && safeEqual(providedPassword, PASSWORD)) return next();
  if (token && SECRET && safeEqual(token, SECRET)) return next();
  if (token && SUITE_API_KEY && safeEqual(token, SUITE_API_KEY)) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

// ── Login rate limit ────────────────────────────────────────────────────────
// In-memory sliding window; 5 attempts / 15 minutes per IP. Matches the
// pattern in comms/black/scribe. Single-user app — process restart clears
// the counter, which is acceptable.
const LOGIN_RATE = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;
function loginRateLimit(req, res, next) {
  const key = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const rec = LOGIN_RATE.get(key);
  if (rec && now - rec.firstAttemptAt > LOGIN_WINDOW_MS) LOGIN_RATE.delete(key);
  const cur = LOGIN_RATE.get(key);
  if (cur && cur.count >= LOGIN_MAX_ATTEMPTS) {
    const retry = Math.ceil((cur.firstAttemptAt + LOGIN_WINDOW_MS - now) / 1000);
    res.set('Retry-After', String(Math.max(retry, 1)));
    return res.status(429).json({ error: 'too many attempts' });
  }
  if (LOGIN_RATE.size > 1000) {
    for (const [k, v] of LOGIN_RATE) {
      if (now - v.firstAttemptAt > LOGIN_WINDOW_MS) LOGIN_RATE.delete(k);
    }
  }
  next();
}
function recordLoginAttempt(req) {
  const key = req.ip || req.socket?.remoteAddress || 'unknown';
  const cur = LOGIN_RATE.get(key);
  if (cur) cur.count += 1;
  else LOGIN_RATE.set(key, { count: 1, firstAttemptAt: Date.now() });
}

// Login verification endpoint — iPhone checks password before storing it.
// Fails closed if MAESTRO_PASSWORD is unset so a misconfigured deploy can't
// accidentally hand out valid sessions. Uses express-rate-limit (loginLimiter)
// for window-based throttling AND records each failed attempt into the inline
// counter (LOGIN_RATE) so only bad-password attempts consume the stricter
// 5-in-15-min quota — good credentials don't spend from it.
app.post('/api/login', loginLimiter, loginRateLimit, (req, res) => {
  if (!PASSWORD) return res.status(503).json({ error: 'auth not configured' });
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'password required' });
  if (safeEqual(password, PASSWORD)) return res.json({ ok: true });
  recordLoginAttempt(req);
  return res.status(401).json({ error: 'invalid password' });
});

// GET /api/health — public liveness (no auth). Every app in the suite
// exposes this under the same name for uniform monitoring.
app.get('/api/health', (req, res) => res.json({ ok: true, now: Date.now() }));

// POST /api/capture — iPhone stores a voice/text capture
app.post('/api/capture', captureLimiter, auth, (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'text required' });
  const row = db.prepare(
    'INSERT INTO captures (text) VALUES (?) RETURNING *'
  ).get(text.trim());
  res.json(row);
});

// GET /api/queue — daemon polls for unprocessed captures
app.get('/api/queue', auth, (req, res) => {
  lastDaemonPing = new Date().toISOString();
  const rows = db.prepare(
    'SELECT * FROM captures WHERE processed_at IS NULL ORDER BY created_at ASC'
  ).all();
  res.json(rows);
});

// GET /api/status — suite health probe (extended auth: Bearer MAESTRO_SECRET or SUITE_API_KEY)
app.get('/api/status', auth, (req, res) => {
  // captures still waiting to be routed
  const pendingCaptures = db.prepare(
    `SELECT COUNT(*) AS n FROM captures WHERE processed_at IS NULL`
  ).get().n;

  // feature sets that aren't yet terminal
  // Terminal statuses: done, failed, merged, merged_and_deployed,
  // deploy_failed_reverted, integration_failed, test_failed, merge_failed
  const openFeatureSets = db.prepare(
    `SELECT COUNT(*) AS n FROM feature_sets
       WHERE status NOT IN (
         'done','failed','merged','merged_and_deployed',
         'deploy_failed_reverted','integration_failed','test_failed','merge_failed'
       )`
  ).get().n;

  // distinct (project, session) pairs actively running or heartbeat in last 5 min
  const runningWorkers = db.prepare(
    `SELECT COUNT(*) AS n FROM (
       SELECT DISTINCT project_name, COALESCE(session_id, run_id) AS sid
         FROM worker_runs
        WHERE status = 'running'
           OR datetime(started_at) > datetime('now', '-5 minutes')
     )`
  ).get().n;

  res.json({
    app: 'maestro',
    version: PKG_VERSION,
    ok: true,
    uptime_seconds: Math.floor(process.uptime()),
    metrics: {
      pending_captures: pendingCaptures,
      open_feature_sets: openFeatureSets,
      running_workers: runningWorkers,
      last_daemon_ping: lastDaemonPing,
    },
  });
});

// POST /api/queue/:id/ack — daemon marks a capture processed
app.post('/api/queue/:id/ack', auth, (req, res) => {
  const { routing_json } = req.body;
  db.prepare(
    `UPDATE captures SET processed_at = datetime('now'), routing_json = ? WHERE id = ?`
  ).run(routing_json ? JSON.stringify(routing_json) : null, req.params.id);
  res.json({ ok: true });
});

// GET /api/captures — recent captures with routing results (for iPhone dashboard)
app.get('/api/captures', auth, (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM captures ORDER BY created_at DESC LIMIT 20'
  ).all();
  res.json(rows.map(r => ({
    ...r,
    routing_json: r.routing_json ? JSON.parse(r.routing_json) : null,
  })));
});

// GET /api/projects — iPhone reads project + session state
app.get('/api/projects', auth, (req, res) => {
  const projects = db.prepare('SELECT * FROM projects ORDER BY name').all();
  const sessions = db.prepare('SELECT * FROM sessions ORDER BY project_name').all();
  const tasks = db.prepare(
    "SELECT * FROM tasks WHERE status = 'pending' ORDER BY created_at DESC"
  ).all();

  const workerRuns = db.prepare(`
    SELECT * FROM worker_runs
    WHERE status = 'running' OR datetime(started_at) > datetime('now', '-1 day')
    ORDER BY started_at DESC
  `).all();

  const sessionsByProject = {};
  for (const s of sessions) sessionsByProject[s.project_name] = s;
  const tasksByProject = {};
  for (const t of tasks) {
    if (!tasksByProject[t.project_name]) tasksByProject[t.project_name] = [];
    tasksByProject[t.project_name].push(t);
  }
  const workersByProject = {};
  for (const w of workerRuns) {
    if (!workersByProject[w.project_name]) workersByProject[w.project_name] = [];
    workersByProject[w.project_name].push(w);
  }

  // Per-project deploy rollup: last feature set that reached a terminal
  // deploy state (merged_and_deployed or deploy_failed_reverted or
  // integration_failed). Drives the red/green deploy indicator on the
  // iPhone dashboard.
  const deployByProject = {};
  const deployRows = db.prepare(`
    SELECT project_name, status, deploy_status, deployed_at, merged_at, note, updated_at
    FROM feature_sets
    WHERE status IN ('merged_and_deployed','deploy_failed_reverted','integration_failed','test_failed','merge_failed','merged')
    ORDER BY COALESCE(deployed_at, merged_at, updated_at) DESC
  `).all();
  for (const r of deployRows) {
    if (!deployByProject[r.project_name]) {
      deployByProject[r.project_name] = {
        last_deploy_at: r.deployed_at || r.merged_at || r.updated_at,
        last_deploy_status: r.deploy_status
          || (r.status === 'merged_and_deployed' ? 'ok'
            : r.status === 'deploy_failed_reverted' ? 'reverted'
            : r.status === 'integration_failed' ? 'integration_failed'
            : r.status === 'test_failed' ? 'test_failed'
            : r.status === 'merge_failed' ? 'merge_failed'
            : 'ok'),
        last_deploy_note: r.note || null,
      };
    }
  }

  res.json(projects.map(p => ({
    ...p,
    session: sessionsByProject[p.name] || null,
    pending_tasks: (tasksByProject[p.name] || []).slice(0, 5),
    worker_runs: (workersByProject[p.name] || []).slice(0, 5),
    active_workers: (workersByProject[p.name] || []).filter(w => w.status === 'running').length,
    last_deploy_at: deployByProject[p.name]?.last_deploy_at || null,
    last_deploy_status: deployByProject[p.name]?.last_deploy_status || null,
    last_deploy_note: deployByProject[p.name]?.last_deploy_note || null,
  })));
});

// POST /api/state — daemon pushes full state snapshot
app.post('/api/state', auth, (req, res) => {
  const { projects, sessions } = req.body;
  if (!projects || !sessions) return res.status(400).json({ error: 'projects and sessions required' });

  const upsertProject = db.prepare(`
    INSERT INTO projects (name, path, description, goals, current_focus, open_task_count, last_commit, updated_at)
    VALUES (@name, @path, @description, @goals, @current_focus, @open_task_count, @last_commit, datetime('now'))
    ON CONFLICT(name) DO UPDATE SET
      path = excluded.path,
      description = excluded.description,
      goals = excluded.goals,
      current_focus = excluded.current_focus,
      open_task_count = excluded.open_task_count,
      last_commit = excluded.last_commit,
      updated_at = excluded.updated_at
  `);

  const upsertSession = db.prepare(`
    INSERT INTO sessions (project_name, session_file, is_active, last_active, last_action, agent_type, updated_at)
    VALUES (@project_name, @session_file, @is_active, @last_active, @last_action, @agent_type, datetime('now'))
    ON CONFLICT DO NOTHING
  `);

  const deleteOldSessions = db.prepare('DELETE FROM sessions WHERE project_name = ?');

  const txn = db.transaction(() => {
    for (const p of projects) upsertProject.run(p);
    for (const s of sessions) {
      deleteOldSessions.run(s.project_name);
      upsertSession.run(s);
    }
  });
  txn();

  res.json({ ok: true });
});

// POST /api/tasks — daemon stores routed tasks
app.post('/api/tasks', auth, (req, res) => {
  const { project_name, capture_id, text, context, feature_set_id } = req.body;
  if (!project_name || !text) return res.status(400).json({ error: 'project_name and text required' });
  const row = db.prepare(
    'INSERT INTO tasks (project_name, capture_id, text, context, feature_set_id) VALUES (?, ?, ?, ?, ?) RETURNING *'
  ).get(project_name, capture_id || null, text, context || null, feature_set_id || null);
  if (feature_set_id) {
    db.prepare(`UPDATE feature_sets SET updated_at = datetime('now') WHERE id = ?`).run(feature_set_id);
  }
  res.json(row);
});

function hydrateSet(s) {
  if (!s) return s;
  let extras = null;
  if (s.extra_projects) { try { extras = JSON.parse(s.extra_projects); } catch { extras = null; } }
  return { ...s, extra_projects: extras };
}

// GET /api/feature-sets?project=X — list feature sets with their tasks
app.get('/api/feature-sets', auth, (req, res) => {
  const { project } = req.query;
  const sets = project
    ? db.prepare(`SELECT * FROM feature_sets WHERE project_name = ? ORDER BY
        CASE status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 WHEN 'collecting' THEN 2 WHEN 'done' THEN 3 ELSE 4 END,
        updated_at DESC`).all(project)
    : db.prepare(`SELECT * FROM feature_sets ORDER BY updated_at DESC LIMIT 100`).all();

  const setIds = sets.map(s => s.id);
  const tasks = setIds.length
    ? db.prepare(`SELECT * FROM tasks WHERE feature_set_id IN (${setIds.map(() => '?').join(',')}) ORDER BY created_at ASC`).all(...setIds)
    : [];
  const runs = setIds.length
    ? db.prepare(`SELECT * FROM worker_runs WHERE feature_set_id IN (${setIds.map(() => '?').join(',')}) ORDER BY started_at DESC`).all(...setIds)
    : [];

  const tasksBySet = {}, runsBySet = {};
  for (const t of tasks) (tasksBySet[t.feature_set_id] ||= []).push(t);
  for (const r of runs) (runsBySet[r.feature_set_id] ||= []).push(r);

  res.json(sets.map(s => ({
    ...hydrateSet(s),
    tasks: tasksBySet[s.id] || [],
    runs: runsBySet[s.id] || [],
  })));
});

// POST /api/feature-sets — daemon creates a new feature set
app.post('/api/feature-sets', auth, (req, res) => {
  const { project_name, title, description, extra_projects } = req.body;
  if (!project_name || !title) return res.status(400).json({ error: 'project_name and title required' });
  const extras = Array.isArray(extra_projects) && extra_projects.length
    ? JSON.stringify(extra_projects.filter(p => p && p !== project_name))
    : null;
  const row = db.prepare(
    'INSERT INTO feature_sets (project_name, title, description, extra_projects) VALUES (?, ?, ?, ?) RETURNING *'
  ).get(project_name, title, description || null, extras);
  res.json(row);
});

// PATCH /api/feature-sets/:id — update title/description (clarity pass)
// GET /api/feature-sets/:id — single-row fetch; daemon uses this to poll
// for the cancel_requested flag between pipeline phases.
//
// `:id(\\d+)` constrains the param to digits so it does NOT shadow sibling
// routes like /drain, /stats, /merge-requested, /nightly-kickoff. Before
// this constraint, `GET /api/feature-sets/drain` matched this handler with
// :id="drain" and returned 404 "not found" instead of the drain payload.
app.get('/api/feature-sets/:id(\\d+)', auth, (req, res) => {
  const row = db.prepare(`SELECT * FROM feature_sets WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
});

app.patch('/api/feature-sets/:id(\\d+)', auth, (req, res) => {
  const { title, description } = req.body;
  const fields = [], vals = [];
  if (title !== undefined) { fields.push('title = ?'); vals.push(title); }
  if (description !== undefined) { fields.push('description = ?'); vals.push(description); }
  if (!fields.length) return res.json({ ok: true });
  fields.push(`updated_at = datetime('now')`);
  vals.push(req.params.id);
  const row = db.prepare(`UPDATE feature_sets SET ${fields.join(', ')} WHERE id = ? RETURNING *`).get(...vals);
  res.json(row);
});

// POST /api/feature-sets/:id/clarified — mark a set as "clarity-checked up to this snapshot"
// Sets clarified_at = updated_at (not now()) so future task additions re-trigger.
app.post('/api/feature-sets/:id/clarified', auth, (req, res) => {
  db.prepare(`UPDATE feature_sets SET clarified_at = updated_at WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// POST /api/feature-sets/:id/run — flag a feature set to run on next drain tick
app.post('/api/feature-sets/:id/run', auth, (req, res) => {
  const row = db.prepare(
    `UPDATE feature_sets SET manual_run = 1, status = 'queued', updated_at = datetime('now') WHERE id = ? RETURNING *`
  ).get(req.params.id);
  res.json(row);
});

// POST /api/feature-sets/:id/cancel — set the cancel_requested flag. The
// daemon's runMergePipeline polls between phases and aborts with a note
// pointing at the interrupted phase. This does NOT kill the daemon — just
// asks the current pipeline to stop at the next phase boundary.
app.post('/api/feature-sets/:id/cancel', auth, (req, res) => {
  const row = db.prepare(
    `UPDATE feature_sets SET cancel_requested = 1, updated_at = datetime('now')
     WHERE id = ? RETURNING *`
  ).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
});

// POST /api/feature-sets/:id/absorb — collapse sibling feature sets into this one.
// Body: { source_ids: [number, ...], extra_projects?: string[] }
// Moves every task from each source set into this one, marks source sets
// `status='cancelled'` (terminal, ignored by drain + kickoff), and optionally
// widens this set's extra_projects (useful when fixing a fan-out that the
// router accidentally split into N per-project sets).
// Idempotent: absorbing an already-cancelled set is a no-op.
app.post('/api/feature-sets/:id/absorb', auth, (req, res) => {
  const targetId = Number(req.params.id);
  const { source_ids, extra_projects } = req.body || {};
  if (!Array.isArray(source_ids) || source_ids.length === 0) {
    return res.status(400).json({ error: 'source_ids must be a non-empty array' });
  }
  const target = db.prepare('SELECT * FROM feature_sets WHERE id = ?').get(targetId);
  if (!target) return res.status(404).json({ error: 'target feature set not found' });
  if (source_ids.includes(targetId)) {
    return res.status(400).json({ error: 'cannot absorb a set into itself' });
  }

  const tx = db.transaction(() => {
    let movedTasks = 0;
    for (const sid of source_ids) {
      const src = db.prepare('SELECT id, status FROM feature_sets WHERE id = ?').get(sid);
      if (!src) continue;
      const r = db.prepare(
        `UPDATE tasks SET feature_set_id = ? WHERE feature_set_id = ?`
      ).run(targetId, sid);
      movedTasks += r.changes;
      db.prepare(
        `UPDATE feature_sets SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`
      ).run(sid);
    }
    if (Array.isArray(extra_projects)) {
      const filtered = extra_projects.filter(p => p && p !== target.project_name);
      const encoded = filtered.length ? JSON.stringify(filtered) : null;
      db.prepare(
        `UPDATE feature_sets SET extra_projects = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(encoded, targetId);
    } else {
      db.prepare(
        `UPDATE feature_sets SET updated_at = datetime('now') WHERE id = ?`
      ).run(targetId);
    }
    return movedTasks;
  });

  const movedTasks = tx();
  const fresh = db.prepare('SELECT * FROM feature_sets WHERE id = ?').get(targetId);
  res.json({ ok: true, target: hydrateSet(fresh), moved_tasks: movedTasks, absorbed: source_ids });
});

// POST /api/feature-sets/:id/merge — user approved; daemon will perform local git merge
app.post('/api/feature-sets/:id/merge', auth, (req, res) => {
  const row = db.prepare(
    `UPDATE feature_sets SET status = 'merge_requested', updated_at = datetime('now') WHERE id = ? RETURNING *`
  ).get(req.params.id);
  res.json(row);
});

// POST /api/feature-sets/:id/status — daemon reports state transitions + branch
//
// Known status values (not strictly enforced — daemon is trusted):
//   collecting, queued, running, needs_answer, done, failed,
//   merge_requested, merged, merge_failed,
//   test_failed, deploy_failed_reverted, merged_and_deployed, integration_failed
app.post('/api/feature-sets/:id/status', auth, (req, res) => {
  const { status, branch_name, run_id, note, phase_timings } = req.body;
  const fields = [], vals = [];
  if (status) {
    fields.push('status = ?'); vals.push(status);
    if (status === 'running') fields.push(`started_at = datetime('now')`);
    if (status === 'done' || status === 'failed' || status === 'test_failed') {
      fields.push(`completed_at = datetime('now')`);
    }
    if (status === 'merged' || status === 'merged_and_deployed') {
      fields.push(`merged_at = datetime('now')`);
    }
    if (status === 'merged_and_deployed') {
      fields.push(`deployed_at = datetime('now')`);
      fields.push(`deploy_status = 'ok'`);
    }
    if (status === 'deploy_failed_reverted') {
      fields.push(`deploy_status = 'reverted'`);
    }
    if (status === 'integration_failed') {
      fields.push(`deploy_status = 'integration_failed'`);
    }
    if (status === 'cancelled') {
      // Clear the cancel flag once the daemon has acknowledged it, so a
      // re-queued run starts clean.
      fields.push(`cancel_requested = 0`);
      fields.push(`completed_at = datetime('now')`);
    }
  }
  if (branch_name) { fields.push('branch_name = ?'); vals.push(branch_name); }
  if (run_id) { fields.push('run_id = ?'); vals.push(run_id); }
  if (typeof note === 'string') { fields.push('note = ?'); vals.push(note); }
  if (typeof phase_timings === 'string') {
    fields.push('phase_timings = ?');
    vals.push(phase_timings);
  } else if (phase_timings && typeof phase_timings === 'object') {
    fields.push('phase_timings = ?');
    vals.push(JSON.stringify(phase_timings));
  }
  if (!fields.length) return res.json({ ok: true });
  fields.push(`updated_at = datetime('now')`);
  vals.push(req.params.id);
  const row = db.prepare(`UPDATE feature_sets SET ${fields.join(', ')} WHERE id = ? RETURNING *`).get(...vals);
  res.json(row);
});

// GET /api/feature-sets/drain?project=X — daemon pulls next runnable feature set
app.get('/api/feature-sets/drain', auth, (req, res) => {
  const { project } = req.query;
  if (!project) return res.status(400).json({ error: 'project required' });
  const row = db.prepare(`
    SELECT * FROM feature_sets
    WHERE project_name = ? AND (status = 'queued' OR manual_run = 1)
      AND status NOT IN (
        'running','done','failed','merged','cancelled',
        'merge_requested','merge_failed','test_failed',
        'merged_and_deployed','deploy_failed_reverted','integration_failed'
      )
    ORDER BY manual_run DESC, updated_at ASC
    LIMIT 1
  `).get(project);
  if (!row) return res.json(null);
  const tasks = db.prepare(
    `SELECT * FROM tasks WHERE feature_set_id = ? ORDER BY created_at ASC`
  ).all(row.id);
  res.json({ ...hydrateSet(row), tasks });
});

// GET /api/reflect/observations?hours=12 — pull a single snapshot of everything
// that happened in the recent window, for the nightly self-reflection loop.
// Returns feature sets with their outcomes + phase_timings + failure notes,
// worker runs with durations/questions, and synthesis_log entries. The local
// reflector hands this to an LLM and asks for an after-action report.
app.get('/api/reflect/observations', auth, (req, res) => {
  const hours = Math.max(1, Math.min(168, Number(req.query.hours) || 12));
  const since = `datetime('now', '-${hours} hours')`;

  const featureSets = db.prepare(
    `SELECT * FROM feature_sets
     WHERE updated_at >= ${since}
     ORDER BY updated_at DESC`
  ).all().map(hydrateSet);

  const workerRuns = db.prepare(
    `SELECT run_id, project_name, feature_set_id, status, summary, cost_usd,
            duration_ms, tokens_in, tokens_out, started_at, ended_at
     FROM worker_runs
     WHERE started_at >= ${since}
     ORDER BY started_at DESC`
  ).all();

  const questionRows = db.prepare(
    `SELECT q.id, q.project_name, q.task_id, q.worker_run_id, q.question,
            q.answer, q.status, q.created_at, q.answered_at
     FROM questions q
     WHERE q.created_at >= ${since}
     ORDER BY q.created_at DESC`
  ).all();

  const synthesisLog = db.prepare(
    `SELECT id, project_name, action, detail, created_at
     FROM synthesis_log
     WHERE created_at >= ${since}
     ORDER BY created_at DESC`
  ).all();

  const captures = db.prepare(
    `SELECT id, text, source, processed_at, routing_json, created_at
     FROM captures
     WHERE created_at >= ${since}
     ORDER BY created_at DESC`
  ).all().map(c => ({
    ...c,
    processed: c.processed_at != null,
    routing_json: c.routing_json ? (() => { try { return JSON.parse(c.routing_json); } catch { return null; } })() : null,
  }));

  res.json({
    window_hours: hours,
    generated_at: new Date().toISOString(),
    feature_sets: featureSets,
    worker_runs: workerRuns,
    questions: questionRows,
    synthesis_log: synthesisLog,
    captures,
  });
});

// POST /api/feature-sets/nightly-kickoff — daemon flips all collecting sets to queued
app.post('/api/feature-sets/nightly-kickoff', auth, (req, res) => {
  const info = db.prepare(
    `UPDATE feature_sets SET status = 'queued', updated_at = datetime('now')
     WHERE status = 'collecting' AND (SELECT COUNT(*) FROM tasks WHERE feature_set_id = feature_sets.id) > 0`
  ).run();
  res.json({ queued: info.changes });
});

// GET /api/feature-sets/stats?project=X&days=N — recent phase_timings for the
// local daemon's self-improvement loop. Returns the raw rows; aggregation
// (p50/p95/mean/stddev/failure_rate) happens in local/pipeline-stats.js so
// the cloud stays a dumb store.
app.get('/api/feature-sets/stats', auth, (req, res) => {
  const project = String(req.query.project || '').trim();
  const days = Math.max(1, Math.min(90, Number(req.query.days) || 7));
  if (!project) return res.status(400).json({ error: 'project required' });
  const rows = db.prepare(`
    SELECT id, project_name, status, phase_timings, updated_at
    FROM feature_sets
    WHERE project_name = ?
      AND phase_timings IS NOT NULL
      AND updated_at >= datetime('now', ? )
    ORDER BY updated_at DESC
    LIMIT 500
  `).all(project, `-${days} days`);
  res.json({ rows });
});

// GET /api/feature-sets/merge-requested — daemon polls for user-approved merges
app.get('/api/feature-sets/merge-requested', auth, (req, res) => {
  const rows = db.prepare(
    `SELECT * FROM feature_sets WHERE status = 'merge_requested'`
  ).all();
  res.json(rows.map(hydrateSet));
});

// POST /api/worker/start — daemon announces a worker run is starting
app.post('/api/worker/start', auth, (req, res) => {
  const { run_id, session_id, project_name, capture_id, task_id, feature_set_id, task, context, started_at } = req.body;
  if (!run_id || !project_name || !task) return res.status(400).json({ error: 'run_id, project_name, task required' });
  db.prepare(`
    INSERT INTO worker_runs (run_id, session_id, project_name, capture_id, task_id, feature_set_id, task, context, status, started_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', COALESCE(?, datetime('now')))
    ON CONFLICT(run_id) DO NOTHING
  `).run(run_id, session_id || null, project_name, capture_id || null, task_id || null, feature_set_id || null, task, context || null, started_at || null);
  if (task_id) {
    db.prepare(`UPDATE tasks SET status = 'in_progress' WHERE id = ?`).run(task_id);
  }
  if (feature_set_id) {
    db.prepare(
      `UPDATE feature_sets SET status = 'running', started_at = COALESCE(started_at, datetime('now')), run_id = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(run_id, feature_set_id);
    db.prepare(`UPDATE tasks SET status = 'in_progress' WHERE feature_set_id = ? AND status = 'pending'`).run(feature_set_id);
  }
  res.json({ ok: true });
});

// POST /api/worker/:runId/end — daemon reports a worker finished
// If the worker raised questions, the daemon includes them here; we store them
// and flag the linked task as 'needs_answer' so it stops blocking the queue.
app.post('/api/worker/:runId/end', auth, (req, res) => {
  const { ended_at, status, summary, cost_usd, duration_ms, questions } = req.body;
  const runId = req.params.runId;

  const run = db.prepare('SELECT task_id, project_name FROM worker_runs WHERE run_id = ?').get(runId);

  db.prepare(`
    UPDATE worker_runs
    SET status = ?, summary = ?, cost_usd = ?, duration_ms = ?, ended_at = COALESCE(?, datetime('now'))
    WHERE run_id = ?
  `).run(status || 'done', summary || null, cost_usd || null, duration_ms || null, ended_at || null, runId);

  const hasQuestions = Array.isArray(questions) && questions.length > 0;
  if (hasQuestions && run) {
    const insQ = db.prepare(`
      INSERT INTO questions (project_name, task_id, worker_run_id, question)
      VALUES (?, ?, ?, ?)
    `);
    for (const q of questions) {
      if (q?.trim()) insQ.run(run.project_name, run.task_id || null, runId, q.trim());
    }
  }

  if (run?.task_id) {
    let taskStatus;
    if (hasQuestions) taskStatus = 'needs_answer';
    else if (status === 'error') taskStatus = 'failed';
    else taskStatus = 'done';
    db.prepare(`
      UPDATE tasks
      SET status = ?, completed_at = CASE WHEN ? = 'done' THEN datetime('now') ELSE completed_at END
      WHERE id = ?
    `).run(taskStatus, taskStatus, run.task_id);
  }

  res.json({ ok: true });
});

// GET /api/questions — iPhone lists pending questions to answer
app.get('/api/questions', auth, (req, res) => {
  const rows = db.prepare(`
    SELECT q.*, t.text AS task_text
    FROM questions q
    LEFT JOIN tasks t ON t.id = q.task_id
    WHERE q.status = 'pending'
    ORDER BY q.created_at ASC
  `).all();
  res.json(rows);
});

// POST /api/questions/:id/answer — iPhone submits an answer
app.post('/api/questions/:id/answer', auth, (req, res) => {
  const { answer } = req.body;
  if (!answer?.trim()) return res.status(400).json({ error: 'answer required' });
  db.prepare(`
    UPDATE questions
    SET answer = ?, status = 'answered', answered_at = datetime('now')
    WHERE id = ?
  `).run(answer.trim(), req.params.id);
  // Bump the linked task back to 'pending' so the drain loop retries with the answer
  const q = db.prepare('SELECT task_id FROM questions WHERE id = ?').get(req.params.id);
  if (q?.task_id) {
    db.prepare(`UPDATE tasks SET status = 'pending' WHERE id = ?`).run(q.task_id);
  }
  res.json({ ok: true });
});

// GET /api/questions/answered/:task_id — daemon fetches Q&A to inject into retry prompt
app.get('/api/tasks/:id/qa', auth, (req, res) => {
  const rows = db.prepare(`
    SELECT question, answer, answered_at FROM questions
    WHERE task_id = ? AND status = 'answered'
    ORDER BY answered_at ASC
  `).all(req.params.id);
  res.json(rows);
});

// GET /api/tasks/drain?project=X — daemon asks for next pending task to work on
app.get('/api/tasks/drain', auth, (req, res) => {
  const { project } = req.query;
  if (!project) return res.status(400).json({ error: 'project required' });
  const row = db.prepare(`
    SELECT * FROM tasks
    WHERE project_name = ? AND status = 'pending' AND duplicate_of IS NULL
    ORDER BY created_at ASC
    LIMIT 1
  `).get(project);
  res.json(row || null);
});

// POST /api/tasks/:id/requeue — flip a failed task back to pending so the drain retries it
app.post('/api/tasks/:id/requeue', auth, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare(`UPDATE tasks SET status = 'pending' WHERE id = ? AND status IN ('failed','error') RETURNING *`).get(id);
  res.json(row || null);
});

// POST /api/synthesis/merge — daemon collapses duplicate tasks after Gemini pass
app.post('/api/synthesis/merge', auth, (req, res) => {
  const { project_name, keep_id, merge_ids, merged_text, detail } = req.body;
  if (!keep_id || !Array.isArray(merge_ids)) return res.status(400).json({ error: 'keep_id and merge_ids required' });
  const txn = db.transaction(() => {
    if (merged_text) {
      db.prepare('UPDATE tasks SET text = ? WHERE id = ?').run(merged_text, keep_id);
    }
    const markDup = db.prepare("UPDATE tasks SET duplicate_of = ?, status = 'duplicate' WHERE id = ?");
    for (const id of merge_ids) markDup.run(keep_id, id);
    db.prepare(`
      INSERT INTO synthesis_log (project_name, action, detail)
      VALUES (?, 'dedupe', ?)
    `).run(project_name || 'unknown', JSON.stringify({ keep_id, merge_ids, detail }));
  });
  txn();
  res.json({ ok: true });
});

// GET /api/worker/runs — dashboard lists recent worker runs (active first)
app.get('/api/worker/runs', auth, (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM worker_runs
    ORDER BY
      CASE WHEN status = 'running' THEN 0 ELSE 1 END,
      started_at DESC
    LIMIT 40
  `).all();
  res.json(rows);
});

// GET /api/hook/tasks?project=gloss — UserPromptSubmit hook pulls pending tasks,
// then marks them delivered so they don't get re-injected into every prompt.
app.get('/api/hook/tasks', auth, (req, res) => {
  const { project } = req.query;
  if (!project) return res.status(400).json({ error: 'project required' });

  const tasks = db.prepare(`
    SELECT * FROM tasks
    WHERE project_name = ? AND status = 'pending' AND delivered_at IS NULL
    ORDER BY created_at ASC
    LIMIT 20
  `).all(project);

  if (tasks.length) {
    const ids = tasks.map(t => t.id);
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`UPDATE tasks SET delivered_at = datetime('now') WHERE id IN (${placeholders})`).run(...ids);
  }

  res.json(tasks);
});

// ── Self-improvement loop endpoints ───────────────────────────────────────
// These power the nightly analyst (local/improvement-agent.js) and the PWA's
// "Suggest improvement" surface. See plan: elegant-napping-fox.md.

// GET /api/recommendations?status=new,clustered&target=maestro — list
// feature recommendations, optionally filtered. Dashboard widget uses this.
app.get('/api/recommendations', auth, (req, res) => {
  const { status, target } = req.query;
  const where = [];
  const params = [];
  if (status) {
    const list = String(status).split(',').map(s => s.trim()).filter(Boolean);
    if (list.length) {
      where.push(`status IN (${list.map(() => '?').join(',')})`);
      params.push(...list);
    }
  }
  if (target) { where.push('target_app = ?'); params.push(String(target)); }
  const sql = `SELECT * FROM feature_recommendations
               ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY created_at DESC LIMIT 200`;
  res.json(db.prepare(sql).all(...params));
});

// POST /api/recommendations — user submits a feature suggestion. Source
// distinguishes voice vs text so the analyst can weight them.
app.post('/api/recommendations', auth, (req, res) => {
  const { text, source = 'pwa_text', target_app = null, priority = 3 } = req.body || {};
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text required' });
  }
  const info = db.prepare(`
    INSERT INTO feature_recommendations (source, target_app, text, priority)
    VALUES (?, ?, ?, ?)
  `).run(String(source), target_app ? String(target_app) : null, text.trim(), Number(priority) || 3);
  res.json({ ok: true, id: info.lastInsertRowid });
});

// POST /api/recommendations/:id — update a recommendation. Used by the user
// to reprioritize or dismiss, and by the nightly analyst to set theme/status.
app.post('/api/recommendations/:id(\\d+)', auth, (req, res) => {
  const id = Number(req.params.id);
  const { priority, status, theme, reject_reason, linked_pr_url } = req.body || {};
  const updates = [];
  const params = [];
  if (priority != null)      { updates.push('priority = ?');      params.push(Number(priority)); }
  if (status != null)        { updates.push('status = ?');        params.push(String(status)); }
  if (theme != null)         { updates.push('theme = ?');         params.push(String(theme)); }
  if (reject_reason != null) { updates.push('reject_reason = ?'); params.push(String(reject_reason)); }
  if (linked_pr_url != null) { updates.push('linked_pr_url = ?'); params.push(String(linked_pr_url)); }
  if (status === 'shipped' || status === 'rejected') {
    updates.push("resolved_at = datetime('now')");
  }
  if (!updates.length) return res.status(400).json({ error: 'no fields to update' });
  params.push(id);
  db.prepare(`UPDATE feature_recommendations SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json({ ok: true });
});

// POST /api/routing-feedback — user reports a misroute. Feeds nightly analyst.
app.post('/api/routing-feedback', auth, (req, res) => {
  const { capture_id, action, detail } = req.body || {};
  if (!action) return res.status(400).json({ error: 'action required' });
  const info = db.prepare(`
    INSERT INTO routing_feedback (capture_id, action, detail)
    VALUES (?, ?, ?)
  `).run(capture_id ? Number(capture_id) : null, String(action),
         detail == null ? null : (typeof detail === 'string' ? detail : JSON.stringify(detail)));
  res.json({ ok: true, id: info.lastInsertRowid });
});

// POST /api/suite-telemetry — daemon pushes nightly payloads from each app
// (gloss, comms, black, scribe). Upserts by (app, date).
app.post('/api/suite-telemetry', auth, (req, res) => {
  const { app: appName, date, payload } = req.body || {};
  if (!appName || !date || payload == null) {
    return res.status(400).json({ error: 'app, date, payload required' });
  }
  const json = typeof payload === 'string' ? payload : JSON.stringify(payload);
  db.prepare(`
    INSERT INTO suite_telemetry (app, date, payload) VALUES (?, ?, ?)
    ON CONFLICT(app, date) DO UPDATE SET payload = excluded.payload
  `).run(String(appName), String(date), json);
  res.json({ ok: true });
});

// GET /api/suite-telemetry?days=7 — nightly analyst pulls the recent window.
app.get('/api/suite-telemetry', auth, (req, res) => {
  const days = Math.max(1, Math.min(90, Number(req.query.days) || 7));
  const rows = db.prepare(`
    SELECT app, date, payload, created_at FROM suite_telemetry
    WHERE date(date) >= date('now', ?)
    ORDER BY date DESC, app ASC
  `).all(`-${days} day`);
  res.json(rows.map(r => ({ ...r, payload: safeParseJson(r.payload) })));
});

// POST /api/nightly-summary — improvement agent writes the day's analysis.
app.post('/api/nightly-summary', auth, (req, res) => {
  const { date, summary, suggestions } = req.body || {};
  if (!date) return res.status(400).json({ error: 'date required' });
  const sumJson = summary == null ? null : (typeof summary === 'string' ? summary : JSON.stringify(summary));
  const sugJson = suggestions == null ? null : (typeof suggestions === 'string' ? suggestions : JSON.stringify(suggestions));
  db.prepare(`
    INSERT INTO telemetry_summary (date, summary, suggestions) VALUES (?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET summary = excluded.summary, suggestions = excluded.suggestions
  `).run(String(date), sumJson, sugJson);
  res.json({ ok: true });
});

// GET /api/nightly-summary/latest — dashboard widget shows this.
app.get('/api/nightly-summary/latest', auth, (req, res) => {
  const row = db.prepare(`
    SELECT date, summary, suggestions, created_at FROM telemetry_summary
    ORDER BY date DESC LIMIT 1
  `).get();
  if (!row) return res.json(null);
  res.json({
    date: row.date,
    summary: safeParseJson(row.summary),
    suggestions: safeParseJson(row.suggestions),
    created_at: row.created_at,
  });
});

function safeParseJson(s) {
  if (s == null) return null;
  try { return JSON.parse(s); } catch { return s; }
}

// Serve PWA for all non-API routes (SPA fallback)
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// Self-scheduled nightly kickoff — backup path in case the local daemon is
// offline at 23:00 local. The cloud flips any eligible feature sets to
// 'queued' on its own schedule; the daemon will pick them up on its next
// poll whenever it comes online. Idempotent: only fires once per server-day.
//
// Uses UTC for consistency; user's local schedule is centered on America/Chicago
// so ~05:00 UTC corresponds to ~midnight Central. Adjust via
// CLOUD_NIGHTLY_KICKOFF_UTC_HOUR env var if needed.
const CLOUD_NIGHTLY_KICKOFF_UTC_HOUR = Number(process.env.CLOUD_NIGHTLY_KICKOFF_UTC_HOUR ?? 5);
let lastCloudKickoff = null; // YYYY-MM-DD string
function maybeCloudNightlyKickoff() {
  const now = new Date();
  if (now.getUTCHours() !== CLOUD_NIGHTLY_KICKOFF_UTC_HOUR) return;
  const today = now.toISOString().slice(0, 10);
  if (lastCloudKickoff === today) return;
  lastCloudKickoff = today;
  try {
    const info = db.prepare(
      `UPDATE feature_sets SET status = 'queued', updated_at = datetime('now')
       WHERE status = 'collecting' AND (SELECT COUNT(*) FROM tasks WHERE feature_set_id = feature_sets.id) > 0`
    ).run();
    if (info.changes > 0) {
      console.log(`[cloud-nightly] queued ${info.changes} feature set(s) at ${now.toISOString()}`);
    }
  } catch (err) {
    console.error('[cloud-nightly] failed:', err.message);
  }
}

// Only auto-start when run directly — tests import this file to get `app`.
const isDirectRun = import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  app.listen(PORT, () => {
    console.log(`Maestro cloud relay running on port ${PORT}`);
    console.log(`Cloud nightly kickoff: ${CLOUD_NIGHTLY_KICKOFF_UTC_HOUR}:00 UTC`);
  });
  // Check every 5 min whether we're in the kickoff hour.
  setInterval(maybeCloudNightlyKickoff, 5 * 60 * 1000);
}

export default app;
