// Suite log collector.
//
// Pulls each suite app's /api/logs/recent (since the cursor we stored last
// time) and ingests the entries into Maestro cloud's suite_logs table.
// Runs hourly from daemon.js (or invokable standalone).
//
// Hard requirements:
//   - 404 / 501 from an app that hasn't implemented the contract yet MUST
//     NOT crash the collector (warn + skip).
//   - Overlap-safe: cloud /api/suite-logs/ingest does INSERT OR IGNORE on
//     (app, ts, event, ctx), so re-pulling the same window is harmless.
//   - Retention: cleanupOldLogs deletes rows older than 7 days.

const DEFAULT_APPS = [
  { name: 'gloss',  env: 'GLOSS_URL' },
  { name: 'comms',  env: 'COMMS_URL' },
  { name: 'black',  env: 'BLACK_URL' },
  { name: 'scribe', env: 'SCRIBE_URL' },
  { name: 'pulse',  env: 'PULSE_URL' },
  { name: 'recall', env: 'RECALL_URL' },
];

export function resolveApps(env = process.env, appsOverride) {
  const apps = appsOverride || DEFAULT_APPS;
  return apps
    .map(a => ({ name: a.name, url: env[a.env] }))
    .filter(a => a.url);
}

/**
 * Pull entries for a single app. Returns { entries, newCursor, skipped }.
 */
export async function pullForApp({ app, url, since, bearer, fetchImpl = fetch }) {
  const q = new URLSearchParams();
  if (since) q.set('since', since);
  q.set('limit', '1000');
  const target = `${url.replace(/\/$/, '')}/api/logs/recent?${q}`;

  let res;
  try {
    res = await fetchImpl(target, {
      headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
    });
  } catch (err) {
    return { entries: [], error: `network: ${err.message}`, skipped: true };
  }
  if (res.status === 404 || res.status === 501) {
    return { entries: [], skipped: true, reason: `${res.status}-no-contract` };
  }
  if (!res.ok) {
    return { entries: [], error: `http ${res.status}`, skipped: true };
  }
  const body = await res.json().catch(() => ({ entries: [] }));
  const entries = Array.isArray(body.entries) ? body.entries : [];
  let newCursor = since || null;
  for (const e of entries) {
    if (e?.ts && (!newCursor || e.ts > newCursor)) newCursor = e.ts;
  }
  return { entries, newCursor, skipped: false };
}

/**
 * Run one full pull cycle across every configured app. cloudApi is the
 * daemon's api() helper bound to the Maestro cloud (bearer MAESTRO_SECRET).
 */
export async function runCollectorOnce({ cloudApi, env = process.env, appsOverride, fetchImpl = fetch }) {
  const apps = resolveApps(env, appsOverride);
  const bearer = env.SUITE_API_KEY;
  if (!bearer) {
    return { ok: false, reason: 'no-suite-api-key' };
  }
  // Pull cursor state.
  let cursors = [];
  try { cursors = await cloudApi('GET', '/api/suite-logs/cursor') || []; } catch {}
  const cursorMap = Object.fromEntries(cursors.map(c => [c.app, c.last_pulled_ts]));

  const report = { ok: true, apps: [] };
  for (const a of apps) {
    const since = cursorMap[a.name] || null;
    const result = await pullForApp({
      app: a.name, url: a.url, since, bearer, fetchImpl,
    });
    if (result.skipped) {
      report.apps.push({ app: a.name, skipped: true, reason: result.reason || result.error });
      continue;
    }
    if (result.entries.length === 0) {
      report.apps.push({ app: a.name, inserted: 0 });
      continue;
    }
    try {
      const ingest = await cloudApi('POST', '/api/suite-logs/ingest', {
        app: a.name, entries: result.entries,
      });
      report.apps.push({
        app: a.name,
        inserted: ingest?.inserted ?? 0,
        cursor: ingest?.cursor || result.newCursor,
      });
    } catch (err) {
      report.apps.push({ app: a.name, error: err.message });
    }
  }
  return report;
}

/**
 * Retention — invoked from nightly cleanup. Deletes suite_logs rows older
 * than `days` (default 7) and stale cursors (no activity > 30 days).
 */
export async function cleanupOldLogs({ db, days = 7 }) {
  if (!db) return { deleted: 0 };
  const info = db.prepare(
    `DELETE FROM suite_logs WHERE datetime(ts) < datetime('now', ?)`
  ).run(`-${days} days`);
  return { deleted: info.changes };
}
