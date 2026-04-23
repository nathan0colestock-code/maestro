// Tests for doc-updater.js — file writes to tasks.md and CLAUDE.md.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { appendTask, appendNote, appendDocNote } from '../local/doc-updater.js';

describe('doc-updater', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'maestro-doc-')); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

  test('appendTask creates tasks.md if missing, with heading', async () => {
    await appendTask(dir, 'first task', 'context here');
    const content = readFileSync(join(dir, 'tasks.md'), 'utf8');
    assert.match(content, /^# Tasks/);
    assert.match(content, /- \[ \] first task/);
    assert.match(content, /> context here/);
  });

  test('appendTask appends under existing heading without destroying old tasks', async () => {
    writeFileSync(join(dir, 'tasks.md'), '# Tasks\n\n- [ ] existing task\n');
    await appendTask(dir, 'new task');
    const content = readFileSync(join(dir, 'tasks.md'), 'utf8');
    assert.match(content, /- \[ \] existing task/, 'existing task must survive');
    assert.match(content, /- \[ \] new task/);
  });

  test('appendNote creates CLAUDE.md with Context Notes section', async () => {
    await appendNote(dir, 'observed something');
    const content = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    assert.match(content, /## Context Notes/);
    assert.match(content, /observed something/);
  });

  test('appendNote inserts under existing Context Notes section', async () => {
    writeFileSync(join(dir, 'CLAUDE.md'), '# Proj\n\n## Context Notes\n\n- [old] old note\n');
    await appendNote(dir, 'new note');
    const content = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    assert.match(content, /old note/);
    assert.match(content, /new note/);
  });

  test('appendDocNote appends to CLAUDE.md with DOC prefix', async () => {
    await appendDocNote(dir, 'updated the spec');
    const content = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    assert.match(content, /DOC: updated the spec/);
  });
});
