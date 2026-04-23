import { readFile, writeFile, access } from 'fs/promises';
import { join } from 'path';
import lockfile from 'proper-lockfile';

async function fileExists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function readOptional(p) {
  try { return await readFile(p, 'utf8'); } catch { return ''; }
}

function timestamp() {
  return new Date().toISOString().slice(0, 16).replace('T', ' ');
}

// Serialize read-modify-write on a file to avoid losing appends when the
// daemon drain loop and an active Claude Code session both edit tasks.md or
// CLAUDE.md in quick succession. proper-lockfile creates a sibling .lock dir
// and releases on process exit.
async function withLock(path, fn) {
  let release;
  try {
    release = await lockfile.lock(path, {
      retries: { retries: 10, minTimeout: 50, maxTimeout: 500 },
      realpath: false,
      stale: 10_000,
    });
    return await fn();
  } finally {
    if (release) { try { await release(); } catch { /* already released */ } }
  }
}

// Append a task to <project>/tasks.md
export async function appendTask(projectPath, text, context) {
  const tasksPath = join(projectPath, 'tasks.md');

  const entry = context
    ? `- [ ] ${text}\n  > ${context}\n`
    : `- [ ] ${text}\n`;

  if (!(await fileExists(tasksPath))) {
    await writeFile(tasksPath, `# Tasks\n\n${entry}`);
  }

  await withLock(tasksPath, async () => {
    const content = await readFile(tasksPath, 'utf8');
    const headingEnd = content.indexOf('\n') + 1;
    const before = content.slice(0, headingEnd);
    const after = content.slice(headingEnd);
    await writeFile(tasksPath, `${before}\n${entry}${after}`);
  });
}

// Append a context note to <project>/CLAUDE.md under ## Context Notes
export async function appendNote(projectPath, text) {
  const claudePath = join(projectPath, 'CLAUDE.md');
  const entry = `- [${timestamp()}] ${text}`;

  if (!(await fileExists(claudePath))) {
    await writeFile(claudePath, `# Project Context\n\n## Context Notes\n\n${entry}\n`);
    return;
  }

  await withLock(claudePath, async () => {
    let content = await readFile(claudePath, 'utf8');
    if (content.includes('## Context Notes')) {
      const idx = content.indexOf('## Context Notes') + '## Context Notes'.length;
      content = content.slice(0, idx) + '\n\n' + entry + content.slice(idx);
    } else {
      content += `\n\n## Context Notes\n\n${entry}\n`;
    }
    await writeFile(claudePath, content);
  });
}

// Append a doc update note to CLAUDE.md (non-destructive — just adds a note)
export async function appendDocNote(projectPath, text) {
  const claudePath = join(projectPath, 'CLAUDE.md');
  const entry = `- [${timestamp()}] DOC: ${text}`;

  if (!(await fileExists(claudePath))) {
    await writeFile(claudePath, `# Project Context\n\n## Context Notes\n\n${entry}\n`);
    return;
  }

  await withLock(claudePath, async () => {
    const content = await readFile(claudePath, 'utf8');
    await writeFile(claudePath, `${content}\n${entry}\n`);
  });
}
