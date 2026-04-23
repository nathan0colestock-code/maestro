// Shared test helpers — boot an isolated cloud server on an ephemeral port
// backed by a temp SQLite file, so every test file runs against clean state.

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const SECRET = 'test-secret-' + Math.random().toString(36).slice(2);

export async function bootCloud() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'maestro-test-'));
  const dbPath = join(tmpDir, 'test.db');

  process.env.MAESTRO_DB_PATH = dbPath;
  process.env.MAESTRO_SECRET = SECRET;
  process.env.MAESTRO_PASSWORD = 'test-password';
  delete process.env.NODE_ENV;

  // Dynamic import so env is set first
  const { default: app } = await import('../cloud/server.js?' + Math.random());

  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    secret: SECRET,
    async close() {
      await new Promise(r => server.close(r));
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    },
    // Convenience fetch with auth + JSON handling
    async req(method, path, body) {
      const res = await fetch(baseUrl + path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Maestro-Secret': SECRET,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      let json = null;
      try { json = await res.json(); } catch {}
      return { status: res.status, body: json, ok: res.ok };
    },
  };
}
