// improvement-agent extensions: summarizeSuiteLogs.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeSuiteLogs } from '../local/improvement-agent.js';

describe('summarizeSuiteLogs', () => {
  test('empty input returns zero totals', () => {
    assert.deepEqual(summarizeSuiteLogs([]), { total: 0, by_app: {} });
    assert.deepEqual(summarizeSuiteLogs(null), { total: 0, by_app: {} });
  });

  test('aggregates per app and ranks top events', () => {
    const rows = [
      { app: 'gloss', level: 'error', event: 'db_error', ctx: { code: 'X' } },
      { app: 'gloss', level: 'warn', event: 'llm_retry', ctx: {} },
      { app: 'gloss', level: 'warn', event: 'llm_retry', ctx: {} },
      { app: 'gloss', level: 'error', event: 'llm_retry', ctx: {} },
      { app: 'comms', level: 'warn', event: 'slow_query', ctx: {} },
    ];
    const s = summarizeSuiteLogs(rows);
    assert.equal(s.total, 5);
    assert.equal(s.by_app.gloss.error, 2);
    assert.equal(s.by_app.gloss.warn, 2);
    // llm_retry is the most common event for gloss
    assert.equal(s.by_app.gloss.top_events[0].name, 'llm_retry');
    assert.equal(s.by_app.gloss.top_events[0].count, 3);
    // sample list capped at 3
    assert.ok(s.by_app.gloss.samples.length <= 3);
    assert.equal(s.by_app.comms.warn, 1);
  });
});
