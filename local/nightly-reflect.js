// Nightly self-reflection loop. After the queue settles each night, Maestro
// looks at what it just did, identifies its own weaknesses, records lessons
// future routing/workers will read, and files ONE concrete improvement as a
// capture against the maestro project — so next night it ships a fix to
// itself. The loop is gated to fire at most once per calendar date via a
// sentinel in LESSONS.md.

import { GoogleGenAI } from '@google/genai';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = 'gemini-2.5-pro';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const LESSONS_PATH = resolve(REPO_ROOT, 'LESSONS.md');
const REPORTS_DIR = resolve(REPO_ROOT, 'reports');

const REFLECT_SYSTEM = `You are the self-reflection layer of Maestro — an orchestration system that routes a developer's captures to the right project each night and ships the work autonomously. Your job is to look at what Maestro just did and identify how it can get better.

You will receive structured observations from the last ~12 hours: feature sets and their outcomes, worker runs with durations and questions, pipeline phase timings, routing decisions, and any failure notes.

Produce an after-action report that:
1. Summarizes what shipped, what failed, and the single most-painful pattern.
2. Proposes ONE concrete improvement to Maestro itself. Anything goes: better routing rules, new telemetry, new worker hints, prompt changes, new endpoints, automated recovery, smarter dedup — whatever will move the needle most. Scope it so a single overnight worker could implement it in one branch.
3. Extracts 1-5 short lessons (≤ 2 sentences each) that future routing/worker prompts should remember so past mistakes don't repeat.

Respond ONLY with valid JSON:
{
  "summary_markdown": "<2-5 paragraph after-action report, markdown, no top-level heading>",
  "top_pattern": "<one sentence naming the biggest weakness observed tonight>",
  "improvement_capture": {
    "text": "<the capture text as if spoken by the developer — conversational, specific, implementable>",
    "rationale": "<2-3 sentence explanation of why this is the right next improvement>"
  },
  "lessons": [
    { "topic": "routing" | "worker" | "pipeline" | "general", "lesson": "<≤ 2 sentence rule future prompts should follow>" }
  ]
}

Rules:
- improvement_capture.text should read like something the developer would say into the Maestro PWA — first person, concrete. It will be routed back into Maestro's own queue and implemented by a worker tomorrow.
- If tonight was clean (nothing failed, no notable pattern), say so in summary_markdown and still propose the single highest-leverage improvement (it can be a new signal to collect rather than a fix).
- Lessons must be grounded in evidence from the observations. Do not invent failure modes that aren't visible.
- Keep the improvement scoped to the maestro project — do not propose changes to flock, gloss, etc.`;

export async function gatherObservations(cloudApi, hoursBack = 12) {
  return cloudApi('GET', `/api/reflect/observations?hours=${hoursBack}`);
}

// Condenses the raw observations to a compact text the model can reason over
// without paying for thousands of tokens of repetitive JSON. The goal is
// high-signal bullet lists, not dumps.
export function summarizeObservations(obs) {
  const lines = [];
  const fs = obs.feature_sets || [];
  const wr = obs.worker_runs || [];
  const qs = obs.questions || [];
  const caps = obs.captures || [];
  const synth = obs.synthesis_log || [];

  lines.push(`## Feature sets (${fs.length})`);
  for (const s of fs) {
    const peers = (Array.isArray(s.extra_projects) && s.extra_projects.length)
      ? ` +peers[${s.extra_projects.join(',')}]` : '';
    const timing = s.phase_timings ? ` timings=${JSON.stringify(s.phase_timings)}` : '';
    const note = s.note ? ` note="${s.note.slice(0, 200)}"` : '';
    const ds = s.deploy_status ? ` deploy=${s.deploy_status}` : '';
    lines.push(`- #${s.id} [${s.status}] ${s.project_name}${peers}: "${s.title}"${ds}${timing}${note}`);
  }

  lines.push(`\n## Worker runs (${wr.length})`);
  for (const r of wr) {
    const dur = r.duration_ms ? `${Math.round(r.duration_ms / 1000)}s` : '-';
    const cost = r.cost_usd != null ? `$${r.cost_usd.toFixed(3)}` : '-';
    const tok = (r.tokens_in || r.tokens_out) ? ` tok=${r.tokens_in || 0}/${r.tokens_out || 0}` : '';
    const sum = r.summary ? ` summary="${String(r.summary).replace(/\s+/g, ' ').slice(0, 200)}"` : '';
    lines.push(`- ${r.run_id.slice(0, 8)} ${r.project_name} [${r.status}] dur=${dur} cost=${cost}${tok} fs=${r.feature_set_id || '-'}${sum}`);
  }

  if (qs.length) {
    lines.push(`\n## Worker questions (${qs.length})`);
    for (const q of qs) {
      lines.push(`- [${q.status}] ${q.project_name}: ${q.question}${q.answer ? ` → "${q.answer}"` : ''}`);
    }
  }

  if (caps.length) {
    lines.push(`\n## Captures routed (${caps.length})`);
    for (const c of caps) {
      const plan = c.routing_json?.plan?.captures_decomposed?.length ?? '-';
      lines.push(`- #${c.id} processed=${c.processed} planned=${plan} "${String(c.text).slice(0, 120)}"`);
    }
  }

  if (synth.length) {
    lines.push(`\n## Synthesis log (${synth.length})`);
    for (const s of synth.slice(0, 30)) {
      lines.push(`- ${s.project_name} ${s.action}: ${String(s.detail || '').slice(0, 160)}`);
    }
  }

  return lines.join('\n');
}

