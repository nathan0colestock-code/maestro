// Spawn the UserPromptSubmit hook as a subprocess against our test cloud.
// Verify: (a) injects additionalContext when tasks pending, (b) silent when
// none, (c) silent on network error, (d) silent on bad stdin.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { bootCloud } from './helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = join(__dirname, '..', 'local', 'hooks', 'user-prompt-submit.js');

function runHook({ stdin, env }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK_PATH], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    child.stdout.on('data', d => out += d.toString());
    child.stderr.on('data', d => err += d.toString());
    child.on('close', code => resolve({ code, stdout: out, stderr: err }));
    if (stdin !== null && stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
  });
}

describe('UserPromptSubmit hook', () => {
  let cloud;
  before(async () => { cloud = await bootCloud(); });
  after(async () => { await cloud.close(); });

  test('emits additionalContext when project has pending tasks', async () => {
    await cloud.req('POST', '/api/tasks', {
      project_name: 'hookproj',
      text: 'add a logout button',
      context: 'needed for session safety',
    });

    const result = await runHook({
      stdin: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'hi', cwd: '/some/path/hookproj' }),
      env: { MAESTRO_CLOUD_URL: cloud.baseUrl, MAESTRO_SECRET: cloud.secret },
    });

    assert.equal(result.code, 0);
    assert.ok(result.stdout, 'hook must emit JSON when tasks exist');
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(payload.hookSpecificOutput.additionalContext, /Maestro/);
    assert.match(payload.hookSpecificOutput.additionalContext, /add a logout button/);
    assert.match(payload.hookSpecificOutput.additionalContext, /needed for session safety/);
  });

  test('marks tasks delivered so second call emits nothing', async () => {
    const result = await runHook({
      stdin: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'hi', cwd: '/some/path/hookproj' }),
      env: { MAESTRO_CLOUD_URL: cloud.baseUrl, MAESTRO_SECRET: cloud.secret },
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '', 'second hook call should emit nothing after tasks marked delivered');
  });

  test('silent when project has no tasks', async () => {
    const result = await runHook({
      stdin: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'hi', cwd: '/nonexistent-project' }),
      env: { MAESTRO_CLOUD_URL: cloud.baseUrl, MAESTRO_SECRET: cloud.secret },
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '');
  });

  test('silent on malformed stdin (never blocks prompt)', async () => {
    const result = await runHook({
      stdin: 'not-json garbage',
      env: { MAESTRO_CLOUD_URL: cloud.baseUrl, MAESTRO_SECRET: cloud.secret },
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '');
  });

  test('silent when cloud is unreachable (does not block user)', async () => {
    const result = await runHook({
      stdin: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'hi', cwd: '/some/path/foxed' }),
      env: { MAESTRO_CLOUD_URL: 'http://127.0.0.1:1', MAESTRO_SECRET: cloud.secret },
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '');
  });
});
