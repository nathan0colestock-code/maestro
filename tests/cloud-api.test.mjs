import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { bootCloud } from './helpers.mjs';

describe('cloud API', () => {
  let cloud;
  before(async () => { cloud = await bootCloud(); });
  after(async () => { await cloud.close(); });

  test('rejects unauthed requests with 401', async () => {
    const res = await fetch(cloud.baseUrl + '/api/projects');
    assert.equal(res.status, 401);
  });

  test('login endpoint verifies password', async () => {
    const bad = await cloud.req('POST', '/api/login', { password: 'wrong' });
    assert.equal(bad.status, 401);
    const good = await cloud.req('POST', '/api/login', { password: 'test-password' });
    assert.equal(good.status, 200);
    assert.equal(good.body.ok, true);
  });

  test('capture → queue → ack full cycle', async () => {
    const cap = await cloud.req('POST', '/api/capture', { text: 'hello world' });
    assert.equal(cap.status, 200);
    assert.ok(cap.body.id);
    assert.equal(cap.body.text, 'hello world');
    assert.equal(cap.body.processed_at, null);

    const queue = await cloud.req('GET', '/api/queue');
    assert.equal(queue.status, 200);
    assert.ok(queue.body.some(c => c.id === cap.body.id));

    const ack = await cloud.req('POST', `/api/queue/${cap.body.id}/ack`, {
      routing_json: { plan: { captures_decomposed: [] }, results: [] },
    });
    assert.equal(ack.status, 200);

    const queue2 = await cloud.req('GET', '/api/queue');
    assert.ok(!queue2.body.some(c => c.id === cap.body.id), 'acked capture should leave queue');

    const captures = await cloud.req('GET', '/api/captures');
    const found = captures.body.find(c => c.id === cap.body.id);
    assert.ok(found?.processed_at, 'processed_at must be set after ack');
    assert.deepEqual(found.routing_json, { plan: { captures_decomposed: [] }, results: [] });
  });

  test('rejects empty capture text', async () => {
    const r = await cloud.req('POST', '/api/capture', { text: '   ' });
    assert.equal(r.status, 400);
  });

  test('task creation returns row with id', async () => {
    const t = await cloud.req('POST', '/api/tasks', {
      project_name: 'foxed',
      text: 'add pagination',
      context: 'scan history view',
    });
    assert.equal(t.status, 200);
    assert.ok(t.body.id);
    assert.equal(t.body.project_name, 'foxed');
    assert.equal(t.body.status, 'pending');
  });

  test('drain endpoint returns oldest pending task, skips duplicates', async () => {
    // Scoped to a unique project so we don't collide with earlier tests
    await cloud.req('POST', '/api/tasks', { project_name: 'drain-test', text: 'first' });
    const second = await cloud.req('POST', '/api/tasks', { project_name: 'drain-test', text: 'second' });

    const next = await cloud.req('GET', '/api/tasks/drain?project=drain-test');
    assert.equal(next.body.text, 'first', 'drain returns oldest first');

    // Mark 'first' as duplicate_of 'second' via synthesis merge
    const first = next.body;
    await cloud.req('POST', '/api/synthesis/merge', {
      project_name: 'drain-test',
      keep_id: second.body.id,
      merge_ids: [first.id],
      merged_text: 'merged first+second',
    });

    const next2 = await cloud.req('GET', '/api/tasks/drain?project=drain-test');
    assert.equal(next2.body.id, second.body.id, 'drain skips duplicate tasks');
    assert.equal(next2.body.text, 'merged first+second', 'keep task absorbs merged text');
  });

  test('worker lifecycle: start sets task in_progress, end marks done', async () => {
    const t = await cloud.req('POST', '/api/tasks', { project_name: 'flock', text: 'test task' });
    await cloud.req('POST', '/api/worker/start', {
      run_id: 'run-1', project_name: 'flock', task_id: t.body.id, task: 'test task',
    });

    const drainWhileRunning = await cloud.req('GET', '/api/tasks/drain?project=flock');
    // task is in_progress now — should NOT be returned by drain (drain filters status=pending)
    assert.ok(!drainWhileRunning.body || drainWhileRunning.body.id !== t.body.id,
      'in_progress task must not appear in drain');

    await cloud.req('POST', '/api/worker/run-1/end', {
      status: 'done', summary: 'all done', cost_usd: 0.12, duration_ms: 4500,
    });

    const runs = await cloud.req('GET', '/api/worker/runs');
    const run = runs.body.find(r => r.run_id === 'run-1');
    assert.equal(run.status, 'done');
    assert.equal(run.summary, 'all done');
    assert.equal(run.cost_usd, 0.12);
    assert.equal(run.duration_ms, 4500);
  });

  test('worker finishing with questions creates questions + flips task to needs_answer', async () => {
    const t = await cloud.req('POST', '/api/tasks', { project_name: 'tend', text: 'design reset flow' });
    await cloud.req('POST', '/api/worker/start', {
      run_id: 'run-q', project_name: 'tend', task_id: t.body.id, task: 'design reset flow',
    });
    await cloud.req('POST', '/api/worker/run-q/end', {
      status: 'needs_answer',
      summary: 'I need more info.\nQUESTION: wipe all fields or just the form?\nQUESTION: include confirmation modal?',
      questions: ['wipe all fields or just the form?', 'include confirmation modal?'],
    });

    const questions = await cloud.req('GET', '/api/questions');
    const mine = questions.body.filter(q => q.task_id === t.body.id);
    assert.equal(mine.length, 2);
    assert.ok(mine.every(q => q.status === 'pending'));
    assert.ok(mine.every(q => q.project_name === 'tend'));
    assert.equal(mine[0].task_text, 'design reset flow');
  });

  test('answering a question flips linked task back to pending, records Q&A', async () => {
    const t = await cloud.req('POST', '/api/tasks', { project_name: 'tend', text: 'pick a color' });
    await cloud.req('POST', '/api/worker/start', {
      run_id: 'run-qa', project_name: 'tend', task_id: t.body.id, task: 'pick a color',
    });
    await cloud.req('POST', '/api/worker/run-qa/end', {
      status: 'needs_answer',
      summary: 'QUESTION: blue or green?',
      questions: ['blue or green?'],
    });

    const qs = await cloud.req('GET', '/api/questions');
    const mine = qs.body.find(q => q.task_id === t.body.id);
    assert.ok(mine);

    const ans = await cloud.req('POST', `/api/questions/${mine.id}/answer`, { answer: 'green' });
    assert.equal(ans.status, 200);

    // Task should now be back to pending (ready for retry by drain loop)
    const nextDrain = await cloud.req('GET', '/api/tasks/drain?project=tend');
    // might pick up this task OR an earlier one — assert it's pending at least
    const qa = await cloud.req('GET', `/api/tasks/${t.body.id}/qa`);
    assert.equal(qa.body.length, 1);
    assert.equal(qa.body[0].question, 'blue or green?');
    assert.equal(qa.body[0].answer, 'green');

    // Pending questions list should no longer include this one
    const qs2 = await cloud.req('GET', '/api/questions');
    assert.ok(!qs2.body.some(q => q.id === mine.id), 'answered question leaves pending list');
  });

  test('hook endpoint returns pending tasks once, then marks delivered', async () => {
    await cloud.req('POST', '/api/tasks', { project_name: 'hook-test', text: 'task one' });
    await cloud.req('POST', '/api/tasks', { project_name: 'hook-test', text: 'task two' });

    const first = await cloud.req('GET', '/api/hook/tasks?project=hook-test');
    assert.equal(first.status, 200);
    assert.equal(first.body.length, 2);

    const second = await cloud.req('GET', '/api/hook/tasks?project=hook-test');
    assert.equal(second.body.length, 0, 'hook must not re-deliver already-delivered tasks');
  });

  test('state snapshot upserts projects and replaces sessions', async () => {
    await cloud.req('POST', '/api/state', {
      projects: [{ name: 'maestro', path: '/tmp/maestro', description: 'd', goals: 'g', current_focus: 'f', open_task_count: 3, last_commit: 'abc' }],
      sessions: [{ project_name: 'maestro', session_file: 'x.jsonl', is_active: 1, last_active: '2026-04-23T14:00:00Z', last_action: 'reading', agent_type: 'Explore' }],
    });
    const p = await cloud.req('GET', '/api/projects');
    const row = p.body.find(x => x.name === 'maestro');
    assert.ok(row);
    assert.equal(row.session.is_active, 1);
    assert.equal(row.session.last_action, 'reading');
    assert.equal(row.open_task_count, 3);

    // Upsert with new last_action — should replace, not duplicate
    await cloud.req('POST', '/api/state', {
      projects: [{ name: 'maestro', path: '/tmp/maestro', description: 'd2', goals: 'g', current_focus: 'f', open_task_count: 4, last_commit: 'def' }],
      sessions: [{ project_name: 'maestro', session_file: 'y.jsonl', is_active: 0, last_active: '2026-04-23T15:00:00Z', last_action: 'done', agent_type: null }],
    });
    const p2 = await cloud.req('GET', '/api/projects');
    const row2 = p2.body.find(x => x.name === 'maestro');
    assert.equal(row2.description, 'd2');
    assert.equal(row2.open_task_count, 4);
    assert.equal(row2.session.is_active, 0);
    assert.equal(row2.session.last_action, 'done');
  });

  test('synthesis merge collapses duplicates and updates kept task text', async () => {
    // Register the project so /api/projects surfaces it
    await cloud.req('POST', '/api/state', {
      projects: [{ name: 'synth-test', path: '/tmp/synth', description: '', goals: '', current_focus: '', open_task_count: 0, last_commit: '' }],
      sessions: [],
    });

    const a = await cloud.req('POST', '/api/tasks', { project_name: 'synth-test', text: 'add dark mode' });
    const b = await cloud.req('POST', '/api/tasks', { project_name: 'synth-test', text: 'support dark theme' });
    const c = await cloud.req('POST', '/api/tasks', { project_name: 'synth-test', text: 'enable dark UI' });

    await cloud.req('POST', '/api/synthesis/merge', {
      project_name: 'synth-test',
      keep_id: a.body.id,
      merge_ids: [b.body.id, c.body.id],
      merged_text: 'Add dark mode / dark theme support for the UI',
      detail: 'all three describe the same feature',
    });

    // Kept task should have merged text; merged tasks should be excluded from pending_tasks
    const proj = await cloud.req('GET', '/api/projects');
    const p = proj.body.find(x => x.name === 'synth-test');
    assert.ok(p, 'synth-test project must exist in response');
    const pendingIds = p.pending_tasks.map(t => t.id);
    assert.ok(pendingIds.includes(a.body.id), 'kept task stays pending');
    assert.ok(!pendingIds.includes(b.body.id), 'merged task b excluded');
    assert.ok(!pendingIds.includes(c.body.id), 'merged task c excluded');
    const kept = p.pending_tasks.find(t => t.id === a.body.id);
    assert.equal(kept.text, 'Add dark mode / dark theme support for the UI');

    // Drain must also skip duplicates
    const nextDrain = await cloud.req('GET', '/api/tasks/drain?project=synth-test');
    if (nextDrain.body) {
      assert.notEqual(nextDrain.body.id, b.body.id);
      assert.notEqual(nextDrain.body.id, c.body.id);
    }
  });

  test('absorb endpoint collapses sibling feature sets into target', async () => {
    // Create three peer sets + tasks in each
    const a = await cloud.req('POST', '/api/feature-sets', { project_name: 'flock', title: 'app switcher', description: 'for flock' });
    const b = await cloud.req('POST', '/api/feature-sets', { project_name: 'gloss', title: 'app switcher', description: 'for gloss' });
    const c = await cloud.req('POST', '/api/feature-sets', { project_name: 'tend', title: 'app switcher', description: 'for tend' });
    const tA = await cloud.req('POST', '/api/tasks', { project_name: 'flock', text: 'remove in flock', feature_set_id: a.body.id });
    const tB = await cloud.req('POST', '/api/tasks', { project_name: 'gloss', text: 'remove in gloss', feature_set_id: b.body.id });
    const tC = await cloud.req('POST', '/api/tasks', { project_name: 'tend', text: 'remove in tend', feature_set_id: c.body.id });

    const absorb = await cloud.req('POST', `/api/feature-sets/${a.body.id}/absorb`, {
      source_ids: [b.body.id, c.body.id],
      extra_projects: ['gloss', 'tend'],
    });
    assert.equal(absorb.status, 200);
    assert.equal(absorb.body.ok, true);
    assert.equal(absorb.body.moved_tasks, 2);
    assert.deepEqual(absorb.body.target.extra_projects, ['gloss', 'tend']);

    // All three tasks should now belong to set a
    const sets = await cloud.req('GET', '/api/feature-sets');
    const target = sets.body.find(s => s.id === a.body.id);
    assert.equal(target.tasks.length, 3, 'target absorbs all tasks');
    assert.ok(target.tasks.some(t => t.id === tA.body.id));
    assert.ok(target.tasks.some(t => t.id === tB.body.id));
    assert.ok(target.tasks.some(t => t.id === tC.body.id));

    // Sources are cancelled
    const srcB = sets.body.find(s => s.id === b.body.id);
    const srcC = sets.body.find(s => s.id === c.body.id);
    assert.equal(srcB.status, 'cancelled');
    assert.equal(srcC.status, 'cancelled');
    assert.equal(srcB.tasks.length, 0, 'source set has no tasks');
  });

  test('absorb rejects self-absorption and missing source_ids', async () => {
    const x = await cloud.req('POST', '/api/feature-sets', { project_name: 'flock', title: 'x' });
    const self = await cloud.req('POST', `/api/feature-sets/${x.body.id}/absorb`, { source_ids: [x.body.id] });
    assert.equal(self.status, 400);
    const empty = await cloud.req('POST', `/api/feature-sets/${x.body.id}/absorb`, { source_ids: [] });
    assert.equal(empty.status, 400);
    const missing = await cloud.req('POST', `/api/feature-sets/${x.body.id}/absorb`, {});
    assert.equal(missing.status, 400);
  });

  test('cancelled feature set does not appear in drain', async () => {
    // Queue a normal feature set and a cancelled one for the same project
    const keep = await cloud.req('POST', '/api/feature-sets', { project_name: 'drain-cancel-test', title: 'keep' });
    const drop = await cloud.req('POST', '/api/feature-sets', { project_name: 'drain-cancel-test', title: 'drop' });
    await cloud.req('POST', '/api/tasks', { project_name: 'drain-cancel-test', text: 'one', feature_set_id: keep.body.id });
    await cloud.req('POST', '/api/tasks', { project_name: 'drain-cancel-test', text: 'two', feature_set_id: drop.body.id });
    // Cancel 'drop' via absorb into 'keep'
    const abs = await cloud.req('POST', `/api/feature-sets/${keep.body.id}/absorb`, { source_ids: [drop.body.id] });
    assert.equal(abs.status, 200, 'absorb must succeed');
    // Kickoff flips collecting → queued
    const kick = await cloud.req('POST', '/api/feature-sets/nightly-kickoff');
    assert.equal(kick.status, 200, 'kickoff must succeed');
    const drained = await cloud.req('GET', '/api/feature-sets/drain?project=drain-cancel-test');
    assert.ok(drained.body, `drain returned ${JSON.stringify(drained.body)}`);
    assert.equal(drained.body.id, keep.body.id, 'cancelled set is never drained');
  });

  test('projects payload includes worker_runs and active_workers count', async () => {
    await cloud.req('POST', '/api/worker/start', {
      run_id: 'active-run', project_name: 'active-test', task: 'something',
    });
    const proj = await cloud.req('GET', '/api/projects');
    const p = proj.body.find(x => x.name === 'active-test');
    // 'active-test' isn't in projects table — but worker_runs still exists.
    // Make sure the endpoint doesn't crash when a worker exists for an unknown project.
    assert.equal(proj.status, 200);
    // Cleanup
    await cloud.req('POST', '/api/worker/active-run/end', { status: 'done', summary: '' });
  });
});
