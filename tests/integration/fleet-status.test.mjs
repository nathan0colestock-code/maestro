// Integration point #6: Maestro polls all 5 apps' /api/status with SUITE_API_KEY.
// Verifies every app is reachable and returns the suite-standard shape.

import { test } from 'node:test';
import assert from 'node:assert';
import { APP_URLS, SUITE_API_KEY, authedFetch, suiteAuthHeader, validateStatusShape } from './_helpers.mjs';

const apps = Object.entries(APP_URLS);

if (!SUITE_API_KEY) {
  test('fleet /api/status (SKIP — no SUITE_API_KEY in env)', { skip: true }, () => {});
} else {
  for (const [appName, url] of apps) {
    test(`${appName}: GET /api/status returns 200 with suite shape`, async () => {
      const res = await authedFetch(`${url}/api/status`, { headers: suiteAuthHeader() });
      assert.strictEqual(res.status, 200, `${appName} /api/status → ${res.status}`);
      const body = await res.json();
      const v = validateStatusShape(body, appName);
      assert.ok(v.ok, `${appName} shape errors: ${v.errors.join('; ')}`);
    });

    test(`${appName}: GET /api/health is public (no auth required)`, async () => {
      const res = await authedFetch(`${url}/api/health`);
      assert.strictEqual(res.status, 200, `${appName} /api/health → ${res.status}`);
      const body = await res.json();
      assert.strictEqual(body?.ok, true);
    });

    test(`${appName}: /api/status rejects unauthenticated requests`, async () => {
      const res = await authedFetch(`${url}/api/status`);
      assert.ok(res.status === 401 || res.status === 403,
        `${appName} unauthenticated /api/status → ${res.status} (expected 401/403)`);
    });
  }
}
