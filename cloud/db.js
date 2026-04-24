import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Priority: explicit override > production volume > local cwd
const DB_PATH = process.env.MAESTRO_DB_PATH
  || (process.env.NODE_ENV === 'production' ? '/data/maestro.db' : join(__dirname, 'maestro.db'));
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS captures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    processed_at TEXT,
    routing_json TEXT
  );

  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    path TEXT NOT NULL,
    description TEXT,
    goals TEXT,
    current_focus TEXT,
    open_task_count INTEGER DEFAULT 0,
    last_commit TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_name TEXT NOT NULL,
    session_file TEXT,
    is_active INTEGER DEFAULT 0,
    last_active TEXT,
    last_action TEXT,
    agent_type TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_name TEXT NOT NULL,
    capture_id INTEGER REFERENCES captures(id),
    text TEXT NOT NULL,
    context TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    delivered_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS worker_runs (
    run_id TEXT PRIMARY KEY,
    session_id TEXT,
    project_name TEXT NOT NULL,
    capture_id INTEGER REFERENCES captures(id),
    task_id INTEGER REFERENCES tasks(id),
    task TEXT NOT NULL,
    context TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    summary TEXT,
    cost_usd REAL,
    duration_ms INTEGER,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at TEXT
  );

  CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_name TEXT NOT NULL,
    task_id INTEGER REFERENCES tasks(id),
    worker_run_id TEXT REFERENCES worker_runs(run_id),
    question TEXT NOT NULL,
    answer TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    answered_at TEXT
  );

  CREATE TABLE IF NOT EXISTS feature_sets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_name TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'collecting',
    manual_run INTEGER NOT NULL DEFAULT 0,
    branch_name TEXT,
    run_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT,
    completed_at TEXT,
    merged_at TEXT
  );

  CREATE TABLE IF NOT EXISTS synthesis_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_name TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Back-compat migrations
function safeMigrate(sql) {
  try { db.exec(sql); } catch { /* column already exists */ }
}
safeMigrate('ALTER TABLE tasks ADD COLUMN delivered_at TEXT');
safeMigrate('ALTER TABLE tasks ADD COLUMN duplicate_of INTEGER');
safeMigrate('ALTER TABLE tasks ADD COLUMN completed_at TEXT');
safeMigrate('ALTER TABLE worker_runs ADD COLUMN task_id INTEGER');
safeMigrate('ALTER TABLE worker_runs ADD COLUMN feature_set_id INTEGER');
safeMigrate('ALTER TABLE tasks ADD COLUMN feature_set_id INTEGER');
safeMigrate('ALTER TABLE feature_sets ADD COLUMN clarified_at TEXT');
safeMigrate('ALTER TABLE feature_sets ADD COLUMN extra_projects TEXT');
// Overnight-loop pipeline columns: status notes (test/deploy failure details),
// deployment timestamps, post-deploy health.
safeMigrate('ALTER TABLE feature_sets ADD COLUMN note TEXT');
safeMigrate('ALTER TABLE feature_sets ADD COLUMN deployed_at TEXT');
// Per-project deploy status for the dashboard.
safeMigrate('ALTER TABLE feature_sets ADD COLUMN deploy_status TEXT');
// User-initiated cancel flag — daemon checks between pipeline phases and
// aborts if set, leaving a note pointing at the interrupted phase.
safeMigrate('ALTER TABLE feature_sets ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0');
// Pipeline phase timings captured during runMergePipeline. Stored as a JSON
// array of { phase, started_at, ended_at, duration_ms, status } — feeds the
// self-improvement loop (router + worker prompts, dynamic WORKER_MAX_MS,
// regression flagging). TEXT (not JSON type) for broad sqlite compat.
safeMigrate('ALTER TABLE feature_sets ADD COLUMN phase_timings TEXT');
// Token counts per worker run. The reflection loop uses these to flag
// runs that burned tokens without shipping. Added as nullable so older
// rows read back as NULL.
safeMigrate('ALTER TABLE worker_runs ADD COLUMN tokens_in INTEGER');
safeMigrate('ALTER TABLE worker_runs ADD COLUMN tokens_out INTEGER');
// Where did this capture come from? 'user' (voice/text via PWA), 'reflector'
// (nightly self-improvement), future ingestors can pick their own tag.
// The reflector sets source='reflector' so its self-proposed captures can
// be filtered out of day-time dashboards if desired.
safeMigrate('ALTER TABLE captures ADD COLUMN source TEXT');
// Router confidence (0-1) recorded per capture so the nightly analyst can
// spot persistent low-confidence patterns worth a router rule.
safeMigrate('ALTER TABLE captures ADD COLUMN router_confidence REAL');

db.exec(`
  -- User feedback on how a capture was routed. The nightly analyst ranks
  -- patterns across this table to propose router-rule changes.
  CREATE TABLE IF NOT EXISTS routing_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    capture_id INTEGER REFERENCES captures(id),
    action TEXT NOT NULL,            -- 'moved_to_project' | 'deleted' | 'split' | 'merged' | 'wrong_project'
    detail TEXT,                     -- JSON: from/to project, user note, etc.
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- One row per nightly analysis. summary/suggestions are JSON blobs.
  CREATE TABLE IF NOT EXISTS telemetry_summary (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL UNIQUE,
    summary TEXT,
    suggestions TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Raw nightly payloads pulled from each suite app. UNIQUE(app, date) lets
  -- the daemon re-run the collector without dup rows.
  CREATE TABLE IF NOT EXISTS suite_telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app TEXT NOT NULL,
    date TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(app, date)
  );

  -- First-class training input: user-submitted feature suggestions captured
  -- via the PWA (voice or text). The nightly analyst ranks these above
  -- telemetry-only hunches; cross-validated items rank highest.
  CREATE TABLE IF NOT EXISTS feature_recommendations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,            -- 'pwa_voice' | 'pwa_text' | 'dashboard_inline' | 'tasks_md'
    target_app TEXT,                 -- maestro | gloss | comms | black | scribe | suite
    text TEXT NOT NULL,
    theme TEXT,                      -- clustered theme (set by nightly analyst)
    priority INTEGER DEFAULT 3,      -- user-set urgency 1-5
    status TEXT NOT NULL DEFAULT 'new', -- new | clustered | proposed | shipped | rejected | duplicate
    linked_pr_url TEXT,
    reject_reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_feature_recs_status ON feature_recommendations(status);
  CREATE INDEX IF NOT EXISTS idx_feature_recs_target ON feature_recommendations(target_app);
`);

export default db;
