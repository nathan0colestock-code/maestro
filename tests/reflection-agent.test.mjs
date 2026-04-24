// reflection-agent — summarizeTranscript + end-to-end with mocked claude.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  summarizeTranscript,
  gatherInputs,
  runReflection,
  runNightlyReflection,
} from '../local/reflection-agent.js';

describe('summarizeTranscript', () => {
  test('returns zeroes for unknown session', () => {
    const s = summarizeTranscript('nope', '/tmp/doesnt-exist-' + Date.now());
    assert.deepEqual(s, {
      tool_call_count: 0, files_read: 0, files_edited: 0,
      tests_run: 0, retries: 0, backtracks: 0,
    });
  });

  test('counts tool calls from jsonl lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'transcripts-'));
    try {
      const lines = [
        JSON.stringify({ toolName: 'Read' }),
        JSON.stringify({ toolName: 'Edit' }),
        JSON.stringify({ toolName: 'Bash', message: { content: [{ text: 'npm test' }] } }),
        JSON.stringify({ toolName: 'Bash', message: { content: [{ text: 'retry error' }] } }),
      ].join('\n');
      writeFileSync(join(dir, 'abc123.jsonl'), lines);
      const s = summarizeTranscript('abc123', dir);
      assert.equal(s.tool_call_count, 4);
      assert.equal(s.files_read, 1);
      assert.equal(s.files_edited, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('gatherInputs', () => {
  test('aggregates token + cost totals', async () => {
    const cloudApi = async (method, path) => {
      if (path.includes('reflect/observations')) {
        return {
          worker_runs: [
            { tokens_in: 100, tokens_out: 50, cost_usd: 0.1 },
            { tokens_in: 200, tokens_out: 80, cost_usd: 0.2 },
          ],
          feature_sets: [{ id: 1 }],
          routing_feedback: [],
        };
      }
      if (path.startsWith('/api/suite-logs')) return [{ app: 'gloss', level: 'warn' }];
      return {};
    };
    const out = await gatherInputs({ cloudApi });
    assert.equal(out.totals.tokens_in, 300);
    assert.equal(out.totals.tokens_out, 130);
    assert.ok(Math.abs(out.totals.cost_usd - 0.3) < 1e-9);
    assert.equal(out.suite_log_warnings.length, 1);
  });
});

describe('runReflection', () => {
  test('parses json and strips fences', async () => {
    const runClaude = async () => '```json\n{"wins":["a"],"struggles":[],"self_improvements":[],"metric_summary":{"tokens":0,"cost_usd":0,"phase_p95_ms":0,"regression_flags":[]}}\n```';
    const out = await runReflection({ inputs: {}, runClaude });
    assert.deepEqual(out.wins, ['a']);
  });

  test('propagates JSON parse errors clearly', async () => {
    const runClaude = async () => 'not-json';
    await assert.rejects(runReflection({ inputs: {}, runClaude }));
  });
});

describe('runNightlyReflection end-to-end', () => {
  test('gathers → runs → posts', async () => {
    const posted = [];
    const cloudApi = async (method, path, body) => {
      if (method === 'POST' && path === '/api/self-improvement') {
        posted.push(body);
        return { ok: true };
      }
      if (path.includes('reflect/observations')) return { worker_runs: [] };
      if (path.startsWith('/api/suite-logs')) return [];
      return {};
    };
    const runClaude = async () => JSON.stringify({
      wins: ['w1'],
      struggles: [],
      self_improvements: [],
      metric_summary: { tokens: 0, cost_usd: 0, phase_p95_ms: 0, regression_flags: [] },
    });
    const r = await runNightlyReflection({ cloudApi, runClaude, date: '2026-04-23' });
    assert.equal(r.ok, true);
    assert.equal(r.date, '2026-04-23');
    assert.equal(posted.length, 1);
    assert.deepEqual(posted[0].summary.wins, ['w1']);
  });
});
