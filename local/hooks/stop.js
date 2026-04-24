#!/usr/bin/env node
// Maestro Stop hook — captures worker completion in real-time instead of
// waiting for worker.js's onEnd callback. Installed in ~/.claude/settings.json
// under "hooks.Stop". If the current working directory maps to a tracked
// project, the hook POSTs summary/cost/tokens to the Maestro cloud.
//
// Stdin:  { hook_event_name, session_id, cwd, stop_hook_active, transcript, ... }
// Stdout: empty (no prompt injection for Stop)
//
// Silent on error — a broken hook must never block the worker from exiting.

const CLOUD_URL = process.env.MAESTRO_CLOUD_URL || 'https://your-maestro-app.fly.dev';
const SECRET = process.env.MAESTRO_SECRET || process.env.SUITE_API_KEY || '';
const TIMEOUT_MS = 2500;

function bail() { process.exit(0); }

function projectNameFromCwd(cwd) {
  if (!cwd) return null;
  return cwd.split('/').filter(Boolean).pop() || null;
}

// Best-effort token total from the transcript. Claude Code emits per-message
// usage blocks; we sum input + output tokens across the transcript if present.
function sumTokens(transcript) {
  if (!Array.isArray(transcript)) return { in: null, out: null };
  let tin = 0, tout = 0, any = false;
  for (const entry of transcript) {
    const u = entry?.message?.usage || entry?.usage;
    if (!u) continue;
    any = true;
    tin  += Number(u.input_tokens || 0);
    tout += Number(u.output_tokens || 0);
  }
  return any ? { in: tin, out: tout } : { in: null, out: null };
}

async function main() {
  let stdin = '';
  try {
    for await (const chunk of process.stdin) stdin += chunk;
  } catch { return bail(); }
  if (!stdin) return bail();

  let payload;
  try { payload = JSON.parse(stdin); } catch { return bail(); }

  const cwd = payload.cwd || process.cwd();
  const project = projectNameFromCwd(cwd);
  const sessionId = payload.session_id;
  if (!project || !sessionId) return bail();

  const { in: tokens_in, out: tokens_out } = sumTokens(payload.transcript || payload.messages);

  const body = {
    session_id: sessionId,
    project_name: project,
    ended_at: new Date().toISOString(),
    status: payload.stop_hook_active ? 'active' : 'done',
    tokens_in,
    tokens_out,
  };

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    await fetch(`${CLOUD_URL}/api/worker/stop-hook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(SECRET ? { 'Authorization': `Bearer ${SECRET}` } : {}),
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
  } catch { /* silent — never block worker exit */ }
  bail();
}

main().catch(() => bail());
