import { GoogleGenAI } from '@google/genai';
import { readFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const ROUTER_MODEL = 'gemini-2.5-flash';

// Load SYSTEM.md once at module import so every routing call carries the
// suite-wide map (apps, integration points, pipeline states). Failure is
// non-fatal — routing still works, it just won't know about integrations.
let SUITE_SYSTEM_CONTEXT = '';
try {
  const here = dirname(fileURLToPath(import.meta.url));
  SUITE_SYSTEM_CONTEXT = await readFile(resolve(here, '..', 'SYSTEM.md'), 'utf8');
} catch { /* absent or unreadable — proceed without it */ }

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

function buildSystemPrompt(projects, sessions, openFeatureSets) {
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
- If a capture is unrelated to integration but happens to touch multiple projects, decompose it into separate items per project (current behavior).
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

For "task" action exactly one of feature_set_id or new_feature_set must be non-null. For "note"/"doc", both should be null. When is_integration=true, integration_projects must be non-empty.${SUITE_SYSTEM_CONTEXT ? `

---

## Suite system context (from maestro/SYSTEM.md)

${SUITE_SYSTEM_CONTEXT}` : ''}`;
}

export async function routeCapture(captureText, projects, sessions, openFeatureSets = []) {
  const systemInstruction = buildSystemPrompt(projects, sessions, openFeatureSets);

  const response = await genai.models.generateContent({
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
}
