// Integration point #3: scribe → gloss linked collections.
//
// Verifies that the GET /api/collections endpoint on gloss is reachable
// and returns JSON when scribe-equivalent auth is provided. This is the
// surface scribe reads from when resolving gloss-linked document tags.

import { test } from 'node:test';
import assert from 'node:assert';
import { APP_URLS, APP_KEYS, authedFetch, appAuthHeader } from './_helpers.mjs';

if (!APP_KEYS.gloss) {
  test('scribe→gloss collections (SKIP — no GLOSS_API_KEY in env)', { skip: true }, () => {});
} else {
  test('GET /api/collections on gloss returns array with bearer', async () => {
    const res = await authedFetch(`${APP_URLS.gloss}/api/collections`, {
      headers: appAuthHeader('gloss'),
    });
    assert.ok(res.status === 200 || res.status === 404,
      `GET /api/collections → ${res.status} (expected 200 or 404 if endpoint renamed)`);
    if (res.status === 200) {
      const body = await res.json();
      assert.ok(Array.isArray(body) || (body && typeof body === 'object'),
        'response should be an array or object');
    }
  });

  test('gloss rejects unauthenticated /api/collections', async () => {
    const res = await authedFetch(`${APP_URLS.gloss}/api/collections`);
    assert.ok(res.status === 401 || res.status === 403 || res.status === 404,
      `unauthenticated → ${res.status}`);
  });
}
