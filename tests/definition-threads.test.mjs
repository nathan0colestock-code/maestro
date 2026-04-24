// SPEC 7 — Feature Definition thread lifecycle: open → answer → approve.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { bootCloud } from './helpers.mjs';

describe('/api/definition-threads', () => {
  let cloud;
  before(async () => { cloud = await bootCloud(); });
  after(async () => { await cloud.close(); });

  test('rejects without auth', async () => {
    const r = await fetch(cloud.baseUrl + '/api/definition-threads');
    assert.equal(r.status, 401);
  });

  test('creates thread with questions', async () => {
    const r = await cloud.req('POST', '/api/definition-threads', {
      feature_title: 'Cross-app push reporter',
      questions: ['Which apps?', 'Priority?'],
      affected_apps: ['gloss', 'comms'],
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'open');
    assert.deepEqual(r.body.questions, ['Which apps?', 'Priority?']);
    assert.deepEqual(r.body.affected_apps, ['gloss', 'comms']);
  });

  test('rejects missing title', async () => {
    const r = await cloud.req('POST', '/api/definition-threads', { questions: [] });
    assert.equal(r.status, 400);
  });

  test('full lifecycle: open → answer → approve', async () => {
    const create = await cloud.req('POST', '/api/definition-threads', {
      feature_title: 'Nightly recap',
      questions: ['When should it fire?'],
    });
    const id = create.body.id;
    assert.equal(create.body.status, 'open');

    const ans = await cloud.req('POST', `/api/definition-threads/${id}/answer`, {
      answers: { 0: '23:00 local' },
    });
    assert.equal(ans.status, 200);
    assert.equal(ans.body.status, 'answered');
    assert.deepEqual(ans.body.answers, { 0: '23:00 local' });

    const approve = await cloud.req('POST', `/api/definition-threads/${id}/approve`, {
      generated_spec: '# Spec\nTrigger at 23:00 local.',
    });
    assert.equal(approve.status, 200);
    assert.equal(approve.body.status, 'approved');
    assert.ok(approve.body.approved_at);
    assert.match(approve.body.generated_spec, /Trigger at 23:00/);
  });

  test('approve requires generated_spec', async () => {
    const { body } = await cloud.req('POST', '/api/definition-threads', {
      feature_title: 'X',
    });
    const r = await cloud.req('POST', `/api/definition-threads/${body.id}/approve`, {});
    assert.equal(r.status, 400);
  });

  test('list endpoint filters by status', async () => {
    const r = await cloud.req('GET', '/api/definition-threads?status=approved');
    assert.equal(r.status, 200);
    for (const t of r.body) assert.equal(t.status, 'approved');
  });
});
