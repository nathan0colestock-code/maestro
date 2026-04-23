import { readFile, access } from 'fs/promises';
import { join } from 'path';
import { execSync } from 'child_process';

// Projects to track — extend this list as you add more apps
const PROJECTS = [
  { name: 'flock', path: '/Users/nathancolestock/flock' },
  { name: 'gloss', path: '/Users/nathancolestock/gloss' },
  { name: 'tend', path: '/Users/nathancolestock/tend' },
  { name: 'comms', path: '/Users/nathancolestock/comms' },
  { name: 'maestro', path: '/Users/nathancolestock/maestro' },
  { name: 'scribe', path: '/Users/nathancolestock/scribe' },
  { name: 'black', path: '/Users/nathancolestock/black' },
];

async function fileExists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function readOptional(p) {
  try { return await readFile(p, 'utf8'); } catch { return ''; }
}

function gitLog(cwd) {
  try {
    return execSync('git log --oneline -10', { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}

function gitDiffStat(cwd) {
  try {
    return execSync('git diff --stat HEAD~3..HEAD', { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}

function countOpenTasks(tasksContent) {
  if (!tasksContent) return 0;
  return (tasksContent.match(/^- \[ \]/gm) || []).length;
}

export async function scanProjects() {
  const results = [];

  for (const project of PROJECTS) {
    const exists = await fileExists(project.path);
    if (!exists) continue;

    const claudeMd = await readOptional(join(project.path, 'CLAUDE.md'));
    const tasksMd = await readOptional(join(project.path, 'tasks.md'));
    const log = gitLog(project.path);
    const diff = gitDiffStat(project.path);

    // Extract description and goals from CLAUDE.md (first 500 chars is usually enough)
    const description = extractSection(claudeMd, ['## Overview', '## Context', '## What', '# ']) || claudeMd.slice(0, 300);
    const goals = extractSection(claudeMd, ['## Goals', '## Current Goal', '## Current Focus', '## TODO']);
    const currentFocus = extractSection(claudeMd, ['## Current Focus', '## Active Work', '## In Progress']);

    results.push({
      name: project.name,
      path: project.path,
      description: description.trim().slice(0, 400),
      goals: goals.trim().slice(0, 300),
      current_focus: currentFocus.trim().slice(0, 200),
      open_task_count: countOpenTasks(tasksMd),
      last_commit: log.split('\n')[0] || '',
      recent_log: log,
      recent_diff: diff.slice(0, 300),
    });
  }

  return results;
}

function extractSection(content, headings) {
  for (const heading of headings) {
    const idx = content.indexOf(heading);
    if (idx === -1) continue;
    const start = idx + heading.length;
    // Find next ## heading
    const nextHeading = content.indexOf('\n## ', start);
    const end = nextHeading === -1 ? Math.min(start + 500, content.length) : nextHeading;
    return content.slice(start, end).trim();
  }
  return '';
}
