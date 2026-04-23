// Nightly-ish pass: for each project, ask Gemini to identify duplicate pending
// tasks and collapse them. Keeps the aggregated idea pool tidy so workers spend
// their cycles on distinct problems, not three near-identical phrasings.

import { GoogleGenAI } from '@google/genai';

const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = 'gemini-2.5-flash';

const SYSTEM = `You help a developer tidy a task backlog. Given a list of pending tasks for one project, identify clusters where multiple tasks describe the same underlying work (near-duplicates, rephrasings, or a vague version of a more-specific one).

Return ONLY valid JSON:
{
  "clusters": [
    {
      "keep_id": <integer id of the task to keep>,
      "merge_ids": [<integer ids of tasks that duplicate it>],
      "merged_text": "<best merged phrasing, absorbing any extra detail from merged tasks>",
      "reason": "<short reason these are the same>"
    }
  ]
}

Rules:
- Only cluster tasks that describe the SAME work — don't merge related-but-distinct tasks.
- Prefer keeping the task with the most specific text; absorb detail from the others into merged_text.
- Return an empty "clusters" array if nothing merges.
- Never put the keep_id in its own merge_ids.`;

const CLARITY_SYSTEM = `You refine a feature set's title and description to clearly capture the intent of all its tasks. The developer adds captures throughout the day; your job is to keep the summary clear and specific.

Return ONLY valid JSON:
{ "title": "<short imperative phrase, 6-10 words>", "description": "<one sentence explaining the feature and why it matters>" }

Rules:
- Title should be imperative ("Add contact editing and merging") not a sentence.
- Description should cover the scope of all tasks without listing them one by one.
- If the existing title/description already captures it well, return them unchanged.`;

export async function clarifyFeatureSet(set) {
  if (!set?.tasks?.length) return null;
  const taskList = set.tasks.map(t => `- ${t.text}`).join('\n');
  const userMsg = `Project: ${set.project_name}
Current title: ${set.title}
Current description: ${set.description || '(none)'}

Tasks in this set:
${taskList}`;

  const response = await genai.models.generateContent({
    model: MODEL,
    contents: [{ role: 'user', parts: [{ text: userMsg }] }],
    config: {
      systemInstruction: CLARITY_SYSTEM,
      responseMimeType: 'application/json',
      temperature: 0.2,
      maxOutputTokens: 500,
    },
  });
  const raw = (response.text || '').trim();
  if (!raw) return null;
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(cleaned); } catch { return null; }
}

export async function synthesizeProject(projectName, tasks) {
  if (!tasks || tasks.length < 2) return { clusters: [] };

  const taskList = tasks.map(t => `id=${t.id}: ${t.text}${t.context ? ` (context: ${t.context})` : ''}`).join('\n');
  const userMsg = `Project: ${projectName}\n\nPending tasks:\n${taskList}`;

  const response = await genai.models.generateContent({
    model: MODEL,
    contents: [{ role: 'user', parts: [{ text: userMsg }] }],
    config: {
      systemInstruction: SYSTEM,
      responseMimeType: 'application/json',
      temperature: 0.1,
      maxOutputTokens: 1500,
    },
  });

  const raw = (response.text || '').trim();
  if (!raw) return { clusters: [] };
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(cleaned); } catch { return { clusters: [] }; }
}
