// Self-improvement auto-PR runner.
//
// Reads the latest reflection_summaries row, picks top N suggestions that
// meet effort/confidence thresholds, invokes `claude -p` scoped to an
// allowlist of files, runs tests, and opens a PR (label: self-improvement).
//
// Hard guards:
//   - File allowlist: diff MUST NOT touch anything outside ALLOWLIST.
//     If it does, abandon the branch + file a recommendation.
//   - Budget: max 2 PRs / night AND $3.00 rolling-24h spend (tracked in
//     cloud self_improvement_budget).
//   - Dry-run default: MAESTRO_SELF_IMPROVE_DRY=true prints the plan.
//   - Never auto-merge.

import { spawn } from 'child_process';
import { validateAll } from './opus-validator.js';

export const ALLOWLIST = [
  'local/router.js',
  'local/worker.js',
  'local/deployer.js',
  'local/improvement-agent.js',
  'local/reflection-agent.js',
  'local/definition-agent.js',
  'local/pipeline-stats.js',
];

export const DENYLIST_PATTERNS = [
  /cloud\/db\.js$/,
  /cloud\/server\.js$/,
  /local\/daemon\.js$/,
  /migrations?\//,
  /auth/i,
];

export const MAX_PRS_PER_NIGHT = 2;
export const MAX_SPEND_USD = 3;
export const MAX_EFFORT_HOURS = 2;
export const MIN_CONFIDENCE = 0.75;

/**
 * Check whether a list of changed files is safe to PR. Returns
 * { ok, violations[] }.
 */
export function checkDiffAllowlist(files) {
  const violations = [];
  for (const f of files) {
    const allowed = ALLOWLIST.some(a => f === a || f.startsWith(a + '/'));
    const denied = DENYLIST_PATTERNS.some(rx => rx.test(f));
    if (denied) violations.push({ file: f, reason: 'deny-pattern' });
    else if (!allowed) violations.push({ file: f, reason: 'not-in-allowlist' });
  }
  return { ok: violations.length === 0, violations };
}

/**
 * Filter self_improvement suggestions by effort/confidence thresholds.
 */
export function selectTopSuggestions(suggestions, max = MAX_PRS_PER_NIGHT) {
  if (!Array.isArray(suggestions)) return [];
  return suggestions
    .filter(s => (s?.effort_hours ?? Infinity) <= MAX_EFFORT_HOURS
              && (s?.confidence ?? 0) >= MIN_CONFIDENCE)
    .sort((a, b) => (a.rank || 99) - (b.rank || 99))
    .slice(0, max);
}

/**
 * Read today's budget row. Returns { prs_opened, cost_usd }.
 */
export async function loadBudget(cloudApi, date) {
  try {
    const row = await cloudApi('GET', `/api/self-improvement/budget?date=${date}`);
    return { prs_opened: row?.prs_opened || 0, cost_usd: row?.cost_usd || 0 };
  } catch {
    return { prs_opened: 0, cost_usd: 0 };
  }
}

/**
 * Budget gate — returns { allowed, reason, budget }.
 */
export function checkBudget(budget, { extraCostUsd = 0 } = {}) {
  if (budget.prs_opened >= MAX_PRS_PER_NIGHT) {
    return { allowed: false, reason: 'max-prs-reached', budget };
  }
  if (budget.cost_usd + extraCostUsd > MAX_SPEND_USD) {
    return { allowed: false, reason: 'spend-cap-reached', budget };
  }
  return { allowed: true, budget };
}

