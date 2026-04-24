#!/usr/bin/env node
// Seed the cloud feature_recommendations table from the "elegant-napping-fox"
// plan. Reads the 75 bulleted items from the plan and POSTs each to
// /api/recommendations with a best-guess target_app + priority.
//
// Usage:
//   MAESTRO_CLOUD_URL=https://... MAESTRO_SECRET=... node scripts/seed-recommendations.mjs
//
// Optional:
//   PLAN_PATH=/path/to/plan.md   — override plan source
//   DRY_RUN=true                 — print what would be posted without hitting the API
//
// Orchestrator usage post-merge: run once against the deployed cloud. The
// endpoint is idempotent-ish (each run appends new rows; status defaults
// to 'new'), so reruns duplicate. Guard by checking existing rows if needed.

import { readFileSync } from 'fs';

const DEFAULT_PLAN = process.env.HOME + '/.claude/plans/elegant-napping-fox.md';
const PLAN_PATH = process.env.PLAN_PATH || DEFAULT_PLAN;
const CLOUD_URL = process.env.MAESTRO_CLOUD_URL;
const SECRET = process.env.MAESTRO_SECRET;
const DRY_RUN = process.env.DRY_RUN === 'true';

const APPS = ['maestro', 'gloss', 'comms', 'black', 'scribe', 'pulse', 'recall'];

/**
 * Parse the plan file. Returns items shaped for POST /api/recommendations.
 * Section headings ("## Maestro" / "### Gloss") assign the default
 * target_app for bullets beneath them.
 */
export function parsePlan(md) {
  const lines = md.split('\n');
  const items = [];
  let section = null;

  for (const line of lines) {
    // Track the active app section. We recognise any heading level where the
    // heading text starts with a known app name.
    const h = line.match(/^#{2,4}\s+(\S+)/);
    if (h) {
      const candidate = h[1].toLowerCase().replace(/[^a-z]/g, '');
      // 'black-hole' in the plan → 'black' in our app roster
      const normalized = candidate === 'blackhole' ? 'black' : candidate;
      if (APPS.includes(normalized)) section = normalized;
      else if (h[1].toLowerCase().includes('cross-cutting') || h[1].toLowerCase().includes('themes')) section = 'suite';
      else if (candidate === 'context' || candidate === 'outcome') section = null;
      continue;
    }
    const b = line.match(/^\s*-\s+(.+)$/);
    if (!b) continue;
    const text = b[1].trim();
    // Skip bullets that are simple pattern keys (e.g. the table rows at the top)
    if (text.length < 10) continue;

    const priority = inferPriority(text);
    items.push({
      text,
      target_app: section,
      priority,
      source: 'tasks_md',
    });
  }
  return items;
}

function inferPriority(text) {
  const lower = text.toLowerCase();
  // 4 (high) — SPEC-related, auth, security, schema
  if (/\b(spec|auth|security|schema|vapid|secret|migration)\b/.test(lower)) return 4;
  // 3 (med) — bloat / dead-code / half-migrated
  if (/\b(bloat|dead\s*code|deprecate|remove|refactor|half[- ]migrated)\b/.test(lower)) return 3;
  // 2 (low) — UX polish
  if (/\b(polish|ux|tap\s*target|reduced[- ]motion|wcag|css|tooltip|label)\b/.test(lower)) return 2;
  return 3;
}

export async function seed({ fetchImpl = fetch } = {}) {
  if (!CLOUD_URL || !SECRET) {
    throw new Error('MAESTRO_CLOUD_URL and MAESTRO_SECRET required');
  }
  const md = readFileSync(PLAN_PATH, 'utf8');
  const items = parsePlan(md);
  const results = { total: items.length, posted: 0, failed: 0, dry_run: DRY_RUN };
  for (const it of items) {
    if (DRY_RUN) { results.posted++; continue; }
    try {
      const res = await fetchImpl(`${CLOUD_URL}/api/recommendations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
        body: JSON.stringify(it),
      });
      if (res.ok) results.posted++;
      else results.failed++;
    } catch { results.failed++; }
  }
  return results;
}

// Run when invoked directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  seed().then(r => {
    console.log(`[seed] ${r.posted}/${r.total} posted, ${r.failed} failed${r.dry_run ? ' (dry run)' : ''}`);
    process.exit(r.failed > 0 ? 1 : 0);
  }).catch(err => {
    console.error('[seed] fatal:', err.message);
    process.exit(2);
  });
}
