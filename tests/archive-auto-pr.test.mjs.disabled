// auto-pr — allowlist enforcement, budget cap, selection.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOWLIST,
  checkDiffAllowlist,
  selectTopSuggestions,
  checkBudget,
  processSuggestion,
  runAutoPrNightly,
  MAX_PRS_PER_NIGHT,
  MIN_CONFIDENCE,
} from '../local/auto-pr.js';

describe('checkDiffAllowlist', () => {
  test('accepts files inside the allowlist', () => {
    const r = checkDiffAllowlist(['local/router.js', 'local/worker.js']);
    assert.equal(r.ok, true);
  });

  test('rejects files outside the allowlist', () => {
    const r = checkDiffAllowlist(['local/daemon.js', 'local/router.js']);
    assert.equal(r.ok, false);
    assert.equal(r.violations.length, 1);
    assert.equal(r.violations[0].file, 'local/daemon.js');
  });

  test('rejects denylist patterns even if otherwise allowed', () => {
    const r = checkDiffAllowlist(['cloud/server.js']);
    assert.equal(r.ok, false);
    assert.equal(r.violations[0].reason, 'deny-pattern');
  });

  test('allowlist is exactly the 7 plan files', () => {
    assert.equal(ALLOWLIST.length, 7);
  });
});

describe('selectTopSuggestions', () => {
  test('filters by effort and confidence', () => {
    const out = selectTopSuggestions([
      { rank: 1, effort_hours: 3, confidence: 0.9, description: 'too long' },
      { rank: 2, effort_hours: 1, confidence: 0.5, description: 'too low' },
      { rank: 3, effort_hours: 1, confidence: 0.8, description: 'ok' },
      { rank: 4, effort_hours: 2, confidence: 0.95, description: 'also ok' },
    ]);
    assert.equal(out.length, 2);
    assert.equal(out[0].rank, 3);
  });

  test('sorts by rank', () => {
    const out = selectTopSuggestions([
      { rank: 5, effort_hours: 1, confidence: 0.9 },
      { rank: 1, effort_hours: 1, confidence: 0.9 },
      { rank: 3, effort_hours: 1, confidence: 0.9 },
    ], 3);
    assert.deepEqual(out.map(s => s.rank), [1, 3, 5]);
  });
});

describe('checkBudget', () => {
  test('blocks at max PRs', () => {
    const r = checkBudget({ prs_opened: MAX_PRS_PER_NIGHT, cost_usd: 0 });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'max-prs-reached');
  });

  test('blocks at spend cap', () => {
    const r = checkBudget({ prs_opened: 0, cost_usd: 2.9 }, { extraCostUsd: 0.5 });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'spend-cap-reached');
  });

  test('allows when under both caps', () => {
    const r = checkBudget({ prs_opened: 0, cost_usd: 0 });
    assert.equal(r.allowed, true);
  });
});

