// Integration point #9: Maestro → Gloss voice memo proxy.
//
// Verifies that POST /api/gloss/voice on maestro-cloud:
//   1. Rejects unauthenticated requests.
//   2. Returns 503 when GLOSS_URL/GLOSS_API_KEY are absent (env-only check).
//   3. When GLOSS_API_KEY is set: proxies a transcript to Gloss and returns
//      ok:true, page_id, and a review_url so the PWA can link back.

import { test } from 'node:test';
import assert from 'node:assert';
import { APP_URLS, APP_KEYS, authedFetch, appAuthHeader } from './_helpers.mjs';

const MAESTRO_PASSWORD = process.env.MAESTRO_PASSWORD || '';
const maestroAuthHeader = MAESTRO_PASSWORD
  ? { 'X-Maestro-Password': MAESTRO_PASSWORD, 'Content-Type': 'application/json' }
  : {};

test('maestro POST /api/gloss/voice rejects unauthenticated', async () => {
  const res = await authedFetch(`${APP_URLS.maestro}/api/gloss/voice`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript: 'test' }),
  });
  assert.ok(
    res.status === 401 || res.status === 403,
    `unauthenticated → ${res.status} (expected 401 or 403)`
  );
});

if (!MAESTRO_PASSWORD) {
  test('maestro POST /api/gloss/voice (SKIP — no MAESTRO_PASSWORD)', { skip: true }, () => {});
} else {
  test('POST /api/gloss/voice returns 400 for missing transcript', async () => {
    const res = await authedFetch(`${APP_URLS.maestro}/api/gloss/voice`, {
      method: 'POST',
      headers: maestroAuthHeader,
      body: JSON.stringify({}),
    });
    assert.strictEqual(res.status, 400, `missing transcript → ${res.status}`);
  });

  test('POST /api/gloss/voice returns 400 for blank transcript', async () => {
    const res = await authedFetch(`${APP_URLS.maestro}/api/gloss/voice`, {
      method: 'POST',
      headers: maestroAuthHeader,
      body: JSON.stringify({ transcript: '   ' }),
    });
    assert.strictEqual(res.status, 400, `blank transcript → ${res.status}`);
  });

  if (!APP_KEYS.gloss) {
    test('maestro→gloss full proxy (SKIP — no GLOSS_API_KEY)', { skip: true }, () => {});
  } else {
    test('POST /api/gloss/voice proxies to Gloss and returns page_id + review_url', async () => {
      const res = await authedFetch(`${APP_URLS.maestro}/api/gloss/voice`, {
        method: 'POST',
        headers: maestroAuthHeader,
        body: JSON.stringify({
          transcript: 'Integration test capture — safe to ignore. Just a quick note from the Maestro test suite.',
        }),
      });

      const body = await res.json().catch(() => ({}));

      assert.ok(
        res.status >= 200 && res.status < 300,
        `POST /api/gloss/voice → ${res.status}: ${JSON.stringify(body)}`
      );
      assert.strictEqual(body.ok, true, 'response.ok should be true');
      assert.ok(body.page_id, 'response should include page_id');
      assert.ok(body.review_url, 'response should include review_url');
      assert.ok(
        typeof body.review_url === 'string' && body.review_url.includes('/daily/'),
        `review_url should contain /daily/: got ${body.review_url}`
      );
      assert.ok(
        typeof body.capture_id === 'number',
        'response should include capture_id from Maestro captures table'
      );
    });
  }
}
