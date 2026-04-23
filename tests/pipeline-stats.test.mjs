import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  getProjectStats,
  detectRegression,
  _aggregateFromRows,
  _clearCache,
} from '../local/pipeline-stats.js';

// Seed helper — build feature_sets rows shaped like what the cloud endpoint
// returns. Each row has a phase_timings JSON string.
function row(timings) {
  return { phase_timings: JSON.stringify(timings) };
}

function phase(name, duration_ms, status = 'ok') {
  return { phase: name, started_at: '2026-04-23T00:00:00Z', ended_at: '2026-04-23T00:00:01Z', duration_ms, status };
}

describe('pipeline-stats.getProjectStats', () => {
  test('returns correct p50 / p95 / mean / stddev / failure_rate', async () => {
    _clearCache();
    // 10 pre-merge-tests durations, sorted for easy verification:
    // 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000 ms
    // mean = 5500, stddev ≈ 2872.28
    // p50 (linear interp) = 5500
    // p95 = 9550
    // 2 failures → failure_rate = 0.2
    const durations = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000];
    const rows = durations.map((d, i) =>
      row([phase('pre-merge-tests', d, i < 2 ? 'failed' : 'ok')])
    );
    const stats = await getProjectStats('seed', {
      lookback_days: 7,
      fetchFn: async () => ({ rows }),
    });
    const p = stats['pre-merge-tests'];
    assert.equal(p.n, 10);
    assert.ok(Math.abs(p.p50 - 5500) < 0.01, `p50 ${p.p50} not ≈ 5500`);
    assert.ok(Math.abs(p.p95 - 9550) < 0.01, `p95 ${p.p95} not ≈ 9550`);
    assert.equal(p.mean, 5500);
    assert.ok(Math.abs(p.stddev - 2872.28) < 1, `stddev ${p.stddev} not ≈ 2872.28`);
    assert.equal(p.failure_rate, 0.2);
  });

  test('empty history returns nulls per phase', async () => {
    _clearCache();
    const stats = await getProjectStats('empty', {
      lookback_days: 7,
      fetchFn: async () => ({ rows: [] }),
    });
    assert.deepEqual(stats, {});
  });

  test('single-datapoint history returns that value for all percentiles', async () => {
    _clearCache();
    const stats = await getProjectStats('one', {
      lookback_days: 7,
      fetchFn: async () => ({ rows: [row([phase('deploy', 5000)])] }),
    });
    assert.equal(stats['deploy'].n, 1);
    assert.equal(stats['deploy'].p50, 5000);
    assert.equal(stats['deploy'].p95, 5000);
    assert.equal(stats['deploy'].mean, 5000);
    assert.equal(stats['deploy'].stddev, 0);
    assert.equal(stats['deploy'].failure_rate, 0);
  });

  test('groups multi-phase timings correctly', async () => {
    _clearCache();
    const rows = [
      row([phase('pre-merge-tests', 1000), phase('merge', 500), phase('deploy', 3000)]),
      row([phase('pre-merge-tests', 2000), phase('merge', 600), phase('deploy', 4000)]),
    ];
    const stats = await getProjectStats('multi', {
      lookback_days: 7,
      fetchFn: async () => ({ rows }),
    });
    assert.equal(stats['pre-merge-tests'].n, 2);
    assert.equal(stats['merge'].n, 2);
    assert.equal(stats['deploy'].n, 2);
    assert.equal(stats['merge'].mean, 550);
  });

  test('_aggregateFromRows handles malformed JSON gracefully', () => {
    const stats = _aggregateFromRows([
      { phase_timings: '{"not an array"}' },
      { phase_timings: '[]' },
      { phase_timings: null },
      row([phase('merge', 500)]),
    ]);
    assert.equal(stats['merge'].n, 1);
  });
});

describe('pipeline-stats.detectRegression', () => {
  // n=10, all durations 1000ms so mean=1000 stddev=0 — with stddev 0 we never flag.
  // Use a distribution that has some spread.
  const stats = _aggregateFromRows(
    // Ten runs: mean ≈ 1000, stddev ≈ 100
    [900, 950, 980, 990, 1000, 1010, 1020, 1050, 1100, 1000].map(d =>
      row([phase('pre-merge-tests', d)])
    )
  );

  test('does not flag values within 2σ (1.5σ spec)', () => {
    const mean = stats['pre-merge-tests'].mean;
    const stddev = stats['pre-merge-tests'].stddev;
    const within = mean + 1.5 * stddev;
    const r = detectRegression('pre-merge-tests', within, stats);
    assert.equal(r.is_regression, false);
  });

  test('flags values beyond 2σ (3σ test — well clear of threshold)', () => {
    const mean = stats['pre-merge-tests'].mean;
    const stddev = stats['pre-merge-tests'].stddev;
    const beyond = mean + 3 * stddev;
    const r = detectRegression('pre-merge-tests', beyond, stats);
    assert.equal(r.is_regression, true);
    assert.ok(r.magnitude > 1);
    assert.match(r.note, /pre-merge-tests/);
    assert.match(r.note, /slower than usual/);
  });

  test('never flags when n < 5 (insufficient history)', () => {
    const shortStats = _aggregateFromRows(
      // Only 3 runs — spec says never flag even if duration is 10x mean
      [100, 110, 120].map(d => row([phase('pre-merge-tests', d)]))
    );
    assert.equal(shortStats['pre-merge-tests'].n, 3);
    const r = detectRegression('pre-merge-tests', 10000, shortStats);
    assert.equal(r.is_regression, false);
  });

  test('returns no-flag shape for unknown phase', () => {
    const r = detectRegression('ghost-phase', 5000, stats);
    assert.equal(r.is_regression, false);
    assert.equal(r.magnitude, null);
  });

  test('returns no-flag shape for null stats', () => {
    const r = detectRegression('pre-merge-tests', 5000, null);
    assert.equal(r.is_regression, false);
  });

  test('does not flag when stddev is 0 (no variance, all runs identical)', () => {
    const flatStats = _aggregateFromRows(
      Array.from({ length: 10 }, () => row([phase('merge', 500)]))
    );
    assert.equal(flatStats['merge'].stddev, 0);
    const r = detectRegression('merge', 5000, flatStats);
    assert.equal(r.is_regression, false);
  });
});

describe('pipeline-stats cache', () => {
  test('fetchFn is only called once within the TTL window', async () => {
    _clearCache();
    let calls = 0;
    const fetchFn = async () => { calls += 1; return { rows: [row([phase('merge', 500)])] }; };
    await getProjectStats('cached', { fetchFn });
    await getProjectStats('cached', { fetchFn });
    await getProjectStats('cached', { fetchFn });
    assert.equal(calls, 1, 'second and third call should hit cache');
  });
});
