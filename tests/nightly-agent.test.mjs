// Tests for nightly-agent.js — the three sub-commands (fetch, dispatch, sync-rules).
// Spawns the script as a subprocess so we exercise the real CLI contract.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const AGENT = join(__dirname, '../local/nightly-agent.js');
const ROOT = join(__dirname, '..');

function runAgent(args, env = {}) {
  // The script reads CONSTITUTION.md and LESSONS.md relative to ROOT. We don't
  // want tests to clobber the real files, so we point them at temp copies by
  // overriding HOME-style env if we had them. For now rely on the fact that
  // sync-rules overwrites LESSONS.md atomically — we snapshot + restore.
  const result = spawnSync('node', [AGENT, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 15_000,
  });
  return result;
}

function snapshot(path) {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

function restore(path, content) {
  if (content === null) {
    try { rmSync(path); } catch {}
  } else {
    writeFileSync(path, content);
  }
}

describe('nightly-agent CLI', () => {
  test('help: prints usage when no args', () => {
    const r = runAgent([]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Usage/);
    assert.match(r.stdout, /fetch/);
    assert.match(r.stdout, /dispatch/);
    assert.match(r.stdout, /sync-rules/);
  });

  test('help: exits non-zero for unknown command', () => {
    const r = runAgent(['nonsense']);
    assert.notEqual(r.status, 0);
  });
});

describe('nightly-agent sync-rules', () => {
  let tmpDir, tmpConstitution, tmpLessons;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'maestro-sync-'));
    tmpConstitution = join(tmpDir, 'CONSTITUTION.md');
    tmpLessons = join(tmpDir, 'LESSONS.md');
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  test('extracts Worker Rules and Routing Rules sections from CONSTITUTION.md', () => {
    writeFileSync(tmpConstitution, [
      '# Constitution',
      '## Mission',
      'nope',
      '## Routing Rules',
      '- route gloss things to gloss',
      '- route comms things to comms',
      '## Worker Rules',
      '- commit small',
      '- never push',
      '## Something Else',
      'should not leak',
    ].join('\n'));

    const r = runAgent(['sync-rules'], {
      MAESTRO_CONSTITUTION_PATH: tmpConstitution,
      MAESTRO_LESSONS_PATH: tmpLessons,
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);

    const lessons = readFileSync(tmpLessons, 'utf8');
    assert.match(lessons, /Mirrored from CONSTITUTION\.md/);
    assert.match(lessons, /route gloss things to gloss/);
    assert.match(lessons, /route comms things to comms/);
    assert.match(lessons, /commit small/);
    assert.match(lessons, /never push/);
    assert.doesNotMatch(lessons, /should not leak/);
  });

  test('emits placeholder when a section is missing', () => {
    writeFileSync(tmpConstitution, '# Constitution\n## Mission\nno rules yet\n');
    const r = runAgent(['sync-rules'], {
      MAESTRO_CONSTITUTION_PATH: tmpConstitution,
      MAESTRO_LESSONS_PATH: tmpLessons,
    });
    assert.equal(r.status, 0);
    const lessons = readFileSync(tmpLessons, 'utf8');
    assert.match(lessons, /none yet/);
  });
});

describe('nightly-agent fetch', () => {
  test('emits JSON with captures_error when GLOSS_URL is missing', () => {
    const r = runAgent(['fetch'], {
      GLOSS_URL: '',
      SUITE_API_KEY: 'any',
      COMMS_URL: '',
      SCRIBE_URL: '',
      BLACK_URL: '',
      TEND_URL: '',
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.captures_count, 0);
    assert.match(out.captures_error, /GLOSS_URL or SUITE_API_KEY missing/);
    assert.ok(Array.isArray(out.projects), 'projects must be an array');
    assert.ok(out.fetch_file.startsWith('/tmp/maestro-fetch-'), 'fetch file path must be emitted');
    assert.ok(out.logs_summary, 'logs_summary must be present even when unreachable');
  });

  test('writes full JSON file alongside compact stdout', () => {
    const r = runAgent(['fetch'], { GLOSS_URL: '', SUITE_API_KEY: '' });
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.ok(existsSync(out.fetch_file), 'fetch file must exist');
    const full = JSON.parse(readFileSync(out.fetch_file, 'utf8'));
    assert.ok('constitution' in full);
    assert.ok('captures' in full);
    assert.ok('logs_by_app' in full);
    assert.ok('projects' in full);
  });
});

describe('nightly-agent dispatch', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'maestro-disp-')); });
  afterEach(() => { try { rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

  test('rejects when plan file is missing', () => {
    const r = runAgent(['dispatch']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /plan/);
  });

  test('rejects when plan JSON is malformed', () => {
    const plan = join(tmpDir, 'bad.json');
    writeFileSync(plan, '{not json');
    const r = runAgent(['dispatch', plan]);
    assert.notEqual(r.status, 0);
  });

  test('rejects when plan has no routes array', () => {
    const plan = join(tmpDir, 'noroutes.json');
    writeFileSync(plan, JSON.stringify({}));
    const r = runAgent(['dispatch', plan]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /routes/);
  });

  test('reports skipped routes for unknown project without spawning workers', () => {
    const plan = join(tmpDir, 'plan.json');
    writeFileSync(plan, JSON.stringify({
      routes: [
        { project: 'flock', action: 'task', task: 'do thing', context: 'x' },
        { project: 'gloss' },
      ],
    }));
    const r = runAgent(['dispatch', plan], { AUTO_LAUNCH_SESSIONS: 'false' });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.routes_received, 2);
    const reasons = out.routes_skipped.map(s => s.reason);
    assert.ok(reasons.includes('unknown_project'), 'flock should be rejected as unknown');
    assert.ok(reasons.includes('missing_task'), 'gloss route with no task should be rejected');
    assert.deepEqual(out.workers, []);
  });
});
