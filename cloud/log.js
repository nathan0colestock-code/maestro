// Structured logging for Maestro cloud relay.
//
// Contract (see shared-rules.md):
//   log(level, event, ctx={}) → emits a JSON line to stderr and pushes into
//   a bounded in-memory ring buffer. Levels: debug | info | warn | error.
//
// The ring buffer is consumed by the suite log-collector via
// GET /api/logs/recent. It holds at most RING_MAX entries and older entries
// are dropped when full.

import crypto from 'crypto';

export const RING_MAX = 1000;
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const APP = 'maestro';

// Simple circular buffer — O(1) push, O(n) when reading recent N (small n).
const ring = [];

export function log(level, event, ctx = {}) {
  const entry = {
    ts: new Date().toISOString(),
    app: APP,
    level,
    event,
    ctx: ctx && typeof ctx === 'object' ? ctx : { value: ctx },
  };
  // Hoist a few well-known fields so /api/logs/recent can filter on them
  // without parsing ctx.
  if (ctx && typeof ctx === 'object') {
    if (ctx.trace_id) entry.trace_id = ctx.trace_id;
    if (ctx.request_id) entry.request_id = ctx.request_id;
    if (typeof ctx.duration_ms === 'number') entry.duration_ms = ctx.duration_ms;
  }
  ring.push(entry);
  while (ring.length > RING_MAX) ring.shift();
  try {
    process.stderr.write(JSON.stringify(entry) + '\n');
  } catch { /* stderr closed — swallow */ }
  return entry;
}

export function getRecent({ since, level, limit } = {}) {
  const minLevel = level && LEVELS[level] ? LEVELS[level] : 0;
  const sinceMs = since ? Date.parse(since) : 0;
  const max = Math.max(1, Math.min(Number(limit) || 200, RING_MAX));
  const out = [];
  // Walk newest → oldest so the caller gets the most recent `limit` entries
  // when the ring is saturated.
  for (let i = ring.length - 1; i >= 0 && out.length < max; i--) {
    const e = ring[i];
    if (minLevel && (LEVELS[e.level] || 0) < minLevel) continue;
    if (sinceMs && Date.parse(e.ts) < sinceMs) continue;
    out.push(e);
  }
  // Return oldest-first for easier cursor pagination downstream.
  return out.reverse();
}

export function ringSize() { return ring.length; }
export function clearRing() { ring.length = 0; }

// HTTP middleware — logs every request with method/path/status/duration and a
// stable trace_id. Echoes incoming X-Trace-Id or generates a new one and
// stamps it on the response so clients can correlate.
export function httpLogger() {
  return (req, res, next) => {
    const t0 = Date.now();
    const incoming = req.headers['x-trace-id'];
    const trace_id = (incoming && /^[\w.-]{1,128}$/.test(incoming)) ? incoming : crypto.randomUUID();
    req.trace_id = trace_id;
    res.setHeader('X-Trace-Id', trace_id);
    res.on('finish', () => {
      const duration_ms = Date.now() - t0;
      const status = res.statusCode;
      const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
      log(level, 'http', {
        method: req.method,
        path: req.path || req.url,
        status,
        duration_ms,
        trace_id,
      });
    });
    next();
  };
}

// Wrapper for outbound fetch calls so retries + errors land in the ring.
// Usage: const res = await loggedFetch(url, opts, { trace_id, event:'gloss_ingest' })
export async function loggedFetch(url, opts = {}, meta = {}) {
  const t0 = Date.now();
  const event = meta.event || 'outbound_http';
  const trace_id = meta.trace_id;
  const headers = { ...(opts.headers || {}) };
  if (trace_id) headers['X-Trace-Id'] = trace_id;
  try {
    const res = await fetch(url, { ...opts, headers });
    log(res.ok ? 'info' : 'warn', event, {
      url, method: opts.method || 'GET', status: res.status,
      duration_ms: Date.now() - t0, trace_id,
    });
    return res;
  } catch (err) {
    log('error', event, {
      url, method: opts.method || 'GET', error: err.message,
      duration_ms: Date.now() - t0, trace_id,
    });
    throw err;
  }
}
