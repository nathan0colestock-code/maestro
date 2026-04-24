// Suite log ingest/query + cursor + dedup on overlap.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { bootCloud } from './helpers.mjs';

describe('/api/suite-logs', () => {
  let cloud;
  before(async () => { cloud = await bootCloud(); });
  after(async () => { await cloud.close(); });

  test('ingest stores entries and advances cursor', async () => {
    const entries = [
      { ts: '2026-04-23T00:00:00.000Z', level: 'info', event: 'http', ctx: { path: '/a' } },
      { ts: '2026-04-23T00:01:00.000Z', level: 'warn', event: 'llm_call', ctx: { status: 429 } },
    ];
    const r = await cloud.req('POST', '/api/suite-logs/ingest', { app: 'gloss', entries });
    assert.equal(r.status, 200);
    assert.equal(r.body.inserted, 2);
    assert.equal(r.body.cursor, '2026-04-23T00:01:00.000Z');

    const cursor = await cloud.req('GET', '/api/suite-logs/cursor');
    const row = cursor.body.find(c => c.app === 'gloss');
    assert.equal(row.last_pulled_ts, '2026-04-23T00:01:00.000Z');
  });

  test('re-ingesting overlap is deduped', async () => {
    const entries = [
      { ts: '2026-04-23T00:01:00.000Z', level: 'warn', event: 'llm_call', ctx: { status: 429 } },
      { ts: '2026-04-23T00:02:00.000Z', level: 'error', event: 'db_error', ctx: { code: 'BUSY' } },
    ];
    const r = await cloud.req('POST', '/api/suite-logs/ingest', { app: 'gloss', entries });
    // Only the new one is inserted.
    assert.equal(r.body.inserted, 1);
  });

  test('query filters by app + level', async () => {
    const r = await cloud.req('GET', '/api/suite-logs?app=gloss&level=warn');
    assert.equal(r.status, 200);
    for (const e of r.body) {
      assert.equal(e.app, 'gloss');
      assert.ok(['warn', 'error'].includes(e.level));
    }
  });

  test('ingest rejects malformed payload', async () => {
    const r = await cloud.req('POST', '/api/suite-logs/ingest', { entries: [] });
    assert.equal(r.status, 400);
  });
});

describe('/api/self-improvement', () => {
  let cloud;
  before(async () => { cloud = await bootCloud(); });
  after(async () => { await cloud.close(); });

  test('latest returns null when empty', async () => {
    const r = await cloud.req('GET', '/api/self-improvement/latest');
    assert.equal(r.status, 200);
    assert.equal(r.body, null);
  });

  test('post + latest round-trip', async () => {
    const summary = { wins: ['shipped feature X'], struggles: [], self_improvements: [] };
    await cloud.req('POST', '/api/self-improvement', { date: '2026-04-23', summary });
    const r = await cloud.req('GET', '/api/self-improvement/latest');
    assert.equal(r.body.date, '2026-04-23');
    assert.deepEqual(r.body.summary, summary);
  });

  test('budget post increments and reads back', async () => {
    const d = '2026-04-23';
    await cloud.req('POST', '/api/self-improvement/budget', {
      date: d, prs_opened_delta: 1, cost_usd_delta: 0.5,
    });
    await cloud.req('POST', '/api/self-improvement/budget', {
      date: d, prs_opened_delta: 1, cost_usd_delta: 0.75,
    });
    const r = await cloud.req('GET', `/api/self-improvement/budget?date=${d}`);
    assert.equal(r.body.prs_opened, 2);
    assert.equal(r.body.cost_usd, 1.25);
  });
});
