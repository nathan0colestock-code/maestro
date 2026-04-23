// Integration point #1: gloss → comms contact push.
//
// Verifies that the POST /api/gloss/contacts endpoint on comms accepts a
// well-formed gloss contact payload. We test against the CURRENT production
// deployment; the daemon runs this after every merged_and_deployed pipeline.
//
// We use a "probe" contact with a clearly-test email prefix so repeated runs
// don't pollute real data. The comms side should idempotently upsert.

import { test } from 'node:test';
import assert from 'node:assert';
import { APP_URLS, APP_KEYS, authedFetch, appAuthHeader } from './_helpers.mjs';

const PROBE_CONTACT = {
  gloss_person_id: 'suite-integration-probe',
  display_name: 'Suite Integration Probe',
  emails: ['suite-integration-probe@example.invalid'],
  phones: [],
  notes: 'Written by maestro/tests/integration/gloss-comms-contacts.test.mjs — safe to delete',
};

if (!APP_KEYS.comms) {
  test('gloss→comms contact push (SKIP — no COMMS_API_KEY in env)', { skip: true }, () => {});
} else {
  test('POST /api/gloss/contacts on comms accepts bearer + valid payload', async () => {
    const res = await authedFetch(`${APP_URLS.comms}/api/gloss/contacts`, {
      method: 'POST',
      headers: { ...appAuthHeader('comms'), 'Content-Type': 'application/json' },
      body: JSON.stringify(PROBE_CONTACT),
    });
    assert.ok(res.status >= 200 && res.status < 300,
      `POST /api/gloss/contacts → ${res.status}: ${await res.text().catch(() => '')}`);
  });

  test('POST /api/gloss/contacts rejects unauthenticated requests', async () => {
    const res = await authedFetch(`${APP_URLS.comms}/api/gloss/contacts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(PROBE_CONTACT),
    });
    assert.ok(res.status === 401 || res.status === 403,
      `unauthenticated POST → ${res.status} (expected 401/403)`);
  });
}
