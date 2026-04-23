import { readFile, writeFile, access } from 'fs/promises';
import { join } from 'path';

async function fileExists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function readOptional(p) {
  try { return await readFile(p, 'utf8'); } catch { return ''; }
}

function timestamp() {
  return new Date().toISOString().slice(0, 16).replace('T', ' ');
}

// Append a task to <project>/tasks.md
export async function appendTask(projectPath, text, context) {
  const tasksPath = join(projectPath, 'tasks.md');
  const exists = await fileExists(tasksPath);

  const entry = context
    ? `- [ ] ${text}\n  > ${context}\n`
    : `- [ ] ${text}\n`;

  if (!exists) {
    await writeFile(tasksPath, `# Tasks\n\n${entry}`);
  } else {
    const content = await readFile(tasksPath, 'utf8');
    // Insert after the first heading line, or prepend
    const headingEnd = content.indexOf('\n') + 1;
    const before = content.slice(0, headingEnd);
    const after = content.slice(headingEnd);
    await writeFile(tasksPath, `${before}\n${entry}${after}`);
  }
}

// Append a context note to <project>/CLAUDE.md under ## Context Notes
export async function appendNote(projectPath, text) {
  const claudePath = join(projectPath, 'CLAUDE.md');
  const exists = await fileExists(claudePath);
  const entry = `- [${timestamp()}] ${text}`;

  if (!exists) {
    await writeFile(claudePath, `# Project Context\n\n## Context Notes\n\n${entry}\n`);
    return;
  }

  let content = await readFile(claudePath, 'utf8');

  if (content.includes('## Context Notes')) {
    const idx = content.indexOf('## Context Notes') + '## Context Notes'.length;
    content = content.slice(0, idx) + '\n\n' + entry + content.slice(idx);
  } else {
    content += `\n\n## Context Notes\n\n${entry}\n`;
  }

  await writeFile(claudePath, content);
}

// Append a doc update note to CLAUDE.md (non-destructive — just adds a note)
export async function appendDocNote(projectPath, text) {
  const claudePath = join(projectPath, 'CLAUDE.md');
  const exists = await fileExists(claudePath);
  const entry = `- [${timestamp()}] DOC: ${text}`;

  if (!exists) {
    await writeFile(claudePath, `# Project Context\n\n## Context Notes\n\n${entry}\n`);
    return;
  }

  let content = await readFile(claudePath, 'utf8');
  content += `\n${entry}\n`;
  await writeFile(claudePath, content);
}