function slugify(s) {
  return String(s || 'improvement').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

/**
 * Build the claude -p prompt that scopes edits to the allowlist.
 */
export function buildPrompt(suggestion) {
  return [
    'You are applying a self-improvement to the Maestro codebase.',
    '',
    '## Scope (HARD constraint)',
    'You MAY ONLY edit these files:',
    ALLOWLIST.map(f => `- ${f}`).join('\n'),
    'If your change would require editing any other file, abandon the task with a one-line explanation — do NOT edit outside the list.',
    '',
    '## Suggestion',
    `Target: ${suggestion.target_file}`,
    `Description: ${suggestion.description}`,
    suggestion.patch_hint ? `Hint: ${suggestion.patch_hint}` : '',
    '',
    'Make the minimal change, add a test if one is missing, run `npm test` to verify, and commit with a clear message.',
  ].filter(Boolean).join('\n');
}

/**
 * Run one suggestion end-to-end. Returns { status, branch, violations? }.
 * Heavy I/O is abstracted so tests can assert the control flow without
 * invoking real git / claude.
 */
export async function processSuggestion(suggestion, {
  cloudApi, runClaude, runGit, runTests, gitChangedFiles, dryRun, date,
}) {
  const slug = slugify(suggestion.description || suggestion.target_file);
  const branch = `maestro/self-improve/${slug}-${date}`;

  if (dryRun) {
    return { status: 'dry-run', branch, plan: suggestion };
  }

  await runGit(['checkout', '-b', branch]);
  const prompt = buildPrompt(suggestion);
  try {
    await runClaude(prompt);
  } catch (err) {
    await runGit(['checkout', '-']).catch(() => {});
    return { status: 'claude-failed', branch, error: err.message };
  }

  const changed = await gitChangedFiles();
  const check = checkDiffAllowlist(changed);
  if (!check.ok) {
    await runGit(['checkout', '-']).catch(() => {});
    await cloudApi('POST', '/api/recommendations', {
      text: `auto-pr rejected: ${branch} touched disallowed files: ${check.violations.map(v => v.file).join(', ')}`,
      source: 'tasks_md',
      target_app: 'maestro',
      priority: 4,
    }).catch(() => {});
    return { status: 'allowlist-violation', branch, violations: check.violations };
  }

  const tests = await runTests();
  if (!tests.ok) {
    await runGit(['checkout', '-']).catch(() => {});
    return { status: 'tests-failed', branch, testOutput: tests.output };
  }

  return { status: 'ready-to-pr', branch };
}

/**
 * Nightly entry point. Reads latest reflection, selects top N, runs each.
 */
export async function runAutoPrNightly({
  cloudApi, runClaude, runGit, runTests, gitChangedFiles, date, dryRun,
  validator = validateAll,
}) {
  const today = date || new Date().toISOString().slice(0, 10);
  const isDry = dryRun ?? (process.env.MAESTRO_SELF_IMPROVE_DRY !== 'false');

  const reflection = await cloudApi('GET', '/api/self-improvement/latest').catch(() => null);
  const suggestions = reflection?.summary?.self_improvements;
  const shortlisted = selectTopSuggestions(suggestions, MAX_PRS_PER_NIGHT * 2);
  if (shortlisted.length === 0) {
    return { ok: true, date: today, selected: 0, results: [] };
  }

  // Opus validator: re-read current code + recent commits, drop suggestions
  // that are already done / no longer apply / too vague, and refine stale
  // patch_hints. Fail-closed on parse errors. Logged, not surfaced to user.
  const { kept, dropped } = await validator(shortlisted);
  if (dropped.length) {
    console.log(`[auto-pr] validator dropped ${dropped.length}: ${dropped.map(d => `${d.target_file}:${d.validator.decision}`).join(', ')}`);
    await cloudApi('POST', '/api/self-improvement/validator-log', {
      date: today,
      dropped: dropped.map(d => ({ target: d.target_file, reason: d.validator.reason })),
      refined: kept.filter(k => k.validator.decision === 'refine').map(k => ({ target: k.target_file, reason: k.validator.reason })),
    }).catch(() => {});
  }
  const selected = kept.slice(0, MAX_PRS_PER_NIGHT);
  if (selected.length === 0) {
    return { ok: true, date: today, selected: 0, validator_dropped: dropped.length, results: [] };
  }

  const budget = await loadBudget(cloudApi, today);
  const gate = checkBudget(budget);
  if (!gate.allowed) {
    return { ok: true, date: today, blocked: gate.reason, budget };
  }

  const results = [];
  for (const s of selected) {
    const r = await processSuggestion(s, {
      cloudApi, runClaude, runGit, runTests, gitChangedFiles,
      dryRun: isDry, date: today,
    });
    results.push({ suggestion: s, ...r });
    if (r.status === 'ready-to-pr' && !isDry) {
      await cloudApi('POST', '/api/self-improvement/budget', {
        date: today, prs_opened_delta: 1, cost_usd_delta: 0.5,
      }).catch(() => {});
    }
  }
  return { ok: true, date: today, dry_run: isDry, results };
}

// Direct invocation
if (import.meta.url === `file://${process.argv[1]}`) {
  const CLOUD_URL = process.env.MAESTRO_CLOUD_URL;
  const SECRET = process.env.MAESTRO_SECRET;
  const api = async (method, path, body) => {
    const res = await fetch(CLOUD_URL + path, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.json().catch(() => null);
  };
  const runClaude = (p) => new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', p, '--output-format', 'text'], { stdio: 'inherit' });
    child.on('close', c => c === 0 ? resolve('') : reject(new Error(`claude exited ${c}`)));
  });
  const runGit = (args) => new Promise((resolve, reject) => {
    const child = spawn('git', args, { stdio: 'inherit' });
    child.on('close', c => c === 0 ? resolve() : reject(new Error(`git exited ${c}`)));
  });
  const runTests = async () => ({ ok: true, output: '' }); // replaced with real runner in daemon
  const gitChangedFiles = async () => [];
  runAutoPrNightly({ cloudApi: api, runClaude, runGit, runTests, gitChangedFiles })
    .then(r => console.log('[auto-pr]', JSON.stringify(r, null, 2)))
    .catch(err => { console.error('[auto-pr] fatal:', err.message); process.exit(1); });
}
