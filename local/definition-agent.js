// SPEC 7 — Feature Definition Agent.
//
// Given a capture that will span multiple apps (or one that the user wants
// scoped more carefully), ask Gemini for ≤5 clarifying questions, POST them
// to /api/definition-threads, and return the thread row. Once the user has
// answered + approved, the daemon generates the spec and writes it to
// docs/INTEGRATIONS/<slug>.md (cross-app) or inline on the thread row.
//
// The plan originally called for Claude here; per the Gemini-substitution
// rule, we use Gemini for the question generation. Claude remains for the
// `claude -p` CLI calls in auto-pr.js / reflection-agent.js.

import { GoogleGenAI } from '@google/genai';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const DEF_MODEL = process.env.GEMINI_DEFINITION_MODEL || 'gemini-2.0-flash';
const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const SYSTEM_PROMPT = `You are Maestro's Feature Definition agent. Your job is to ask clarifying questions before a worker is dispatched.

Rules:
- Ask AT MOST 5 questions. Fewer is better.
- Only ask when the answer would materially change the implementation.
- If the feature is obvious/atomic, return an empty questions array.
- Prefer concrete questions ("Should the button appear on the login screen or the dashboard?") over vague ones ("What UX do you want?").

Return JSON only: {"questions": [string, ...], "suggested_title": string}

The suggested_title should be 3-7 words, imperative, no period.`;

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'feature';
}

export function loadSystemContext({ repoRoot }) {
  const parts = [];
  const systemMdPath = join(repoRoot, 'docs', 'SYSTEM.md');
  if (existsSync(systemMdPath)) {
    try { parts.push('# SYSTEM.md\n' + readFileSync(systemMdPath, 'utf8')); } catch {}
  }
  return parts.join('\n\n---\n\n');
}

// Load READMEs for the named apps. suiteRoots: { gloss: '/path', comms: '/path', ... }
export function loadAppReadmes(apps, suiteRoots) {
  const parts = [];
  for (const app of apps || []) {
    const root = suiteRoots?.[app];
    if (!root) continue;
    const p = join(root, 'README.md');
    if (!existsSync(p)) continue;
    try { parts.push(`# ${app}/README.md\n` + readFileSync(p, 'utf8')); } catch {}
  }
  return parts.join('\n\n---\n\n');
}

/**
 * Ask the model for clarifying questions.
 * @param {object} opts
 * @param {string} opts.captureText — the raw capture.
 * @param {string[]} [opts.affectedApps] — apps the capture touches.
 * @param {string} [opts.systemContext] — prepended to the prompt.
 * @param {string} [opts.appContext] — READMEs concatenated.
 * @param {Function} [opts.generate] — injected for tests.
 */
export async function generateQuestions(opts) {
  const { captureText, affectedApps = [], systemContext = '', appContext = '' } = opts;
  if (!captureText?.trim()) throw new Error('captureText required');
  const generate = opts.generate ?? ((p) => genai.models.generateContent(p));

  const userPrompt = [
    systemContext && `System context:\n${systemContext}`,
    appContext && `Affected apps (READMEs):\n${appContext}`,
    affectedApps.length ? `Apps likely involved: ${affectedApps.join(', ')}` : '',
    `Capture:\n${captureText}`,
  ].filter(Boolean).join('\n\n');

  const response = await generate({
    model: DEF_MODEL,
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    config: {
      systemInstruction: SYSTEM_PROMPT,
      responseMimeType: 'application/json',
      temperature: 0.3,
      maxOutputTokens: 1024,
    },
  });
  const raw = (response.text || '').trim();
  if (!raw) throw new Error('empty model response');
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '');
  const parsed = JSON.parse(cleaned);
  const questions = Array.isArray(parsed.questions) ? parsed.questions.slice(0, 5) : [];
  const suggested_title = typeof parsed.suggested_title === 'string'
    ? parsed.suggested_title.trim()
    : captureText.trim().split(/\s+/).slice(0, 5).join(' ');
  return { questions, suggested_title };
}

/**
 * Generate a spec markdown from the approved thread. For cross-app features
 * the spec will be written by the caller to `docs/INTEGRATIONS/<slug>.md`;
 * for single-app it's stored inline on the thread.
 */
export async function generateSpec(opts) {
  const { thread, systemContext = '' } = opts;
  if (!thread?.feature_title) throw new Error('thread.feature_title required');
  const generate = opts.generate ?? ((p) => genai.models.generateContent(p));

  const qa = (() => {
    const qs = Array.isArray(thread.questions) ? thread.questions : [];
    const as = thread.answers && typeof thread.answers === 'object' ? thread.answers : {};
    const lines = qs.map((q, i) => {
      const a = as[i] ?? as[String(i)] ?? (Array.isArray(as) ? as[i] : '');
      return `- Q: ${q}\n  A: ${a || '(no answer)'}`;
    });
    return lines.join('\n');
  })();

  const userPrompt = [
    systemContext && `System context:\n${systemContext}`,
    `Feature: ${thread.feature_title}`,
    Array.isArray(thread.affected_apps) && thread.affected_apps.length
      ? `Apps: ${thread.affected_apps.join(', ')}` : '',
    qa ? `Clarifications:\n${qa}` : '',
  ].filter(Boolean).join('\n\n');

  const sys = `You are Maestro's spec writer. Emit a concise markdown spec with sections:
## Summary
## Scope
## Contract (API + schema, if cross-app)
## Implementation notes
## Acceptance

Do NOT write code. No preamble.`;

  const response = await generate({
    model: DEF_MODEL,
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    config: {
      systemInstruction: sys,
      temperature: 0.2,
      maxOutputTokens: 2048,
    },
  });
  return (response.text || '').trim();
}

export function threadSlug(thread) { return slugify(thread.feature_title); }

/**
 * One-shot helper: take a capture, ask the model for questions, POST to
 * cloud. Returns the created thread.
 */
export async function openThreadForCapture({ captureText, affectedApps, captureId, cloudApi, repoRoot, suiteRoots, generate }) {
  const systemContext = loadSystemContext({ repoRoot });
  const appContext = loadAppReadmes(affectedApps, suiteRoots);
  const { questions, suggested_title } = await generateQuestions({
    captureText, affectedApps, systemContext, appContext, generate,
  });
  const body = {
    feature_title: suggested_title || captureText.slice(0, 80),
    questions,
    capture_id: captureId,
    affected_apps: affectedApps,
  };
  const row = await cloudApi('POST', '/api/definition-threads', body);
  return row;
}
