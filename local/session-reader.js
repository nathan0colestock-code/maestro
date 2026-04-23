import { readdir, readFile, stat } from 'fs/promises';
import { join } from 'path';

const CLAUDE_PROJECTS_DIR = '/Users/nathancolestock/.claude/projects';
const ACTIVE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

// Decode ~/.claude/projects dir name back to a file path
// e.g. "-Users-nathancolestock-flock" → "/Users/nathancolestock/flock"
function decodeDirName(name) {
  return name.replace(/-/g, '/');
}

function projectNameFromPath(path) {
  return path.split('/').pop();
}

async function readLastLines(filePath, n = 10) {
  try {
    const content = await readFile(filePath, 'utf8');
    const lines = content.trim().split('\n');
    return lines.slice(-n);
  } catch { return []; }
}

async function getSubagentType(projectDir) {
  try {
    const subagentsDir = join(projectDir, 'subagents');
    const entries = await readdir(subagentsDir);
    const metaFiles = entries.filter(e => e.endsWith('.meta.json'));
    if (!metaFiles.length) return null;
    // Most recently modified meta file
    let latest = null, latestTime = 0;
    for (const f of metaFiles) {
      const s = await stat(join(subagentsDir, f));
      if (s.mtimeMs > latestTime) { latestTime = s.mtimeMs; latest = f; }
    }
    if (!latest) return null;
    const meta = JSON.parse(await readFile(join(subagentsDir, latest), 'utf8'));
    return meta.subagentType || meta.type || null;
  } catch { return null; }
}

function parseLastAction(lines) {
  // JSONL lines contain operation objects — extract a human-readable summary
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      const tool = entry.toolName || entry.tool || entry.type;
      const input = entry.toolInput || entry.input || {};
      if (tool === 'Read' && input.file_path) return `reading ${input.file_path.split('/').slice(-2).join('/')}`;
      if (tool === 'Edit' && input.file_path) return `editing ${input.file_path.split('/').slice(-2).join('/')}`;
      if (tool === 'Write' && input.file_path) return `writing ${input.file_path.split('/').slice(-2).join('/')}`;
      if (tool === 'Bash' && input.command) return `running: ${input.command.slice(0, 60)}`;
      if (tool === 'Grep') return `searching codebase`;
      if (tool === 'Glob') return `scanning files`;
      if (tool) return `using ${tool}`;
    } catch { /* not valid JSON, skip */ }
  }
  return 'unknown';
}

export async function readSessions() {
  const results = [];

  let projectDirs;
  try {
    projectDirs = await readdir(CLAUDE_PROJECTS_DIR);
  } catch { return []; }

  for (const dirName of projectDirs) {
    const projectPath = decodeDirName(dirName);
    const projectName = projectNameFromPath(projectPath);
    const projectDir = join(CLAUDE_PROJECTS_DIR, dirName);

    // Find .jsonl session files
    let files;
    try {
      files = await readdir(projectDir);
    } catch { continue; }

    const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));
    if (!jsonlFiles.length) continue;

    // Find most recently modified .jsonl
    let latestFile = null, latestMtime = 0;
    for (const f of jsonlFiles) {
      try {
        const s = await stat(join(projectDir, f));
        if (s.mtimeMs > latestMtime) { latestMtime = s.mtimeMs; latestFile = f; }
      } catch { /* skip */ }
    }
    if (!latestFile) continue;

    const now = Date.now();
    const isActive = (now - latestMtime) < ACTIVE_THRESHOLD_MS;
    const lastActive = new Date(latestMtime).toISOString();

    const lines = await readLastLines(join(projectDir, latestFile));
    const lastAction = parseLastAction(lines);
    const agentType = await getSubagentType(projectDir);

    results.push({
      project_name: projectName,
      session_file: latestFile,
      is_active: isActive ? 1 : 0,
      last_active: lastActive,
      last_action: lastAction,
      agent_type: agentType,
    });
  }

  return results;
}
