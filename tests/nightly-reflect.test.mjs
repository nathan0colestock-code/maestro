// Unit tests for the nightly self-reflection loop. We stub cloudApi and the
// Gemini generate call so tests are deterministic and never hit real services.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { resolve } from 'path';

// We need to redirect LESSONS.md + reports to a temp dir for test isolation.
// The module resolves paths relative to its own location, so we test by
// importing into a sandbox project-root via env var indirection would be
// overkill — instead we verify the exported pure pieces (summarize, reflect)
// and hit runNightlyReflection with a stubbed cloudApi + file-capture.

import {
  summarizeObservations,
  reflectOnNight,
  runNightlyReflection,
  alreadyReflectedToday,
  appendLessons,
  _test,
} from '../local/nightly-reflect.js';

describe('summarizeObservations', () => {
  test('renders empty sections compactly', () => {
    const out = summarizeObservations({
      feature_sets: [], worker_runs: [], questions: [], captures: [], synthesis_log: [],
    });
    assert.match(out, /Feature sets \(0\)/);
    assert.match(out, /Worker runs \(0\)/);
    assert.doesNotMatch(out, /Worker questions/);
  });

  test('includes feature-set peers, timings, notes', () => {
    const out = summarizeObservations({
      feature_sets: [{
        id: 3, status: 'running', project_name: 'flock', title: 'Suite remove switcher',
        extra_projects: ['gloss', 'tend'], phase_timings: { merge: 1200 },
        note: 'deploy hung for 3 min', deploy_status: 'reverted',
      }],
      worker_runs: [], questions: [], captures: [], synthesis_log: [],
    });
    assert.match(out, /#3 \[running\] flock \+peers\[gloss,tend\]/);
    assert.match(out, /deploy=reverted/);
    assert.match(out, /timings=/);
    assert.match(out, /note="deploy hung for 3 min"/);
  });

  test('truncates long summaries and notes', () => {
    const long = 'x'.repeat(500);
    const out = summarizeObservations({
      feature_sets: [{ id: 1, status: 'failed', project_name: 'gloss', title: 't', note: long }],
      worker_runs: [{ run_id: 'aaaaaaaa-1', project_name: 'gloss', status: 'error', summary: long }],
      questions: [], captures: [], synthesis_log: [],
    });
    // 200-char cap on notes + summaries
    assert.ok(!out.includes('x'.repeat(201)), 'should cap to 200 chars');
  });
});

describe('reflectOnNight', () => {
  test('parses a valid JSON response from the model', async () => {
    const fakeResponse = {
      text: JSON.stringify({
        summary_markdown: 'Tonight 3 sets shipped, 1 reverted.',
        top_pattern: 'deploy revert on cold-cache',
        improvement_capture: { text: 'Add cache warming to deploy', rationale: 'cuts revert' },
        lessons: [
          { topic: 'pipeline', lesson: 'Warm caches before flipping traffic.' },
        ],
      }),
    };
    const generate = async () => fakeResponse;
    const result = await reflectOnNight(
      { window_hours: 12, generated_at: '2026-04-23T23:00:00Z', feature_sets: [], worker_runs: [] },
      { generate },
    );
    assert.equal(result.top_pattern, 'deploy revert on cold-cache');
    assert.equal(result.lessons.length, 1);
    assert.equal(result.improvement_capture.text, 'Add cache warming to deploy');
  });

  test('strips code-fence wrappers the model sometimes emits', async () => {
    const generate = async () => ({ text: '```json\n{"summary_markdown":"ok","top_pattern":"p","improvement_capture":{"text":"t","rationale":"r"},"lessons":[]}\n```' });
    const result = await reflectOnNight(
      { window_hours: 12, generated_at: 'x', feature_sets: [], worker_runs: [] },
      { generate },
    );
    assert.equal(result.top_pattern, 'p');
  });

  test('throws on empty response', async () => {
    const generate = async () => ({ text: '' });
    await assert.rejects(
      reflectOnNight({ window_hours: 12, generated_at: 'x', feature_sets: [], worker_runs: [] }, { generate }),
      /empty response/,
    );
  });
});

describe('runNightlyReflection', () => {
  test('skips when LESSONS.md already has today\'s sentinel', async () => {
    // The reflector reads LESSONS.md at the repo root — we can't easily
    // redirect that without deeper refactoring. Instead, drive the test
    // through the public API: append a sentinel for today, then verify the
    // function returns the skip marker without invoking the model.
    const today = _test.todayISO();
    // Temporarily write a sentinel. Clean up after.
    const lessonsPath = resolve(new URL('../LESSONS.md', import.meta.url).pathname);
    let prior = null;
    try { prior = await readFile(lessonsPath, 'utf8'); } catch {}
    const hadSentinel = prior != null && prior.includes(`\n## ${today}\n`);
    try {
      if (!hadSentinel) {
        await writeFile(lessonsPath, `${prior ?? ''}\n## ${today}\n- [test] temporary sentinel\n`, 'utf8');
      }
      let calls = 0;
      const cloudApi = async () => { calls++; return {}; };
      const generate = async () => { throw new Error('should not be called'); };
      const result = await runNightlyReflection(cloudApi, { generate });
      assert.equal(result.skipped, 'already_reflected_today');
      assert.equal(calls, 0, 'cloudApi must not be called when skipping');
    } finally {
      // Restore original LESSONS.md so the test is idempotent.
      if (!hadSentinel) {
        if (prior != null) {
          try { await writeFile(lessonsPath, prior, 'utf8'); } catch {}
        } else {
          await rm(lessonsPath, { force: true });
        }
      }
    }
  });

  test('force=true runs even when today is already reflected', async () => {
    const today = _test.todayISO();
    const lessonsPath = resolve(new URL('../LESSONS.md', import.meta.url).pathname);
    let prior = null;
    try { prior = await readFile(lessonsPath, 'utf8'); } catch {}
    try {
      await writeFile(lessonsPath, `${prior ?? ''}\n## ${today}\n- [test] sentinel\n`, 'utf8');
      const cloudApi = async (method, path) => {
        if (path.startsWith('/api/reflect/observations')) {
          return {
            window_hours: 12, generated_at: new Date().toISOString(),
            feature_sets: [], worker_runs: [], questions: [], captures: [], synthesis_log: [],
          };
        }
        if (method === 'POST' && path === '/api/capture') return { id: 42 };
        return {};
      };
      const generate = async () => ({
        text: JSON.stringify({
          summary_markdown: 'forced-run', top_pattern: 'p',
          improvement_capture: { text: 'improve', rationale: 'r' },
          lessons: [{ topic: 'general', lesson: 'tests can force reflection' }],
        }),
      });
      const result = await runNightlyReflection(cloudApi, { generate, force: true });
      assert.equal(result.top_pattern, 'p');
      assert.equal(result.capture_id, 42);
      assert.equal(result.lessons_count, 1);
    } finally {
      if (prior != null) {
        try { await writeFile(lessonsPath, prior, 'utf8'); } catch {}
      } else {
        await rm(lessonsPath, { force: true });
      }
    }
  });
});
