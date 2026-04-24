// Opus validator for self-improvement suggestions.
//
// Sits between reflection-agent's output and auto-pr's claude -p apply
// step. Reads the CURRENT state of target_file + recent commits, asks
// Claude Opus whether the proposed change:
//   - STILL MAKES SENSE          → approve (keep original patch_hint)
//   - NEEDS REFINEMENT           → refine (returns fresh patch_hint)
//   - IS ALREADY DONE / DOESN'T APPLY → skip
//
// Fail-closed: on parse error or spawn failure, decision=skip. Better to
// drop a good suggestion than to auto-PR against stale reasoning.

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';

const CLAUDE_CMD = process.env.CLAUDE_CMD || 'claude';
const VALIDATOR_MODEL = process.env.VALIDATOR_MODEL || 'claude-opus-4-7';
const MAX_FILE_CHARS = 40_000;

const SYSTEM_PROMPT = `You gate Maestro's self-improvement pipeline. Given a proposed self-improvement and the CURRENT state of the target file, return JSON only:

{
  "decision": "approve" | "refine" | "skip",
  "reason": "<one sentence>",
  "refined_hint": "<required iff decision=refine; a fresh patch_hint grounded in the current code>"
}

Decision rules:
- approve: target exists, description matches a real code issue, patch_hint maps cleanly to the current code.
- refine: directionally right but the patch_hint references an old structure OR is vague; you can describe a concrete change grounded in THIS file's current state.
- skip: the change is already implemented, OR the target function/section no longer exists, OR the suggestion contradicts recent commits, OR the description is too vague to act on without product input.

Output the JSON object, nothing else. No markdown fences, no preamble.`;

export function buildValidatorPrompt({ suggestion, currentCode, recentLog }) {
  return [
    '## Proposed self-improvement',
    `Target file: ${suggestion.target_file}`,
    `Description: ${suggestion.description || '(none)'}`,
    `Patch hint: ${suggestion.patch_hint || '(none)'}`,
    `Rank: ${suggestion.rank ?? '?'} | Confidence: ${suggestion.confidence ?? '?'} | Effort (h): ${suggestion.effort_hours ?? '?'}`,
    '',
    '## Current target file',
    '```',
    currentCode,
    '```',
    '',
    recentLog ? '## Recent commits touching this file\n' + recentLog : '',
    '',
    '## Your task',
    'Emit JSON only per the schema. Do not include any prose before or after.',
  ].filter(Boolean).join('\n');
}

export function parseDecision(raw) {
  const stripped = String(raw)
    .replace(/```(?:json)?\s*([\s\S]*?)```/g, '$1')
    .trim();
  const match = stripped.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('no JSON object in validator output');
  const obj = JSON.parse(match[0]);
  if (!['approve', 'refine', 'skip'].includes(obj.decision)) {
    throw new Error(`invalid decision: ${JSON.stringify(obj.decision)}`);
  }
  if (obj.decision === 'refine' && !obj.refined_hint) {
    throw new Error('refine decision requires refined_hint');
  }
  return obj;
}

function defaultRunClaude({ cwd, model }) {
  return (systemPrompt, userPrompt) => new Promise((done, fail) => {
    const args = [
      '-p', userPrompt,
      '--model', model,
      '--append-system-prompt', systemPrompt,
      '--output-format', 'text',
    ];
    const child = spawn(CLAUDE_CMD, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { err += d.toString(); });
    child.on('error', fail);
    child.on('close', code => {
      if (code === 0) done(out);
      else fail(new Error(`claude -p exited ${code}: ${err.slice(0, 300)}`));
    });
  });
}

function gitLogFor(file, { cwd }) {
  return new Promise(done => {
    execFile('git', ['log', '-5', '--oneline', '--', file], { cwd }, (err, stdout) => {
      if (err) return done(null);
      done(stdout.trim() || null);
    });
  });
}

/**
 * Validate one suggestion. Returns { decision, reason, refined_hint?, elapsed_ms }.
 * Never throws — returns decision='skip' with reason for any failure.
 */
export async function validate(suggestion, {
  cwd = process.cwd(),
  readFileImpl = readFile,
  runClaude,
  model = VALIDATOR_MODEL,
} = {}) {
  const t0 = Date.now();
  if (!suggestion?.target_file) {
    return { decision: 'skip', reason: 'no target_file on suggestion', elapsed_ms: Date.now() - t0 };
  }
  const runner = runClaude || defaultRunClaude({ cwd, model });

  let currentCode;
  try {
    currentCode = await readFileImpl(resolve(cwd, suggestion.target_file), 'utf8');
  } catch (err) {
    return { decision: 'skip', reason: `target_file unreadable: ${err.code || err.message}`, elapsed_ms: Date.now() - t0 };
  }
  if (currentCode.length > MAX_FILE_CHARS) {
    currentCode = currentCode.slice(0, MAX_FILE_CHARS) + '\n... (truncated)';
  }

  const recentLog = await gitLogFor(suggestion.target_file, { cwd });
  const prompt = buildValidatorPrompt({ suggestion, currentCode, recentLog });

  let raw;
  try {
    raw = await runner(SYSTEM_PROMPT, prompt);
  } catch (err) {
    return { decision: 'skip', reason: `claude invocation failed: ${err.message}`, elapsed_ms: Date.now() - t0 };
  }

  try {
    const parsed = parseDecision(raw);
    return { ...parsed, elapsed_ms: Date.now() - t0 };
  } catch (err) {
    return { decision: 'skip', reason: `validator parse error: ${err.message}`, elapsed_ms: Date.now() - t0 };
  }
}

/**
 * Batch gate: runs validate over every suggestion. Returns kept (approve +
 * refine-replaced) and dropped arrays. For refined suggestions the original
 * patch_hint is replaced with the refined_hint.
 */
export async function validateAll(suggestions, opts = {}) {
  const kept = [];
  const dropped = [];
  for (const s of suggestions || []) {
    const v = await validate(s, opts);
    if (v.decision === 'approve') {
      kept.push({ ...s, validator: v });
    } else if (v.decision === 'refine') {
      kept.push({ ...s, patch_hint: v.refined_hint, validator: v });
    } else {
      dropped.push({ ...s, validator: v });
    }
  }
  return { kept, dropped };
}
