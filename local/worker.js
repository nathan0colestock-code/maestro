// Autonomous worker — spawns `claude -p` (headless) in a project dir to actually
// perform a routed task. Uses existing CLI auth (no API key required).

import { spawn } from 'child_process';
import { randomUUID } from 'crypto';

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const WORKER_MODEL = process.env.WORKER_MODEL || 'sonnet';
const MAX_ACTIVE_PER_PROJECT = 1;
const activeRuns = new Map();

function formatProjectTimingNote(projectStats) {
  if (!projectStats || !Object.keys(projectStats).length) return null;
  const parts = [];
  for (const phase of ['pre-merge-tests', 'merge', 'deploy', 'integration-tests']) {
    const s = projectStats[phase];
    if (!s || !s.n) continue;
    const p50s = (s.p50 / 1000).toFixed(1);
    const p95s = (s.p95 / 1000).toFixed(1);
    const fr = s.failure_rate != null ? ` fail=${Math.round(s.failure_rate * 100)}%` : '';
    parts.push(`${phase} p50=${p50s}s p95=${p95s}s${fr} (n=${s.n})`);
  }
  return parts.length ? parts.join('; ') : null;
}

function buildPrompt(task, context, priorQA, projectStats) {
  const lines = [
    `You have been dispatched by Maestro, an orchestration layer that routes the developer's captured ideas to the right project.`,
    ``,
    `## Your task`,
    task,
  ];
  if (context) lines.push(``, `## Why this matters`, context);

  if (priorQA?.length) {
    lines.push(``, `## Previously asked & answered`);
    for (const qa of priorQA) {
      lines.push(`Q: ${qa.question}`);
      lines.push(`A: ${qa.answer}`);
    }
    lines.push(``, `Use those answers to proceed. Don't re-ask the same questions.`);
  }

  const timingNote = formatProjectTimingNote(projectStats);
  lines.push(
    ``,
    `## Ground rules`,
    `- Work on a new git branch named maestro/<short-slug> so main is untouched.`,
    `- Make focused commits with clear messages.`,
    `- Do not push; do not open PRs. The developer reviews locally.`,
    `- If the scope is larger than one session, do the safest first chunk, commit, and note the rest in tasks.md.`,
    ...(timingNote ? [`- Historical timing for this project: ${timingNote}. Factor this into scope judgment — if pre-merge-tests already take minutes, don't introduce changes that add 10x to that.`] : []),
    ``,
    `## Testing is non-negotiable`,
    `- Before each commit, run the project's test command (\`npm test\`, or \`node --test tests/\` if no npm script).`,
    `- **If tests fail, fix them before committing.** Never commit a red test suite.`,
    `- If your change touches a documented integration point (see \`../maestro/SYSTEM.md\` and \`../maestro/tests/integration/\`), also verify the relevant integration tests still pass locally. If you can't run them in this environment, at least read them and mentally check your change is compatible.`,
    `- Maestro will re-run the project's tests AND the suite integration tests after the merge before deploying. If anything fails, the deploy is rolled back and the developer gets a notification. Don't leave a red test as a "for later" — fix it now.`,
    ``,
    `## If you need more information`,
    `If the task is ambiguous or you lack info the developer would need to provide,`,
    `STOP early and at the very end of your final output, emit one or more lines that start with the literal prefix "QUESTION:".`,
    `Example:`,
    `  QUESTION: Should the login button go in the top nav or the sidebar?`,
    `  QUESTION: Do you want the reset to clear all fields or only the form inputs?`,
    `Maestro will ask the developer via voice and requeue this task with their answers.`,
    `Only emit QUESTION: lines when you genuinely cannot proceed — never as a courtesy check.`,
    ``,
    `## Final output`,
    `End your session with a one-paragraph plain summary of what you did and what remains, followed by any QUESTION: lines if blocked.`,
  );
  return lines.join('\n');
}

function canStart(projectName) {
  return (activeRuns.get(projectName) || 0) < MAX_ACTIVE_PER_PROJECT;
}

function markStart(projectName) {
  activeRuns.set(projectName, (activeRuns.get(projectName) || 0) + 1);
}

function markEnd(projectName) {
  const n = (activeRuns.get(projectName) || 1) - 1;
  if (n <= 0) activeRuns.delete(projectName);
  else activeRuns.set(projectName, n);
}

export function getActiveRunCount(projectName) {
  return activeRuns.get(projectName) || 0;
}

export function hasActiveWorker(projectName) {
  return getActiveRunCount(projectName) > 0;
}

