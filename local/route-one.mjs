// One-shot: route exactly ONE pending capture and print the plan + results.
// Usage: node local/route-one.mjs <capture_id>
import { scanProjects } from './project-scanner.js';
import { readSessions } from './session-reader.js';
import { routeCapture } from './router.js';
import { executeRoutingPlan } from './executor.js';

const CAPTURE_ID = Number(process.argv[2]);
if (!CAPTURE_ID) { console.error('usage: route-one.mjs <capture_id>'); process.exit(1); }

const CLOUD_URL = process.env.MAESTRO_CLOUD_URL;
const SECRET = process.env.MAESTRO_SECRET;
const H = { 'Content-Type': 'application/json', 'X-Maestro-Secret': SECRET };

async function api(method, path, body) {
  const res = await fetch(`${CLOUD_URL}${path}`, {
    method, headers: H, body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

const queue = await api('GET', '/api/queue');
const cap = queue.find(c => c.id === CAPTURE_ID);
if (!cap) { console.error(`capture ${CAPTURE_ID} not in pending queue`); process.exit(2); }

console.log(`\n── CAPTURE #${cap.id} ──────────────────────────────`);
console.log(cap.text);
console.log('');

console.log('── SCANNING PROJECTS + SESSIONS ───────────────────');
const projects = await scanProjects();
const sessions = await readSessions();
console.log(`scanned ${projects.length} projects, ${sessions.length} session records\n`);

const openSetsResp = await api('GET', '/api/feature-sets');
const openSets = openSetsResp
  .filter(s => s.status === 'collecting' || s.status === 'queued')
  .map(s => ({ id: s.id, project_name: s.project_name, title: s.title, description: s.description, task_count: (s.tasks || []).length }));
console.log(`${openSets.length} open feature set(s) for merging\n`);

console.log('── ROUTING (Gemini) ───────────────────────────────');
const t0 = Date.now();
const plan = await routeCapture(cap.text, projects, sessions, openSets);
console.log(`routed in ${Date.now() - t0}ms\n`);
console.log(JSON.stringify(plan, null, 2));
console.log('');

console.log('── EXECUTING PLAN ─────────────────────────────────');
const sessionsByProject = Object.fromEntries(sessions.map(s => [s.project_name, s]));
const results = await executeRoutingPlan(plan, cap.id, { cloudApi: api, sessionsByProject });
console.log(JSON.stringify(results, null, 2));
console.log('');

await api('POST', `/api/queue/${cap.id}/ack`, { routing_json: { plan, results } });
console.log(`ack'd capture ${cap.id}`);
