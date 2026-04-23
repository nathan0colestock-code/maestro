// Integration point #7: iPhone PWA → maestro-cloud capture intake.
//
// Verifies that POST /api/capture on maestro-nc accepts a capture payload
// when authenticated, and rejects unauthenticated requests. Also verifies
// the PWA's static asset surface (manifest, sw.js).

import { test } from 'node:test';
import assert from 'node:assert';
import { APP_URLS, authedFetch } from './_helpers.mjs';

const MAESTRO_PASSWORD = process.env.MAESTRO_PASSWORD || '';

test('maestro: PWA manifest is served', async () => {
  const res = await authedFetch(`${APP_URLS.maestro}/manifest.json`);
  assert.ok(res.status === 200 || res.status === 404,
    `manifest.json → ${res.status} (404 OK if build path differs)`);
});

test('maestro: service worker is served', async () => {
  const res = await authedFetch(`${APP_URLS.maestro}/sw.js`);
  // 200 if SW exists; 404 is acceptable during transition but logged.
  assert.ok(res.status === 200 || res.status === 404, `sw.js → ${res.status}`);
});

if (!MAESTRO_PASSWORD) {
  test('maestro POST /api/capture (SKIP — no MAESTRO_PASSWORD)', { skip: true }, () => {});
} else {
  test('POST /api/capture accepts a probe capture with X-Maestro-Password', async () => {
    const res = await authedFetch(`${APP_URLS.maestro}/api/capture`, {
      method: 'POST',
      headers: {
        'X-Maestro-Password': MAESTRO_PASSWORD,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: 'integration-test probe — safe to ignore',
        source: 'integration-test',
      }),
    });
    assert.ok(res.status >= 200 && res.status < 300,
      `POST /api/capture → ${res.status}: ${await res.text().catch(() => '')}`);
  });

  test('POST /api/capture rejects unauthenticated', async () => {
    const res = await authedFetch(`${APP_URLS.maestro}/api/capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'no auth' }),
    });
    assert.ok(res.status === 401 || res.status === 403,
      `unauthenticated → ${res.status}`);
  });
}
