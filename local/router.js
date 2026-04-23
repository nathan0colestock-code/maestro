import { GoogleGenAI } from '@google/genai';
import { readFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { getProjectStats } from './pipeline-stats.js';

const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const ROUTER_MODEL = 'gemini-2.5-flash';

// Load SYSTEM.md once at module import so every routing call carries the
// suite-wide map (apps, integration points, pipeline states). Failure is
// non-fatal — routing still works, it just won't know about integrations.
let SUITE_SYSTEM_CONTEXT = '';
let LESSONS_CONTEXT = '';
try {
  const here = dirname(fileURLToPath(import.meta.url));
  SUITE_SYSTEM_CONTEXT = await readFile(resolve(here, '..', 'SYSTEM.md'), 'utf8');
} catch { /* absent or unreadable — proceed without it */ }
// LESSONS.md is written by the nightly reflection loop. Loading it on each
// require so rules compound across nights — a lesson added last night is in
// effect tonight without a daemon restart.
async function loadLessons() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return await readFile(resolve(here, '..', 'LESSONS.md'), 'utf8');
  } catch { return ''; }
}

function formatAge(isoString) {
  if (!isoString) return 'unknown';
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatTimingLine(project, stats) {
  if (!stats || !Object.keys(stats).length) return `${project}: (no recent pipeline history)`;
  const parts = [];
  for (const phase of ['pre-merge-tests', 'merge', 'deploy', 'integration-tests']) {
    const s = stats[phase];
    if (!s || !s.n) continue;
    const p50s = (s.p50 / 1000).toFixed(1);
    const p95s = (s.p95 / 1000).toFixed(1);
    parts.push(`${phase} p50=${p50s}s p95=${p95s}s (n=${s.n})`);
  }
  return parts.length ? `${project}: ${parts.join('; ')}` : `${project}: (no recent pipeline history)`;
}

function buildSystemPrompt(projects, sessions, openFeatureSets, projectStatsByName = {}) {
  const sessionsByProject = {};
  for (const s of sessions) sessionsByProject[s.project_name] = s;

  const setsByProject = {};
  for (const fs of openFeatureSets || []) (setsByProject[fs.project_name] ||= []).push(fs);

  const projectLines = projects.map(p => {
    const session = sessionsByProject[p.name];
    const sessionStatus = session
      ? session.is_active
        ? `ACTIVE — ${session.agent_type || 'agent'}, last action: ${session.last_action} (${formatAge(session.last_active)})`
        : `IDLE — last session ${formatAge(session.last_active)}`
      : 'NO SESSIONS YET';

    const sets = (setsByProject[p.name] || []).map(fs =>
      `  - feature_set_id=${fs.id} "${fs.title}"${fs.description ? ` — ${fs.description}` : ''} (${fs.task_count || 0} tasks)`
    ).join('\n');

    return [
      `### ${p.name} (${p.path})`,
      p.description ? `Description: ${p.description}` : '',
      p.goals ? `Goals: ${p.goals}` : '',
      p.current_focus ? `Current focus: ${p.current_focus}` : '',
      p.last_commit ? `Last commit: ${p.last_commit}` : '',
      `Open tasks: ${p.open_task_count}`,
      `Claude session: ${sessionStatus}`,
      sets ? `Open feature sets:\n${sets}` : 'Open feature sets: (none)',
    ].filter(Boolean).join('\n');
  }).join('\n\n');

  return `You are the orchestration layer for a developer's Claude Code workflow. Your job is to analyze voice notes and ideas, then produce a precise routing plan.

Tasks accumulate into "feature sets" — coherent bundles of related work that will be implemented together overnight as a single branch. Multiple captures about the same feature should land in the same feature set.

## Projects

${projectLines}

## Routing Rules

- If a capture is about **building an integration between projects** (one app calling another, sharing data, webhooks, shared contracts), emit a SINGLE task with \`is_integration: true\`, a primary \`project\` (the service/owner of the contract — usually the callee), and \`integration_projects\` listing the other involved projects. A single worker will handle both sides with a shared spec.
- If a capture asks for **the same change applied across multiple apps** ("in all apps", "across the suite", "every project", or explicitly naming 3+ projects getting the same treatment — e.g. "remove the app switcher from flock, gloss, tend, and comms"), emit a SINGLE task with \`is_integration: true\`, pick any one of the named projects as the primary \`project\`, and list the REST in \`integration_projects\`. Do NOT decompose into N separate per-project sets — that creates N branches instead of one coordinated change and explodes the merge/deploy blast radius. One worker, one branch name, fans out across the listed repos.
- If a capture is unrelated to integration and genuinely asks for different work in different projects, decompose it into separate items per project.
- For each "task" action, you MUST either attach to an existing feature_set_id (when the capture clearly extends an open set) OR propose a new feature set with a short title + one-sentence description.
- Prefer attaching to an existing set if the topic overlaps; only create a new set when the capture introduces a genuinely new theme.
- "note" and "doc" actions do not belong to feature sets — they get filed directly.
- Be specific: rewrite vague language into concrete, actionable task descriptions.
- Include a brief "context" note explaining why this task matters.

Respond ONLY with valid JSON matching this schema:
{
  "captures_decomposed": [
    {
      "project": "<primary project name>",
      "action": "task" | "note" | "doc",
      "text": "<specific actionable text>",
      "context": "<brief explanation>",
      "feature_set_id": <number or null>,
      "new_feature_set": { "title": "<short title>", "description": "<one sentence>" } | null,
      "is_integration": <boolean, default false>,
      "integration_projects": [<other project names>] | null
    }
  ]
}

For "task" action exactly one of feature_set_id or new_feature_set must be non-null. For "note"/"doc", both should be null. When is_integration=true, integration_projects must be non-empty.

## Historical timing for each project

Recent pipeline timings (last 7 days). A project whose deploy p95 is minutes long is a higher-risk merge target than one whose p95 is seconds; weight that into how aggressively you batch tasks into the same feature set.

${projects.map(p => formatTimingLine(p.name, projectStatsByName[p.name])).join('\n')}${SUITE_SYSTEM_CONTEXT ? `

---

## Suite system context (from maestro/SYSTEM.md)

${SUITE_SYSTEM_CONTEXT}` : ''}${LESSONS_CONTEXT ? `

---

## Lessons from past nights (from maestro/LESSONS.md)

These rules were written by Maestro's own nightly reflection loop after past runs. Treat them as authoritative when they apply.

${LESSONS_CONTEXT}` : ''}`;
}

// Transient errors we retry with exponential backoff: 429 rate limit, 5xx,
// network flakes, empty body. Permanent errors (400 bad prompt, 401 key) fail fast.
function isTransientGeminiError(err) {
  const msg = String(err?.message || err || '');
  const status = err?.status ?? err?.code;
  if (status === 429 || (typeof status === 'number' && status >= 500 && status < 600)) return true;
  if (/\b(429|5\d\d)\b/.test(msg)) return true;
  if (/RESOURCE_EXHAUSTED|UNAVAILABLE|DEADLINE_EXCEEDED|INTERNAL/i.test(msg)) return true;
  if (/fetch failed|network|ETIMEDOUT|ECONNRESET|socket hang up/i.test(msg)) return true;
  if (/empty response/i.test(msg)) return true;
  return false;
}

export async function routeCapture(captureText, projects, sessions, openFeatureSets = [], opts = {}) {
  const maxAttempts = opts.maxAttempts ?? 4;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  const sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
  const generate = opts.generate ?? ((params) => genai.models.generateContent(params));

  // Pull stats for every project in parallel. getProjectStats is cached
  // (10 min TTL) so rapid capture bursts don't hammer the cloud.
  const statsPairs = await Promise.all(projects.map(async p => {
    try { return [p.name, await getProjectStats(p.name, { lookback_days: 7 })]; }
    catch { return [p.name, {}]; }
  }));
  const projectStatsByName = Object.fromEntries(statsPairs);
  // Refresh lessons on every routing call — the reflector may have appended
  // since the last capture, and we want the freshest rules in effect.
  LESSONS_CONTEXT = await loadLessons();
  const systemInstruction = buildSystemPrompt(projects, sessions, openFeatureSets, projectStatsByName);

  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await generate({
        model: ROUTER_MODEL,
        contents: [{ role: 'user', parts: [{ text: captureText }] }],
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
          temperature: 0.2,
          maxOutputTokens: 2048,
        },
      });

      const raw = (response.text || '').trim();
      if (!raw) throw new Error('Gemini returned empty response');

      const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '');
      return JSON.parse(cleaned);
    } catch (err) {
      lastErr = err;
      if (!isTransientGeminiError(err) || attempt === maxAttempts) throw err;
      // Jittered exponential backoff: 1s, 2s, 4s (+ up to 500ms jitter).
      const delay = baseDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 500);
      console.warn(`[router] transient error on attempt ${attempt}/${maxAttempts}: ${err.message} — retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

// Exported for unit testing — pure function, no I/O.
export const _test = { isTransientGeminiError };
