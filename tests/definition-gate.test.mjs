// SPEC 7 gate matcher — daemon dispatch must match feature sets to approved
// definition threads by title OR by affected_apps overlap.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { matchThreadToSet } from '../local/definition-gate.js';

describe('matchThreadToSet', () => {
  test('returns null when there are no threads', () => {
    assert.equal(matchThreadToSet({ title: 'x' }, []), null);
    assert.equal(matchThreadToSet({ title: 'x' }, null), null);
  });

  test('skips non-approved threads', () => {
    const threads = [{ feature_title: 'x', status: 'open' }];
    assert.equal(matchThreadToSet({ title: 'x' }, threads), null);
  });

  test('matches by exact title (case-insensitive)', () => {
    const threads = [{ feature_title: 'Add Push Notifications', status: 'approved' }];
    const t = matchThreadToSet({ title: 'add push notifications' }, threads);
    assert.ok(t);
    assert.equal(t.feature_title, 'Add Push Notifications');
  });

  test('matches by title substring either direction', () => {
    const threads = [{ feature_title: 'Push notifications', status: 'approved' }];
    const t = matchThreadToSet({ title: 'Add push notifications to PWA' }, threads);
    assert.ok(t);
  });

  test('matches by affected_apps overlap (>=2)', () => {
    const threads = [{
      feature_title: 'Something else',
      affected_apps: ['gloss', 'comms', 'maestro'],
      status: 'approved',
    }];
    const t = matchThreadToSet({
      title: 'completely different title',
      project_name: 'gloss',
      extra_projects: ['comms'],
    }, threads);
    assert.ok(t);
  });

  test('does NOT match on single-app overlap', () => {
    const threads = [{
      feature_title: 'X',
      affected_apps: ['gloss'],
      status: 'approved',
    }];
    const t = matchThreadToSet({
      title: 'Y',
      project_name: 'gloss',
      extra_projects: ['comms'],
    }, threads);
    assert.equal(t, null);
  });

  test('returns the first matching thread', () => {
    const threads = [
      { feature_title: 'aaa', status: 'approved' },
      { feature_title: 'bbb', status: 'approved' },
    ];
    const t = matchThreadToSet({ title: 'bbb' }, threads);
    assert.equal(t.feature_title, 'bbb');
  });
});