describe('processSuggestion', () => {
  test('dry run short-circuits', async () => {
    const r = await processSuggestion(
      { target_file: 'local/router.js', description: 'tighten retry loop' },
      { dryRun: true, date: '2026-04-23' }
    );
    assert.equal(r.status, 'dry-run');
    assert.match(r.branch, /^maestro\/self-improve\//);
  });

  test('abandons on allowlist violation', async () => {
    const recs = [];
    const r = await processSuggestion(
      { target_file: 'x', description: 'bad' },
      {
        cloudApi: async (m, p, b) => { if (m === 'POST' && p === '/api/recommendations') recs.push(b); return {}; },
        runClaude: async () => '',
        runGit: async () => {},
        runTests: async () => ({ ok: true }),
        gitChangedFiles: async () => ['cloud/server.js'],
        dryRun: false, date: '2026-04-23',
      }
    );
    assert.equal(r.status, 'allowlist-violation');
    assert.equal(recs.length, 1, 'should have filed a Maestro recommendation');
  });

  test('abandons on test failure', async () => {
    const r = await processSuggestion(
      { target_file: 'router', description: 'x' },
      {
        cloudApi: async () => ({}),
        runClaude: async () => '',
        runGit: async () => {},
        runTests: async () => ({ ok: false, output: 'fail' }),
        gitChangedFiles: async () => ['local/router.js'],
        dryRun: false, date: '2026-04-23',
      }
    );
    assert.equal(r.status, 'tests-failed');
  });

  test('ready-to-pr on green path', async () => {
    const r = await processSuggestion(
      { target_file: 'router', description: 'x' },
      {
        cloudApi: async () => ({}),
        runClaude: async () => '',
        runGit: async () => {},
        runTests: async () => ({ ok: true }),
        gitChangedFiles: async () => ['local/router.js'],
        dryRun: false, date: '2026-04-23',
      }
    );
    assert.equal(r.status, 'ready-to-pr');
  });
});

describe('runAutoPrNightly', () => {
  test('no selected suggestions returns empty results', async () => {
    const cloudApi = async () => ({ summary: { self_improvements: [] } });
    const r = await runAutoPrNightly({
      cloudApi, runClaude: async () => '', runGit: async () => {},
      runTests: async () => ({ ok: true }), gitChangedFiles: async () => [],
      date: '2026-04-23', dryRun: true,
    });
    assert.equal(r.selected, 0);
  });

  test('respects budget gate', async () => {
    const cloudApi = async (method, path) => {
      if (path === '/api/self-improvement/latest') {
        return {
          summary: {
            self_improvements: [
              { rank: 1, target_file: 'router.js', description: 'x',
                effort_hours: 1, confidence: 0.9 },
            ],
          },
        };
      }
      if (path.startsWith('/api/self-improvement/budget')) {
        return { prs_opened: MAX_PRS_PER_NIGHT, cost_usd: 0 };
      }
      return {};
    };
    // Stub validator so the test doesn't call claude.
    const validator = async (s) => ({ kept: s, dropped: [] });
    const r = await runAutoPrNightly({
      cloudApi, runClaude: async () => '', runGit: async () => {},
      runTests: async () => ({ ok: true }), gitChangedFiles: async () => [],
      date: '2026-04-23', dryRun: true, validator,
    });
    assert.equal(r.blocked, 'max-prs-reached');
  });

  test('passes MIN_CONFIDENCE threshold constant', () => {
    assert.equal(MIN_CONFIDENCE, 0.75);
  });
});

describe('auto-pr with validator', () => {
  test('validator dropping all suggestions yields selected=0', async () => {
    const cloudApi = async (method, path) => {
      if (path === '/api/self-improvement/latest') {
        return {
          summary: {
            self_improvements: [
              { rank: 1, target_file: 'router.js', description: 'x',
                effort_hours: 1, confidence: 0.9 },
            ],
          },
        };
      }
      return {};
    };
    const validator = async (s) => ({
      kept: [],
      dropped: s.map(x => ({ ...x, validator: { decision: 'skip', reason: 'already done' } })),
    });
    const r = await runAutoPrNightly({
      cloudApi, runClaude: async () => '', runGit: async () => {},
      runTests: async () => ({ ok: true }), gitChangedFiles: async () => [],
      date: '2026-04-23', dryRun: true, validator,
    });
    assert.equal(r.selected, 0);
    assert.equal(r.validator_dropped, 1);
  });

  test('validator refines patch_hint; suggestion proceeds with new hint', async () => {
    let capturedPlan = null;
    const cloudApi = async (method, path) => {
      if (path === '/api/self-improvement/latest') {
        return {
          summary: {
            self_improvements: [
              { rank: 1, target_file: 'router.js', description: 'x',
                patch_hint: 'old hint', effort_hours: 1, confidence: 0.9 },
            ],
          },
        };
      }
      if (path.startsWith('/api/self-improvement/budget')) return { prs_opened: 0, cost_usd: 0 };
      return {};
    };
    const validator = async (s) => ({
      kept: s.map(x => ({ ...x, patch_hint: 'REFINED HINT', validator: { decision: 'refine' } })),
      dropped: [],
    });
    const r = await runAutoPrNightly({
      cloudApi, runClaude: async () => '', runGit: async () => {},
      runTests: async () => ({ ok: true }), gitChangedFiles: async () => [],
      date: '2026-04-23', dryRun: true, validator,
    });
    assert.equal(r.results.length, 1);
    assert.equal(r.results[0].plan.patch_hint, 'REFINED HINT');
  });
});
