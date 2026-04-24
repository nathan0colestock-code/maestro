// SPEC 6 — push_subscriptions CRUD + vapid-public.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { bootCloud } from './helpers.mjs';

describe('push subscription CRUD', () => {
  let cloud;
  before(async () => { cloud = await bootCloud(); });
  after(async () => { await cloud.close(); });

  test('vapid-public is reachable without auth', async () => {
    const r = await fetch(cloud.baseUrl + '/api/push/vapid-public');
    assert.equal(r.status, 200);
    const body = await r.json();
    // When VAPID_PUBLIC_KEY is absent, enabled=false but endpoint still 200.
    assert.equal(typeof body.public_key, 'string');
    assert.equal(typeof body.enabled, 'boolean');
  });

  test('subscribe requires endpoint', async () => {
    const r = await cloud.req('POST', '/api/push/subscribe', {});
    assert.equal(r.status, 400);
  });

  test('subscribe upserts by endpoint', async () => {
    const r1 = await cloud.req('POST', '/api/push/subscribe', {
      endpoint: 'https://example.com/push/abc',
      keys: { p256dh: 'X', auth: 'Y' },
      user_agent: 'ua-1',
    });
    assert.equal(r1.status, 200);
    assert.ok(r1.body.id);

    const r2 = await cloud.req('POST', '/api/push/subscribe', {
      endpoint: 'https://example.com/push/abc',
      keys: { p256dh: 'X2', auth: 'Y2' },
      user_agent: 'ua-2',
    });
    assert.equal(r2.status, 200);
    assert.equal(r2.body.id, r1.body.id, 'upsert keeps id');

    const listed = await cloud.req('GET', '/api/push/subscriptions');
    const row = listed.body.find(s => s.endpoint === 'https://example.com/push/abc');
    assert.equal(row.user_agent, 'ua-2');
  });

  test('delete removes subscription', async () => {
    const r = await cloud.req('POST', '/api/push/subscribe', {
      endpoint: 'https://example.com/push/del',
    });
    const id = r.body.id;
    await cloud.req('DELETE', `/api/push/subscribe/${id}`);
    const listed = await cloud.req('GET', '/api/push/subscriptions');
    assert.ok(!listed.body.some(s => s.id === id));
  });
});
