// local/log-collector.js — pull cursor, dedup on overlap, 404 tolerance.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pullForApp, runCollectorOnce, resolveApps, cleanupOldLogs } from '../local/log-collector.js';
import { bootCloud } from './helpers.mjs';

function mockFetch(routes) {
  return async (url) => {
    const handler = routes[url] || routes['*'];
    if (!handler) return { ok: false, status: 404, json: async () => ({}) };
    return handler(url);
  };
}

describe('log-collector', () => {
  test('resolveApps picks up only apps with URL configured', () => {
    const env = { GLOSS_URL: 'https://g', COMMS_URL: '' };
    const out = resolveApps(env);
    assert.deepEqual(out.map(a => a.name), ['gloss']);
    assert.equal(out[0].url, 'https://g');
  });

  test('pullForApp tolerates 404 without crashing', async () => {
    const fetchImpl = mockFetch({
      'https://gloss/api/logs/recent?limit=1000': async () => ({
        ok: false, status: 404, json: async () => ({}),
      }),
    });
    const r = await pullForApp({ app: 'gloss', url: 'https://gloss', bearer: 't', fetchImpl });
    assert.equal(r.skipped, true);
    assert.match(r.reason, /404/);
  });

  test('pullForApp returns entries and advances cursor', async () => {
    const entries = [
      { ts: '2026-04-23T00:00:00.000Z', event: 'http' },
      { ts: '2026-04-23T00:05:00.000Z', event: 'llm_call' },
    ];
    const fetchImpl = mockFetch({
      '*': async () => ({ ok: true, status: 200, json: async () => ({ entries }) }),
    });
    const r = await pullForApp({ app: 'gloss', url: 'https://gloss', bearer: 't', fetchImpl });
    assert.equal(r.entries.length, 2);
    assert.equal(r.newCursor, '2026-04-23T00:05:00.000Z');
  });

  test('runCollectorOnce ingests into cloud and updates cursor (integration)', async () => {
    const cloud = await bootCloud();
    try {
      const env = { GLOSS_URL: 'https://gloss', SUITE_API_KEY: 'suite-k' };
      const first = [{ ts: '2026-04-23T00:00:00.000Z', event: 'http', level: 'info', ctx: { path: '/a' } }];
      const second = [
        { ts: '2026-04-23T00:00:00.000Z', event: 'http', level: 'info', ctx: { path: '/a' } }, // overlap
        { ts: '2026-04-23T00:05:00.000Z', event: 'http', level: 'warn', ctx: { path: '/b' } },
      ];
      let call = 0;
      const fetchImpl = async () => {
        call++;
        return { ok: true, status: 200, json: async () => ({ entries: call === 1 ? first : second }) };
      };

      const cloudApi = async (method, path, body) => {
        const res = await fetch(cloud.baseUrl + path, {
          method,
          headers: { 'Content-Type': 'application/json', 'X-Maestro-Secret': cloud.secret },
          body: body ? JSON.stringify(body) : undefined,
        });
        return res.json();
      };

      const r1 = await runCollectorOnce({ cloudApi, env, fetchImpl });
      const glossReport1 = r1.apps.find(a => a.app === 'gloss');
      assert.equal(glossReport1.inserted, 1);

      const r2 = await runCollectorOnce({ cloudApi, env, fetchImpl });
      const glossReport2 = r2.apps.find(a => a.app === 'gloss');
      assert.equal(glossReport2.inserted, 1, 'only the NEW row inserts on the second pass');
    } finally {
      await cloud.close();
    }
  });

  test('no SUITE_API_KEY → returns skip', async () => {
    const r = await runCollectorOnce({ cloudApi: async () => ({}), env: {}, fetchImpl: async () => ({}) });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-suite-api-key');
  });
});

describe('cleanupOldLogs', () => {
  test('issues DELETE with the right bind param', async () => {
    const calls = [];
    const fakeDb = {
      prepare(sql) {
        return { run: (p) => { calls.push({ sql, p }); return { changes: 3 }; } };
      },
    };
    const r = await cleanupOldLogs({ db: fakeDb, days: 7 });
    assert.equal(r.deleted, 3);
    assert.match(calls[0].sql, /DELETE FROM suite_logs/);
    assert.equal(calls[0].p, '-7 days');
  });

  test('no-op when db missing', async () => {
    const r = await cleanupOldLogs({ db: null });
    assert.equal(r.deleted, 0);
  });
});
