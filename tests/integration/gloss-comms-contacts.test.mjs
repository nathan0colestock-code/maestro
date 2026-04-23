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

// comms' POST /api/gloss/contacts expects rows shaped
// `{ contact, gloss_id, gloss_url?, ... }` — NOT the older
// `{ display_name, gloss_person_id, emails }` shape this test used
// to send. With the wrong shape, comms returns 200 with `saved: 0,
// errors: [...]` and the old 2xx-only assertion passed silently, so
// the integration test was green while real merges broke the
// contract. Now we send the contract-correct shape AND assert
// `saved >= 1` so any future shape drift fails loudly.
const PROBE_PAYLOAD = {
  contacts: [{
    contact: 'Suite Integration Probe',
    gloss_id: 'suite-integration-probe',
    gloss_url: 'https://gloss-nc.fly.dev/probe',
    emails: ['suite-integration-probe@example.invalid'],
    phones: [],
    notes: 'Written by maestro/tests/integration/gloss-comms-contacts.test.mjs — safe to delete',
  }],
};

if (!APP_KEYS.comms) {
  test('gloss→comms contact push (SKIP — no COMMS_API_KEY in env)', { skip: true }, () => {});
} else {
  test('POST /api/gloss/contacts on comms accepts bearer + valid payload', async () => {
    const res = await authedFetch(`${APP_URLS.comms}/api/gloss/contacts`, {
      method: 'POST',
      headers: { ...appAuthHeader('comms'), 'Content-Type': 'application/json' },
      body: JSON.stringify(PROBE_PAYLOAD),
    });
    const bodyText = await res.text().catch(() => '');
    assert.ok(
      res.status >= 200 && res.status < 300,
      `POST /api/gloss/contacts → ${res.status}: ${bodyText}`
    );
    // comms returns { saved, errors: [...] }. The old test asserted only
    // 2xx, so a wrong payload shape (saved:0) passed silently. Assert at
    // least one contact was actually persisted.
    let body;
    try { body = JSON.parse(bodyText); } catch { body = null; }
    assert.ok(body, `expected JSON body, got: ${bodyText.slice(0, 300)}`);
    assert.ok(
      typeof body.saved === 'number' && body.saved >= 1,
      `expected saved >= 1, got ${body.saved} with errors=${JSON.stringify(body.errors || [])}`
    );
  });

  test('POST /api/gloss/contacts rejects unauthenticated requests', async () => {
    const res = await authedFetch(`${APP_URLS.comms}/api/gloss/contacts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(PROBE_PAYLOAD),
    });
    assert.ok(res.status === 401 || res.status === 403,
      `unauthenticated POST → ${res.status} (expected 401/403)`);
  });
}
