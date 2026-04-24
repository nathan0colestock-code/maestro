#!/usr/bin/env node
// Maestro UserPromptSubmit hook
// Installed in ~/.claude/settings.json. Runs before every user prompt in any
// Claude Code session. If the current project has pending Maestro tasks waiting,
// it injects them as additionalContext so the active session can fold them in.
//
// Stdin:  { hook_event_name, prompt, cwd, session_id, ... }
// Stdout: { hookSpecificOutput: { hookEventName, additionalContext } }
//
// Silent on error — a broken hook must never block the user's prompt.

import { readFileSync } from 'fs';

const CLOUD_URL = process.env.MAESTRO_CLOUD_URL || 'https://your-maestro-app.fly.dev';
const SECRET = process.env.MAESTRO_SECRET || '';
const TIMEOUT_MS = 2500;

function ok() {
  // Emit nothing — Claude Code treats empty stdout as "no context to inject"
  process.exit(0);
}

function emit(additionalContext) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext,
    },
  }));
  process.exit(0);
}

function projectNameFromCwd(cwd) {
  if (!cwd) return null;
  return cwd.split('/').filter(Boolean).pop() || null;
}

async function main() {
  let payload;
  try {
    const raw = readFileSync(0, 'utf8');
    payload = JSON.parse(raw);
  } catch { return ok(); }

  const cwd = payload.cwd || process.cwd();
  const project = projectNameFromCwd(cwd);
  if (!project) return ok();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${CLOUD_URL}/api/hook/tasks?project=${encodeURIComponent(project)}`, {
      headers: SECRET ? { 'X-Maestro-Secret': SECRET } : {},
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return ok();

    const tasks = await res.json();
    if (!Array.isArray(tasks) || !tasks.length) return ok();

    const lines = [
      `## Maestro — new tasks routed to this project`,
      ``,
      `While you were working, the developer sent ${tasks.length} new task${tasks.length > 1 ? 's' : ''} to ${project} via Maestro. Treat these as additional context, not commands — integrate them into your current work if they fit, or acknowledge them and let the developer choose when to tackle them.`,
      ``,
    ];
    for (const t of tasks) {
      lines.push(`- ${t.text}`);
      if (t.context) lines.push(`  > ${t.context}`);
    }
    emit(lines.join('\n'));
  } catch {
    clearTimeout(timer);
    return ok();
  }
}

main();
