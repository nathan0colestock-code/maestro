// Self-reflection agent — runs AFTER the nightly feature-build cycle.
// Uses the `claude -p` CLI (headless Claude Code) for LLM calls because
// that route uses local macOS auth, not ANTHROPIC_API_KEY.
//
// Inputs (last 24h):
//   - feature_sets with phase_timings
//   - worker_runs (tokens, cost, duration, status)
//   - worker transcripts via session-reader.js's summarizeTranscript
//   - routing_feedback rows
//   - suite_logs filtered to warn/error
//   - cost/token totals + 7-day regression check
//
// Output: one reflection_summaries row; POSTs to /api/self-improvement.

import { spawn } from 'child_process';
import { readdirSync, statSync, readFileSync } from 'fs';
import { join } from 'path';

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-5';
const DEFAULT_CLAUDE_CMD = process.env.CLAUDE_CMD || 'claude';

const SYSTEM_PROMPT = `You are Maestro's self-reflection analyst. Review the last 24 hours of Maestro's own execution. Answer:
1. What did Maestro do well?
2. Where did workers thrash, retry, or run over budget?
3. What specific changes to MAESTRO'S OWN code (router.js, daemon.js, worker.js, deployer.js, improvement-agent.js, reflection-agent.js, definition-agent.js) would have made tonight faster/cheaper/more accurate?
4. Which of those are safe to auto-PR tonight (< 2h effort, tests exist, no schema change)?

Return JSON ONLY with this shape:
{
  "wins": [string],
  "struggles": [string],
  "self_improvements": [
    {"rank": number, "target_file": string, "description": string, "effort_hours": number, "confidence": number, "patch_hint": string}
  ],
  "metric_summary": {"tokens": number, "cost_usd": number, "phase_p95_ms": number, "regression_flags": [string]}
}`;

/**
 * Walk a Claude Code project jsonl directory and extract summary counts
 * (tool calls, files read/edited, tests run, retries, backtracks) for a
 * single sessionId. Pure function — caller resolves the project encoding.
 */
export function summarizeTranscript(sessionId, transcriptsDir) {
  const out = {
    tool_call_count: 0,
    files_read: 0,
    files_edited: 0,
    tests_run: 0,
    retries: 0,
    backtracks: 0,
  };
  if (!sessionId || !transcriptsDir) return out;
  let entries;
  try { entries = readdirSync(transcriptsDir); } catch { return out; }
  for (const f of entries) {
    if (!f.endsWith('.jsonl')) continue;
    if (!f.includes(sessionId)) continue;
    let raw;
    try { raw = readFileSync(join(transcriptsDir, f), 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      const name = obj?.toolName || obj?.tool?.name || obj?.message?.content?.[0]?.name;
      if (name) out.tool_call_count++;
      if (name === 'Read') out.files_read++;
      if (name === 'Edit' || name === 'Write') out.files_edited++;
      if (name === 'Bash' && /(npm test|pytest|go test)/i.test(JSON.stringify(obj))) out.tests_run++;
      if (/error|failed|retry/i.test(obj?.message?.content?.[0]?.text || '')) out.retries++;
      if (obj?.type === 'user' && obj?.message?.content?.[0]?.text?.includes('undo')) out.backtracks++;
    }
  }
  return out;
}

/**
 * Gather inputs for the reflection prompt from the cloud. Pure-ish — takes
 * cloudApi and the window size, returns a plain object. No LLM call.
 */
export async function gatherInputs({ cloudApi, hours = 24 }) {
  const [observations, suiteLogs] = await Promise.all([
    cloudApi('GET', `/api/reflect/observations?hours=${hours}`).catch(() => ({})),
    (async () => {
      const since = new Date(Date.now() - hours * 3600_000).toISOString();
      return cloudApi('GET', `/api/suite-logs?since=${encodeURIComponent(since)}&level=warn`).catch(() => []);
    })(),
  ]);
  const workerRuns = observations.worker_runs || [];
  const featureSets = observations.feature_sets || [];
  const totals = workerRuns.reduce((acc, r) => {
    acc.tokens_in += r.tokens_in || 0;
    acc.tokens_out += r.tokens_out || 0;
    acc.cost_usd += r.cost_usd || 0;
    return acc;
  }, { tokens_in: 0, tokens_out: 0, cost_usd: 0 });
  return {
    window_hours: hours,
    totals,
    feature_sets: featureSets,
    worker_runs: workerRuns,
    routing_feedback: observations.routing_feedback || [],
    suite_log_warnings: Array.isArray(suiteLogs) ? suiteLogs : [],
  };
}

/**
 * Run `claude -p` with the reflection prompt. Returns the parsed JSON.
 * The CLI call is injectable (opts.runClaude) so tests can stub.
 */
export async function runReflection({ inputs, runClaude, cwd }) {
  const runner = runClaude || defaultRunClaude(cwd);
  const prompt = [
    SYSTEM_PROMPT,
    '',
    '## Inputs (JSON)',
    '```json',
    JSON.stringify(inputs, null, 2),
    '```',
  ].join('\n');
  const raw = await runner(prompt);
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '').trim();
  return JSON.parse(cleaned);
}

function defaultRunClaude(cwd) {
  return (prompt) => new Promise((resolve, reject) => {
    const args = ['-p', prompt, '--model', CLAUDE_MODEL, '--output-format', 'text'];
    const child = spawn(DEFAULT_CLAUDE_CMD, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { err += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`claude -p exited ${code}: ${err}`));
    });
  });
}

/**
 * Full nightly entry point. Gathers inputs, runs reflection, POSTs to
 * /api/self-improvement. Opts allow tests to inject cloudApi + runClaude.
 */
export async function runNightlyReflection({ cloudApi, runClaude, cwd, date } = {}) {
  if (!cloudApi) throw new Error('cloudApi required');
  const today = date || new Date().toISOString().slice(0, 10);
  const inputs = await gatherInputs({ cloudApi });
  const summary = await runReflection({ inputs, runClaude, cwd });
  await cloudApi('POST', '/api/self-improvement', { date: today, summary });
  return { ok: true, date: today, summary };
}

// Direct invocation (LaunchAgent entry point) —
// `node local/reflection-agent.js`
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
  runNightlyReflection({ cloudApi: api }).then(r => {
    console.log(`[reflect] ${r.date} — ${r.summary?.wins?.length || 0} wins, ${r.summary?.self_improvements?.length || 0} proposed`);
  }).catch(err => {
    console.error('[reflect] failed:', err.message);
    process.exit(1);
  });
}
