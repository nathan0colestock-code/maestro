// SPEC 6 — notifier dispatches and dedupes.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildNotifier } from '../local/notifier.js';

function makeCloud(subs) {
  return async (method, path) => {
    if (path === '/api/push/subscriptions') return subs;
    return [];
  };
}

describe('notifier', () => {
  test('is disabled when vapid keys + sendImpl both absent', () => {
    const n = buildNotifier({ cloudApi: makeCloud([]) });
    assert.equal(n.enabled, false);
  });

  test('enabled when sendImpl injected', () => {
    const n = buildNotifier({
      cloudApi: makeCloud([]),
      sendImpl: async () => ({}),
    });
    assert.equal(n.enabled, true);
  });

  test('dispatches on feature_set_queued and dedupes second call', async () => {
    const calls = [];
    const sendImpl = async (sub, payload) => { calls.push({ sub, payload }); };
    const n = buildNotifier({
      cloudApi: makeCloud([
        { endpoint: 'https://a', keys: { p256dh: 'a', auth: 'b' } },
        { endpoint: 'https://b', keys: { p256dh: 'c', auth: 'd' } },
      ]),
      sendImpl,
    });
    const r1 = await n.handleFeatureSetTransition({ id: 42, status: 'queued', title: 'Feature X' });
    assert.equal(r1.transition, 'feature_set_queued');
    assert.equal(r1.sent, 2);
    assert.equal(calls.length, 2);

    const r2 = await n.handleFeatureSetTransition({ id: 42, status: 'queued', title: 'Feature X' });
    assert.equal(r2.skipped, 'dedup');
    assert.equal(calls.length, 2, 'no additional sends');
  });

  test('maps statuses to correct transition names', async () => {
    const fired = [];
    const n = buildNotifier({
      cloudApi: makeCloud([{ endpoint: 'x' }]),
      sendImpl: async (sub, p) => { fired.push(p.transition); },
    });
    await n.handleFeatureSetTransition({ id: 1, status: 'done' });
    await n.handleFeatureSetTransition({ id: 2, status: 'failed' });
    await n.handleFeatureSetTransition({ id: 3, status: 'test_failed' });
    await n.handleFeatureSetTransition({ id: 4, status: 'merge_requested' });
    assert.deepEqual(fired, [
      'feature_set_done',
      'feature_set_failed',
      'feature_set_failed',
      'feature_set_done',
    ]);
  });

  test('ignores non-notifiable statuses', async () => {
    const n = buildNotifier({ cloudApi: makeCloud([{ endpoint: 'x' }]), sendImpl: async () => {} });
    const r = await n.handleFeatureSetTransition({ id: 1, status: 'collecting' });
    assert.equal(r, null);
  });

  test('suite log error burst dedupes within the same hour', async () => {
    const sends = [];
    const n = buildNotifier({
      cloudApi: makeCloud([{ endpoint: 'x' }]),
      sendImpl: async (sub, p) => { sends.push(p); },
    });
    await n.handleSuiteLogErrorBurst({ app: 'gloss', count: 5 });
    await n.handleSuiteLogErrorBurst({ app: 'gloss', count: 7 });
    assert.equal(sends.length, 1);
  });
});
