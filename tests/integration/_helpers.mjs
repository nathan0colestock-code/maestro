// Shared helpers for suite integration tests.

export const APP_URLS = {
  comms: process.env.COMMS_URL || 'https://comms-nc.fly.dev',
  gloss: process.env.GLOSS_URL || 'https://gloss-nc.fly.dev',
  black: process.env.BLACK_URL || 'https://black-hole.fly.dev',
  scribe: process.env.SCRIBE_URL || 'https://scribe-nc.fly.dev',
  maestro: process.env.MAESTRO_URL || 'https://maestro-nc.fly.dev',
};

export const SUITE_API_KEY = process.env.SUITE_API_KEY || '';

export const APP_KEYS = {
  comms: process.env.COMMS_API_KEY || null,
  gloss: process.env.GLOSS_API_KEY || null,
  black: process.env.BLACK_API_KEY || null,
  scribe: process.env.SCRIBE_API_KEY || null,
};

const DEFAULT_TIMEOUT_MS = 15_000;

export async function authedFetch(url, { headers = {}, timeout = DEFAULT_TIMEOUT_MS, ...opts } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...opts, headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function suiteAuthHeader() {
  return SUITE_API_KEY ? { Authorization: `Bearer ${SUITE_API_KEY}` } : {};
}

export function appAuthHeader(appName) {
  const key = APP_KEYS[appName];
  return key ? { Authorization: `Bearer ${key}` } : {};
}

// Validates a /api/status response against the suite-shape contract.
// Returns { ok, errors[] } so the caller can assert/log.
export function validateStatusShape(body, expectedApp) {
  const errors = [];
  if (!body || typeof body !== 'object') errors.push('not an object');
  if (body?.app !== expectedApp) errors.push(`app=${body?.app}, expected ${expectedApp}`);
  if (typeof body?.version !== 'string') errors.push('version not string');
  if (body?.ok !== true) errors.push('ok not true');
  if (typeof body?.uptime_seconds !== 'number') errors.push('uptime_seconds not number');
  if (!body?.metrics || typeof body.metrics !== 'object') errors.push('metrics not object');
  return { ok: errors.length === 0, errors };
}