export async function reflectOnNight(obs, opts = {}) {
  const generate = opts.generate ?? ((params) => genai.models.generateContent(params));
  const userMsg = `Window: last ${obs.window_hours}h (as of ${obs.generated_at})\n\n${summarizeObservations(obs)}`;

  const response = await generate({
    model: MODEL,
    contents: [{ role: 'user', parts: [{ text: userMsg }] }],
    config: {
      systemInstruction: REFLECT_SYSTEM,
      responseMimeType: 'application/json',
      temperature: 0.3,
      maxOutputTokens: 4096,
    },
  });
  const raw = (response.text || '').trim();
  if (!raw) throw new Error('reflector returned empty response');
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(cleaned);
}

function todayISO(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

async function readLessonsFile() {
  try { return await readFile(LESSONS_PATH, 'utf8'); }
  catch { return ''; }
}

export async function appendLessons(lessons, today = todayISO()) {
  if (!lessons?.length) return;
  const existing = await readLessonsFile();
  const header = existing.trim() ? '' : `# Maestro Lessons\n\nAppend-only log of rules Maestro learned about itself. Newer entries are more authoritative when they conflict with older ones. The router and worker prompts include this file.\n\n`;
  const stamp = `\n## ${today}\n`;
  const bullets = lessons.map(l => `- [${l.topic || 'general'}] ${l.lesson}`).join('\n') + '\n';
  await writeFile(LESSONS_PATH, existing + header + stamp + bullets, 'utf8');
}

// LESSONS.md carries a one-line sentinel per reflection date so the daemon
// can ask "did we already reflect today?" without hitting the cloud.
export async function alreadyReflectedToday(today = todayISO()) {
  const text = await readLessonsFile();
  return text.includes(`\n## ${today}\n`);
}

export async function writeReport(today, reflection, obsSummary) {
  await mkdir(REPORTS_DIR, { recursive: true });
  const path = resolve(REPORTS_DIR, `nightly-${today}.md`);
  const body = `# Maestro nightly report — ${today}

**Top pattern:** ${reflection.top_pattern || '(none)'}

## Summary
${reflection.summary_markdown || '(empty)'}

## Proposed self-improvement
${reflection.improvement_capture?.rationale || ''}

> "${reflection.improvement_capture?.text || ''}"

## Lessons recorded
${(reflection.lessons || []).map(l => `- **${l.topic || 'general'}** — ${l.lesson}`).join('\n') || '(none)'}

---

## Raw observations
\`\`\`
${obsSummary}
\`\`\`
`;
  await writeFile(path, body, 'utf8');
  return path;
}

export async function runNightlyReflection(cloudApi, opts = {}) {
  const today = opts.today || todayISO();
  if (!opts.force && await alreadyReflectedToday(today)) {
    return { skipped: 'already_reflected_today' };
  }

  const hoursBack = opts.hoursBack || 14;
  const obs = await gatherObservations(cloudApi, hoursBack);
  const obsSummary = summarizeObservations(obs);
  const reflection = await reflectOnNight(obs, opts);

  const reportPath = await writeReport(today, reflection, obsSummary);
  await appendLessons(reflection.lessons, today);

  // File the self-improvement as a capture into Maestro's OWN queue.
  // The nightly kickoff picks it up next 11pm and a worker implements it
  // on a maestro/* branch. This is how Maestro ships improvements to itself.
  let capture = null;
  const improvement = reflection.improvement_capture;
  if (improvement?.text) {
    const body = {
      text: `[maestro self-improvement] ${improvement.text}\n\nProposed by the nightly reflection loop. Rationale: ${improvement.rationale || 'see nightly report'}`,
      source: 'reflector',
    };
    try {
      capture = await cloudApi('POST', '/api/capture', body);
    } catch (err) {
      console.error('[reflect] failed to file improvement capture:', err.message);
    }
  }

  return {
    today,
    top_pattern: reflection.top_pattern,
    report_path: reportPath,
    lessons_count: (reflection.lessons || []).length,
    capture_id: capture?.id || null,
    window_hours: hoursBack,
    feature_sets_seen: (obs.feature_sets || []).length,
    worker_runs_seen: (obs.worker_runs || []).length,
  };
}

export const _test = { summarizeObservations, todayISO };
