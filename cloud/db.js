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

export default db;
