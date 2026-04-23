// Executor tests — exercise routing dispatch without actually spawning claude.
// We set AUTO_LAUNCH_SESSIONS=false before importing so startWorker is a no-op
// path. Each test uses a fresh temp project dir.

import { test, describe, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Must be set BEFORE importing executor since AUTO_LAUNCH is a module const
process.env.AUTO_LAUNCH_SESSIONS = 'false';

let dispatchTask, executeRoutingPlan;
before(async () => {
  const mod = await import('../local/executor.js');
  dispatchTask = mod.dispatchTask;
  executeRoutingPlan = mod.executeRoutingPlan;
});

describe('executor.dispatchTask', () => {
  let projectPath;
  beforeEach(() => {
    projectPath = mkdtempSync(join(tmpdir(), 'maestro-exec-'));
  });
  afterEach(() => {
    try { rmSync(projectPath, { recursive: true, force: true }); } catch {}
  });

  test('appends to tasks.md and returns queued when AUTO_LAUNCH disabled', async () => {
    const calls = [];
    const cloudApi = async (method, path, body) => ({ id: 42, ...body });

    const r = await dispatchTask({
      projectName: 'testproj',
      projectPath,
      taskId: 10,
      text: 'do the thing',
      context: 'important',
      cloudApi,
      sessionStrategy: 'new_session',
      projectIsActive: false,
    });

    assert.equal(r.status, 'queued', 'AUTO_LAUNCH=false should leave task queued');
    const tasksFile = join(projectPath, 'tasks.md');
    assert.ok(existsSync(tasksFile));
    const content = readFileSync(tasksFile, 'utf8');
    assert.match(content, /do the thing/);
    assert.match(content, /important/);
  });

  test('returns queued_for_active_session when project has an active session', async () => {
    const r = await dispatchTask({
      projectName: 'testproj',
      projectPath,
      taskId: 10,
      text: 'something',
      sessionStrategy: 'new_session',
      projectIsActive: true,
      cloudApi: async () => ({}),
    });
    assert.equal(r.status, 'queued_for_active_session');
  });

  test('returns queued when router chose queue strategy even on idle project', async () => {
    const r = await dispatchTask({
      projectName: 'testproj',
      projectPath,
      taskId: 11,
      text: 'something else',
      sessionStrategy: 'queue',
      projectIsActive: false,
      cloudApi: async () => ({}),
    });
    assert.equal(r.status, 'queued');
  });
});

describe('executor.executeRoutingPlan', () => {
  let projectPath;
  const realPath = '/Users/nathancolestock/maestro';
  // We'll use the real maestro project path because the executor has a hardcoded
  // PROJECT_PATHS map. To avoid actually writing to it, we use a project name
  // that isn't in the map and assert we get the "Unknown project" path.

  test('skips unknown projects with a warning', async () => {
    const cloudApi = async () => ({ id: 1 });
    const results = await executeRoutingPlan(
      {
        captures_decomposed: [
          { project: 'does-not-exist', action: 'task', text: 'x', session_strategy: 'queue' },
        ],
      },
      1,
      { cloudApi, sessionsByProject: {} }
    );
    // Unknown project → skipped → no result pushed
    assert.equal(results.length, 0);
  });

  test('returns empty results for empty plan', async () => {
    const results = await executeRoutingPlan({ captures_decomposed: [] }, 1, {
      cloudApi: async () => ({}),
      sessionsByProject: {},
    });
    assert.deepEqual(results, []);
  });

  test('returns empty for null plan', async () => {
    const results = await executeRoutingPlan({}, 1, {
      cloudApi: async () => ({}),
      sessionsByProject: {},
    });
    assert.deepEqual(results, []);
  });
});

describe('executor.getProjectPath', () => {
  test('returns path for known project', async () => {
    const { getProjectPath } = await import('../local/executor.js');
    assert.equal(getProjectPath('foxed'), '/Users/nathancolestock/foxed');
    assert.equal(getProjectPath('black-hole'), '/Users/nathancolestock/black-hole');
  });
  test('returns undefined for unknown project', async () => {
    const { getProjectPath } = await import('../local/executor.js');
    assert.equal(getProjectPath('bogus'), undefined);
  });
});
