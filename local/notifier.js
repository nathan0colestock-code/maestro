// SPEC 6 — Push notification dispatcher.
//
// Tails feature_sets + worker_runs + suite_logs via the cloud API, detects
// the 4 state transitions from SPEC 6, and fires web-push messages to every
// subscribed endpoint. Dedupes by (feature_set_id, transition) in-memory so
// a single feature flipping to `needs_answer` twice across restarts won't
// double-notify within the same process lifetime.
//
// Graceful degradation: if VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY are absent,
// logs a warning and runs as a no-op (checkTransitions still records the
// state so tests can assert "would have fired").

let webpush;
async function ensureWebpush() {
  if (webpush) return webpush;
  try {
    const mod = await import('web-push');
    webpush = mod.default || mod;
    return webpush;
  } catch {
    return null;
  }
}

// The four transitions SPEC 6 cares about.
const EVENTS = {
  feature_set_queued:    'Feature set queued',
  feature_set_done:      'Feature set ready to review',
  feature_set_failed:    'Feature set failed',
  suite_log_error_burst: 'Error burst detected',
};

export function buildNotifier({ cloudApi, vapidPublic, vapidPrivate, vapidSubject = 'mailto:maestro@local', sendImpl }) {
  const dedupe = new Set();
  const enabled = Boolean(vapidPublic && vapidPrivate) || typeof sendImpl === 'function';

  let send = sendImpl;

  async function initRealSend() {
    if (send) return;
    const wp = await ensureWebpush();
    if (!wp || !vapidPublic || !vapidPrivate) return;
    wp.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);
    send = (subscription, payload) =>
      wp.sendNotification(subscription, JSON.stringify(payload));
  }

  async function fire(subs, payload) {
    if (!enabled || !Array.isArray(subs) || subs.length === 0) return { sent: 0, failed: 0 };
    await initRealSend();
    if (!send) return { sent: 0, failed: 0 };
    let sent = 0, failed = 0;
    for (const s of subs) {
      try {
        const sub = { endpoint: s.endpoint, keys: s.keys || {} };
        await send(sub, payload);
        sent++;
      } catch { failed++; }
    }
    return { sent, failed };
  }

  function dedupeKey(featureSetId, transition) {
    return `${featureSetId}:${transition}`;
  }

  async function handleFeatureSetTransition({ id, status, title }) {
    let transition = null;
    if (status === 'queued') transition = 'feature_set_queued';
    else if (status === 'done' || status === 'merge_requested') transition = 'feature_set_done';
    else if (status === 'failed' || status === 'test_failed' || status === 'deploy_failed_reverted') {
      transition = 'feature_set_failed';
    }
    if (!transition) return null;
    const key = dedupeKey(id, transition);
    if (dedupe.has(key)) return { skipped: 'dedup' };
    dedupe.add(key);
    const subs = await loadSubs(cloudApi);
    const payload = {
      title: EVENTS[transition],
      body: title || `Feature set #${id}`,
      transition,
      feature_set_id: id,
      url: `/`,
    };
    const result = await fire(subs, payload);
    return { transition, ...result };
  }

  async function handleSuiteLogErrorBurst({ app, count }) {
    const key = dedupeKey(`suite-${app}-${new Date().toISOString().slice(0, 13)}`, 'suite_log_error_burst');
    if (dedupe.has(key)) return { skipped: 'dedup' };
    dedupe.add(key);
    const subs = await loadSubs(cloudApi);
    const payload = {
      title: EVENTS.suite_log_error_burst,
      body: `${app}: ${count} error(s) in the last hour`,
      transition: 'suite_log_error_burst',
      url: '/',
    };
    return fire(subs, payload);
  }

  async function loadSubs(api) {
    if (!api) return [];
    try {
      const rows = await api('GET', '/api/push/subscriptions');
      return Array.isArray(rows) ? rows : [];
    } catch { return []; }
  }

  return {
    enabled,
    handleFeatureSetTransition,
    handleSuiteLogErrorBurst,
    _dedupe: dedupe,
    _fire: fire,
  };
}

/**
 * Convenience: scan recent feature_sets + suite_logs, dispatch notifications.
 * Called from daemon.js on a timer. All errors swallowed — a push outage
 * must NEVER block the build loop.
 */
export async function runOnce({ cloudApi, notifier }) {
  if (!notifier) return;
  try {
    const sets = await cloudApi('GET', '/api/feature-sets');
    for (const s of sets || []) {
      await notifier.handleFeatureSetTransition(s);
    }
  } catch { /* ignore */ }

  // Error-burst detection: >=3 errors for a single app in the last hour.
  try {
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const rows = await cloudApi('GET', `/api/suite-logs?since=${encodeURIComponent(since)}&level=error`);
    const counts = {};
    for (const r of rows || []) {
      counts[r.app] = (counts[r.app] || 0) + 1;
    }
    for (const [app, count] of Object.entries(counts)) {
      if (count >= 3) await notifier.handleSuiteLogErrorBurst({ app, count });
    }
  } catch { /* ignore */ }
}