function parseQuestions(summary) {
  if (!summary) return [];
  const out = [];
  for (const line of summary.split('\n')) {
    const m = line.match(/^\s*QUESTION:\s*(.+)\s*$/i);
    if (m) out.push(m[1].trim());
  }
  return out;
}

export function startWorker({ projectName, projectPath, task, context, priorQA, addDirs = [], projectStats, onStart, onEnd }) {
  if (!canStart(projectName)) {
    console.log(`  [worker] ${projectName} already has an active worker — skipping dispatch`);
    return null;
  }

  const runId = randomUUID();
  const sessionId = randomUUID();
  const prompt = buildPrompt(task, context, priorQA, projectStats);

  const args = [
    '-p',
    '--permission-mode', 'acceptEdits',
    '--output-format', 'json',
    '--model', WORKER_MODEL,
    '--session-id', sessionId,
  ];
  if (addDirs.length) args.push('--add-dir', ...addDirs);
  args.push(
    '--allowedTools', 'Read,Edit,Write,Bash,Grep,Glob,WebFetch',
    '--',
    prompt,
  );

  console.log(`  [worker] launching claude -p in ${projectPath} (run ${runId.slice(0, 8)})`);
  markStart(projectName);

  const started = new Date().toISOString();
  const child = spawn(CLAUDE_BIN, args, {
    cwd: projectPath,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Wall-clock guard: a stuck `claude -p` would otherwise hold
  // activeRuns[project] indefinitely, blocking every future worker for
  // that project.
  //
  // Dynamic ceiling: if we have pre-merge-tests history for this project,
  // size the timeout to 3x the observed p95 (clamped to a 30min floor) so
  // slow-building projects aren't SIGTERMd mid-test while genuinely-stuck
  // fast projects are still killed fast. Falls back to WORKER_MAX_MS env
  // var, or 60min if neither is present.
  const preMergeP95 = projectStats?.['pre-merge-tests']?.p95 || 0;
  const historyBasedMax = preMergeP95 > 0
    ? Math.max(30 * 60_000, preMergeP95 * 3)
    : 0;
  const envMax = Number(process.env.WORKER_MAX_MS) || 0;
  const WORKER_MAX_MS = historyBasedMax || envMax || 60 * 60_000;
  let timedOut = false;
  const killTimer = setTimeout(() => {
    timedOut = true;
    console.error(
      `  [worker] ${projectName} run ${runId.slice(0, 8)} exceeded ${WORKER_MAX_MS}ms — sending SIGTERM`
    );
    try { child.kill('SIGTERM'); } catch {}
    // If SIGTERM doesn't land within 10s, escalate to SIGKILL.
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 10_000).unref();
  }, WORKER_MAX_MS);
  killTimer.unref();

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', d => { stdout += d.toString(); });
  child.stderr.on('data', d => { stderr += d.toString(); });

  Promise.resolve().then(() => onStart?.({ runId, sessionId, projectName, task, started })).catch(() => {});

  child.on('error', err => {
    clearTimeout(killTimer);
    markEnd(projectName);
    console.error(`  [worker] spawn error for ${projectName}:`, err.message);
    onEnd?.({ runId, sessionId, projectName, ended: new Date().toISOString(), status: 'error', summary: err.message, questions: [] });
  });

  child.on('exit', code => {
    clearTimeout(killTimer);
    markEnd(projectName);
    const ended = new Date().toISOString();
    let summary = '';
    let cost = null;
    let durationMs = null;
    let status = code === 0 ? 'done' : 'error';
    if (timedOut) {
      status = 'timeout';
      summary = `worker exceeded WORKER_MAX_MS=${WORKER_MAX_MS}ms and was SIGTERM'd`;
    }

    try {
      const parsed = JSON.parse(stdout);
      summary = parsed.result || parsed.message || stdout.slice(0, 2000);
      cost = parsed.total_cost_usd ?? null;
      durationMs = parsed.duration_ms ?? null;
      if (parsed.is_error) status = 'error';
    } catch {
      summary = (stdout || stderr || '').slice(0, 2000);
    }

    const questions = parseQuestions(summary);
    if (questions.length) {
      status = 'needs_answer';
      console.log(`  [worker] ${projectName} paused — ${questions.length} question(s) for user`);
    } else {
      console.log(`  [worker] ${projectName} finished (${status}, exit ${code})`);
      if (status === 'error' && stderr) {
        console.error(`  [worker] ${projectName} stderr: ${stderr.slice(0, 500)}`);
      }
    }
    onEnd?.({ runId, sessionId, projectName, ended, status, summary, cost, durationMs, questions });
  });

  return { runId, sessionId };
}
