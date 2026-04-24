// Maestro Nightly Improvement Agent
// ----------------------------------
// Runs once per day (23:00 local via LaunchAgent, or on-demand). Pulls
// telemetry from every suite app AND the user's feature recommendations,
// then asks Claude (Sonnet 4.6 per plan) to produce a ranked suggestion
// list for the next day's auto-PR attempts.
//
// Two input streams, per elegant-napping-fox.md:
//   1. Telemetry — quantitative signals from each app.
//   2. User feature recommendations — captured via the PWA (voice or text).
// User recommendations outrank telemetry-only hunches; cross-validated
// items (user asked + telemetry confirms) rank highest of all.
//
// Model: invoked via `claude -p` (headless CLI), matching the suite's
// existing worker-spawn pattern (local/worker.js). No new SDK dependency.

import { spawn } from 'child_process';
import { writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

const CLOUD_URL  = process.env.MAESTRO_CLOUD_URL  || 'http://localhost:3750';
const SECRET     = process.env.MAESTRO_SECRET     || process.env.SUITE_API_KEY;
const CLAUDE_BIN = process.env.CLAUDE_BIN         || 'claude';
const TIMEOUT_MS = 5 * 60 * 1000;

const SUITE_APPS = [
  { name: 'gloss',  url: process.env.GLOSS_URL  || 'https://gloss-nc.fly.dev',   auth: process.env.GLOSS_API_KEY  || process.env.SUITE_API_KEY },
  { name: 'comms',  url: process.env.COMMS_URL  || 'https://comms-nc.fly.dev',   auth: process.env.COMMS_API_KEY  || process.env.SUITE_API_KEY },
  { name: 'black',  url: process.env.BLACK_URL  || 'https://black-hole.fly.dev', auth: process.env.BLACK_API_KEY  || process.env.SUITE_API_KEY },
  { name: 'scribe', url: process.env.SCRIBE_URL || 'https://scribe-nc.fly.dev',  auth: process.env.SCRIBE_API_KEY || process.env.SUITE_API_KEY },
];

async function cloudApi(method, path, body = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (SECRET) headers['Authorization'] = `Bearer ${SECRET}`;
  const res = await fetch(`${CLOUD_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`cloudApi ${method} ${path} → ${res.status}`);
  return res.headers.get('content-type')?.includes('json') ? res.json() : res.text();
}

async function fetchSuiteTelemetry(app) {
  try {
    const headers = {};
    if (app.auth) headers['Authorization'] = `Bearer ${app.auth}`;
    const res = await fetch(`${app.url}/api/telemetry/nightly`, { headers });
    if (!res.ok) return { app: app.name, error: `HTTP ${res.status}`, url: app.url };
    return { app: app.name, ...(await res.json()) };
  } catch (err) {
    return { app: app.name, error: err.message, url: app.url };
  }
}

async function collectInputs() {
  // Two new streams per the overnight plan:
  //   - suite_logs filtered to warn/error (last 24h) — surfaces recurring
  //     failure events that telemetry alone doesn't expose.
  //   - latest reflection_summaries row — Maestro-internal struggles / wins.
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const [suitePayloads, recommendations, captures, runs, featureSets, suiteLogs, reflection] = await Promise.all([
    Promise.all(SUITE_APPS.map(fetchSuiteTelemetry)),
    cloudApi('GET', '/api/recommendations?status=new,clustered').catch(() => []),
    cloudApi('GET', '/api/captures').catch(() => []),
    cloudApi('GET', '/api/worker/runs').catch(() => []),
    cloudApi('GET', '/api/feature-sets').catch(() => []),
    cloudApi('GET', `/api/suite-logs?since=${encodeURIComponent(since)}&level=warn`).catch(() => []),
    cloudApi('GET', '/api/self-improvement/latest').catch(() => null),
  ]);

  const today = new Date().toISOString().slice(0, 10);
  await Promise.all(suitePayloads
    .filter(p => !p.error)
    .map(p => cloudApi('POST', '/api/suite-telemetry', {
      app: p.app, date: p.date || today, payload: p,
    }).catch(err => console.warn(`[improvement] push ${p.app} telemetry failed:`, err.message)))
  );

  return {
    date: today,
    suite: suitePayloads,
    recommendations,
    captures_last_24h: captures.filter(c => {
      const t = Date.parse(c.created_at);
      return Number.isFinite(t) && Date.now() - t < 24 * 3600 * 1000;
    }),
    runs_last_24h: runs.filter(r => {
      const t = Date.parse(r.started_at);
      return Number.isFinite(t) && Date.now() - t < 24 * 3600 * 1000;
    }),
    feature_sets_last_7d: featureSets.filter(fs => {
      const t = Date.parse(fs.updated_at);
      return Number.isFinite(t) && Date.now() - t < 7 * 24 * 3600 * 1000;
    }),
    // Two new streams (overnight extension).
    suite_log_warnings_24h: summarizeSuiteLogs(suiteLogs),
    reflection_latest: reflection,
  };
}

// Collapse warn/error rows into top N recurring events per app + small
// samples, so the prompt stays bounded.
export function summarizeSuiteLogs(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return { total: 0, by_app: {} };
  const by_app = {};
  for (const r of rows) {
    const a = by_app[r.app] || { warn: 0, error: 0, top_events: {}, samples: [] };
    if (r.level === 'warn') a.warn++;
    if (r.level === 'error') a.error++;
    a.top_events[r.event] = (a.top_events[r.event] || 0) + 1;
    if (a.samples.length < 3) a.samples.push({ event: r.event, ctx: r.ctx });
    by_app[r.app] = a;
  }
  // Sort events per app and trim.
  for (const app of Object.keys(by_app)) {
    const ev = by_app[app].top_events;
    by_app[app].top_events = Object.entries(ev)
      .sort(([, a], [, b]) => b - a).slice(0, 5)
      .map(([name, count]) => ({ name, count }));
  }
  return { total: rows.length, by_app };
}

const SYSTEM_PROMPT = `You are Maestro's nightly self-improvement analyst.

Your job: read two streams of input and produce a ranked list of concrete
improvements to ship tomorrow.

INPUT STREAM 1 — TELEMETRY
  Per-app quantitative signals from maestro, gloss, comms, black, scribe.
  Includes metrics (counts, latencies, freshness) and health flags
  (is-stale, is-flapping, backlog-overload).

INPUT STREAM 2 — USER FEATURE RECOMMENDATIONS
  Free-text suggestions the user typed or spoke into the Maestro PWA.
  These are FIRST-CLASS input, not auxiliary. A suggestion the user
  voiced is at least as important as a metric trend.

INPUT STREAM 3 — SUITE LOG WARNINGS (added by the nightly log collector)
  Per-app recurring warn/error events from the last 24h. Use to spot
  silent failures that haven't yet surfaced in telemetry.

INPUT STREAM 4 — LATEST SELF-REFLECTION
  Maestro's own reflection-agent output for the previous night — wins,
  struggles, and self-improvements it has already proposed. Treat the
  "self_improvements" list as a backlog to consider promoting.

RANKING RULES (apply in order)
  1. CROSS-VALIDATED first: user asked AND telemetry confirms.
  2. USER-REQUESTED next: the user asked, even if metrics don't flag it.
     Rank by recency × priority × recurrence across captures.
  3. TELEMETRY-DRIVEN last: clear metric pain, no user mention yet.
     Rank by impact / effort.

OUTPUT SHAPE — return a single JSON object, no prose, matching:
{
  "date": "YYYY-MM-DD",
  "summary": {
    "captures_24h": <int>,
    "runs_24h": <int>,
    "api_cost_today_usd": <float|null>,
    "routing_accuracy_7d": <float|null>,
    "headline": "<one sentence: the single most important observation>"
  },
  "suggestions": {
    "cross_validated": [
      {
        "rank": 1,
        "target_app": "maestro|gloss|comms|black|scribe|suite",
        "text": "<concrete change, under 200 chars>",
        "why": "<1-2 sentences citing both user rec and metric>",
        "effort_hours": <float>,
        "confidence": <float 0-1>,
        "linked_recommendation_ids": [<int>, ...],
        "files_touched": ["<path>", ...],
        "pr_prompt": "<prompt for claude -p to implement this, 1-3 paragraphs>"
      }
    ],
    "user_requested": [ /* same shape, no telemetry citation required */ ],
    "telemetry_driven": [ /* same shape, no user rec linkage */ ],
    "self_improvement": [ /* Maestro-internal — only router.js/worker.js/
        deployer.js/improvement-agent.js/reflection-agent.js/
        definition-agent.js/pipeline-stats.js. Never schema, auth, or
        daemon core loops. See auto-pr.js ALLOWLIST. */ ]
  }
}

CONSTRAINTS
  - Auto-PR scope is bounded: only propose changes to router.js,
    pipeline-stats.js, deployer.js (maestro), or to server.js additions
    (gloss/comms/black/scribe) and small UI polish. Never schema
    migrations, never auth code, never daemon core loops.
  - Effort estimate must be honest. Anything > 2h should NOT be in
    cross_validated (too big for nightly auto-PR).
  - If no cross-validated items exist, return empty array — don't pad.
  - If a user recommendation is vague, cluster it under a theme but
    don't propose a PR for it until sharper.`;

function renderPromptContext(inputs) {
  return JSON.stringify({
    date: inputs.date,
    suite_apps: inputs.suite.map(p => ({
      app: p.app,
      ok: !p.error,
      error: p.error || null,
      metrics: p.metrics || null,
      health: p.health || null,
    })),
    recent_user_recommendations: inputs.recommendations.map(r => ({
      id: r.id, source: r.source, target_app: r.target_app,
      text: r.text, theme: r.theme, priority: r.priority, status: r.status,
      created_at: r.created_at,
    })),
    captures_24h_count: inputs.captures_last_24h.length,
    runs_24h: inputs.runs_last_24h.map(r => ({
      project: r.project_name, status: r.status,
      duration_ms: r.duration_ms, cost_usd: r.cost_usd,
      tokens_in: r.tokens_in, tokens_out: r.tokens_out,
    })),
    feature_sets_7d: inputs.feature_sets_last_7d.map(fs => ({
      project: fs.project_name, title: fs.title, status: fs.status,
      phase_timings: fs.phase_timings ? safeParse(fs.phase_timings) : null,
    })),
  }, null, 2);
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

// Invokes `claude -p` headless. Plan calls for Sonnet 4.6 with prompt
// caching; CLAUDE_MODEL env var is honored if set.
function runClaude(systemPrompt, userPrompt) {
  return new Promise((resolve, reject) => {
    const args = ['-p', userPrompt, '--append-system-prompt', systemPrompt];
    if (process.env.CLAUDE_MODEL) args.push('--model', process.env.CLAUDE_MODEL);
    const child = spawn(CLAUDE_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`claude -p timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude -p exited ${code}: ${stderr.slice(0, 500)}`));
      resolve(stdout);
    });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error('no JSON object found in analyst output');
  return JSON.parse(candidate.slice(start, end + 1));
}

async function appendToTasksMd(repoRoot, analysis) {
  const tasksPath = join(repoRoot, 'tasks.md');
  const existing = existsSync(tasksPath) ? await readFile(tasksPath, 'utf8') : '';
  const lines = ['', `## Nightly suggestions — ${analysis.date}`];
  if (analysis.summary?.headline) lines.push(`> ${analysis.summary.headline}`);
  const sections = [
    ['Cross-validated (user asked + telemetry confirms)', analysis.suggestions?.cross_validated],
    ['User-requested', analysis.suggestions?.user_requested],
    ['Telemetry-driven', analysis.suggestions?.telemetry_driven],
    ['Self-improvement (Maestro-internal)', analysis.suggestions?.self_improvement],
  ];
  for (const [label, items] of sections) {
    if (!items?.length) continue;
    lines.push('', `### ${label}`);
    for (const s of items) {
      const linked = s.linked_recommendation_ids?.length
        ? ` (recs: ${s.linked_recommendation_ids.join(', ')})` : '';
      lines.push(`- [${s.target_app}] ${s.text} — ~${s.effort_hours}h, conf ${s.confidence}${linked}`);
      if (s.why) lines.push(`  - ${s.why}`);
    }
  }
  await writeFile(tasksPath, existing + lines.join('\n') + '\n');
}

async function markRecommendationsClustered(analysis) {
  const seen = new Set();
  const all = [
    ...(analysis.suggestions?.cross_validated || []),
    ...(analysis.suggestions?.user_requested || []),
  ];
  for (const s of all) {
    for (const id of s.linked_recommendation_ids || []) {
      if (seen.has(id)) continue;
      seen.add(id);
      await cloudApi('POST', `/api/recommendations/${id}`, {
        status: 'clustered',
        theme: s.target_app ? `${s.target_app}:${(s.text || '').slice(0, 40)}` : null,
      }).catch(err => console.warn(`[improvement] mark rec ${id} clustered failed:`, err.message));
    }
  }
}

export async function runNightlyAnalysis({ repoRoot = process.cwd(), dryRun = true } = {}) {
  console.log('[improvement] collecting inputs…');
  const inputs = await collectInputs();
  const userPrompt = [
    `Today is ${inputs.date}.`,
    `Here is the suite context. Produce the ranked JSON as specified.`,
    '',
    '```json',
    renderPromptContext(inputs),
    '```',
  ].join('\n');

  console.log('[improvement] invoking analyst…');
  const raw = await runClaude(SYSTEM_PROMPT, userPrompt);
  const analysis = extractJson(raw);
  analysis.date = analysis.date || inputs.date;

  console.log('[improvement] persisting summary…');
  await cloudApi('POST', '/api/nightly-summary', {
    date: analysis.date,
    summary: analysis.summary,
    suggestions: analysis.suggestions,
  });
  await markRecommendationsClustered(analysis);
  await appendToTasksMd(repoRoot, analysis);

  console.log(`[improvement] done. cross_validated=${analysis.suggestions?.cross_validated?.length || 0}, user_requested=${analysis.suggestions?.user_requested?.length || 0}, telemetry_driven=${analysis.suggestions?.telemetry_driven?.length || 0}, self_improvement=${analysis.suggestions?.self_improvement?.length || 0}`);

  if (!dryRun) {
    console.log('[improvement] auto-PR is disabled by default. Set MAESTRO_AUTO_PR=true to enable (separate runner).');
  }
  return analysis;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runNightlyAnalysis({
    repoRoot: process.env.MAESTRO_REPO_ROOT || join(process.cwd(), '..'),
    dryRun: process.env.MAESTRO_AUTO_PR !== 'true',
  }).catch(err => {
    console.error('[improvement] fatal:', err);
    process.exit(1);
  });
}
