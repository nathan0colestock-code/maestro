// Structured logging contract — unit + integration.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { log, getRecent, clearRing, RING_MAX } from '../cloud/log.js';
import { bootCloud } from './helpers.mjs';

describe('log.js ring buffer', () => {
  test('bounded at RING_MAX', () => {
    clearRing();
    for (let i = 0; i < RING_MAX + 50; i++) log('info', 'x', { i });
    const recent = getRecent({ limit: RING_MAX + 100 });
    assert.equal(recent.length, RING_MAX);
    // Newest survives; oldest drops off.
    assert.equal(recent[recent.length - 1].ctx.i, RING_MAX + 49);
  });

  test('level filter', () => {
    clearRing();
    log('debug', 'a'); log('info', 'b'); log('warn', 'c'); log('error', 'd');
    const warns = getRecent({ level: 'warn' });
    assert.deepEqual(warns.map(e => e.event), ['c', 'd']);
  });

  test('since filter', async () => {
    clearRing();
    log('info', 'early');
    await new Promise(r => setTimeout(r, 5));
    const cutoff = new Date().toISOString();
    await new Promise(r => setTimeout(r, 5));
    log('info', 'late');
    const since = getRecent({ since: cutoff });
    assert.deepEqual(since.map(e => e.event), ['late']);
  });

  test('hoists well-known fields', () => {
    clearRing();
    log('info', 'http', { trace_id: 't1', request_id: 'r1', duration_ms: 42 });
    const [e] = getRecent({});
    assert.equal(e.trace_id, 't1');
    assert.equal(e.request_id, 'r1');
    assert.equal(e.duration_ms, 42);
  });
});

describe('/api/logs/recent endpoint', () => {
  let cloud;
  before(async () => { cloud = await bootCloud(); });
  after(async () => { await cloud.close(); });

  test('rejects without bearer', async () => {
    const res = await fetch(cloud.baseUrl + '/api/logs/recent');
    assert.equal(res.status, 401);
  });

  test('returns entries after activity', async () => {
    // Hit any endpoint to generate an http log entry.
    await cloud.req('GET', '/api/projects');
    const r = await cloud.req('GET', '/api/logs/recent?limit=50');
    assert.equal(r.status, 200);
    assert.equal(r.body.app, 'maestro');
    assert.ok(Array.isArray(r.body.entries));
    assert.ok(r.body.entries.some(e => e.event === 'http' && e.ctx?.path?.startsWith('/api/projects')));
  });

  test('level filter works end-to-end', async () => {
    const r = await cloud.req('GET', '/api/logs/recent?level=warn');
    // Should only contain warn+error.
    for (const e of r.body.entries) {
      assert.ok(['warn', 'error'].includes(e.level), `unexpected level ${e.level}`);
    }
  });

  test('http middleware stamps X-Trace-Id', async () => {
    const res = await fetch(cloud.baseUrl + '/api/health', {
      headers: { 'X-Trace-Id': 'abc-123' },
    });
    assert.equal(res.headers.get('x-trace-id'), 'abc-123');
  });
});
