// Lightweight GitHub enrichment for the router and feature-set pipeline.
//
// The router uses parseRefs() to extract "fixes #123", "closes org/repo#456",
// etc. from a capture, then enrichRefs() hits the GitHub API to fetch PR
// status, issue state, and labels. This lets routing decisions reflect
// whether a referenced issue is already closed / in-review / blocked,
// instead of treating every capture as independent work.
//
// Token: GITHUB_TOKEN (fine-grained, issues+PR read scope). If unset we
// still parse refs but return best-effort stubs — the router can still
// inject raw refs as context.

import { PROJECTS } from './project-scanner.js';

const TOKEN = process.env.GITHUB_TOKEN || null;

// Defaults to the first path-component of the repo; customize if your
// projects live under a different org.
const DEFAULT_OWNER = process.env.GITHUB_DEFAULT_OWNER || 'your-github-org';

// project name → "owner/repo" override. Falls back to `${DEFAULT_OWNER}/${name}`.
const PROJECT_REPOS = Object.fromEntries(
  PROJECTS.map(p => [p.name, process.env[`GITHUB_REPO_${p.name.toUpperCase()}`] || `${DEFAULT_OWNER}/${p.name}`])
);

// Extract issue/PR references. Accepts:
//   #123              → { owner, repo, number } (owner/repo from project)
//   org/repo#123      → explicit
//   fixes/closes/resolves prefixes are tolerated and case-insensitive.
export function parseRefs(text, defaultProjectName = null) {
  if (!text || typeof text !== 'string') return [];
  const defaultRepo = defaultProjectName ? PROJECT_REPOS[defaultProjectName] : null;
  const refs = [];
  const seen = new Set();
  const re = /(?:(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?)\s+)?(?:([\w.-]+)\/([\w.-]+))?#(\d+)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const owner = m[1] || defaultRepo?.split('/')?.[0];
    const repo  = m[2] || defaultRepo?.split('/')?.[1];
    const number = Number(m[3]);
    if (!owner || !repo || !number) continue;
    const key = `${owner}/${repo}#${number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ owner, repo, number, raw: m[0] });
  }
  return refs;
}

async function ghFetch(path) {
  const headers = { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;
  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GH ${path} → ${res.status}`);
  return res.json();
}

// Fetch state/labels/title for each ref. GitHub's /issues/:num endpoint
// returns both issues and PRs (with a `pull_request` field on PRs), so one
// call suffices for either kind.
export async function enrichRefs(refs) {
  const out = [];
  for (const ref of refs) {
    try {
      const data = await ghFetch(`/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`);
      if (!data) { out.push({ ...ref, state: 'not_found' }); continue; }
      const isPR = !!data.pull_request;
      out.push({
        ...ref,
        kind: isPR ? 'pr' : 'issue',
        state: data.state,                              // 'open' | 'closed'
        state_reason: data.state_reason || null,        // 'completed' | 'not_planned' | null
        title: data.title,
        labels: (data.labels || []).map(l => l.name || l),
        merged_at: isPR ? (data.pull_request?.merged_at || null) : null,
        url: data.html_url,
      });
    } catch (err) {
      out.push({ ...ref, error: err.message });
    }
  }
  return out;
}

export function projectRepo(projectName) {
  return PROJECT_REPOS[projectName] || null;
}

export function isEnabled() {
  return !!TOKEN;
}
