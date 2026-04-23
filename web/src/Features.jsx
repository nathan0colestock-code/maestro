import { useEffect, useState, useCallback } from 'react';
import { apiFetch } from './auth.js';
import './Features.css';

function statusLabel(s) {
  return {
    collecting: 'Collecting',
    queued: 'Queued for tonight',
    running: 'Working…',
    needs_answer: 'Needs answer',
    done: 'Ready to review',
    merge_requested: 'Merging…',
    merged: 'Merged',
    failed: 'Failed',
    merge_failed: 'Merge failed',
  }[s] || s;
}

function FeatureCard({ set, onRun, onMerge, expanded, onToggle }) {
  const running = set.status === 'running';
  const ready = set.status === 'done';
  const merged = set.status === 'merged';

  return (
    <div className={`feature-card status-${set.status}`} onClick={onToggle}>
      <div className="fc-header">
        <span className="fc-project">
          {set.project_name}
          {set.extra_projects?.length > 0 && (
            <span className="fc-integration"> ↔ {set.extra_projects.join(' ↔ ')}</span>
          )}
        </span>
        <span className={`fc-status status-${set.status}`}>{statusLabel(set.status)}</span>
      </div>
      <div className="fc-title">{set.title}</div>
      {set.description && <div className="fc-desc">{set.description}</div>}
      <div className="fc-meta">
        <span>{set.tasks.length} task{set.tasks.length === 1 ? '' : 's'}</span>
        {set.branch_name && <span className="fc-branch">· {set.branch_name}</span>}
      </div>

      {expanded && (
        <div className="fc-expanded" onClick={(e) => e.stopPropagation()}>
          <ul className="fc-tasks">
            {set.tasks.map(t => (
              <li key={t.id} className={`fc-task status-${t.status}`}>
                <span className="fc-task-text">{t.text}</span>
                {t.context && <span className="fc-task-ctx">{t.context}</span>}
              </li>
            ))}
          </ul>

          {set.runs?.length > 0 && (
            <div className="fc-runs">
              {set.runs.slice(0, 3).map(r => (
                <div key={r.run_id} className="fc-run">
                  {r.status} · {r.duration_ms ? `${Math.round(r.duration_ms / 1000)}s` : '—'}
                  {r.cost_usd ? ` · $${r.cost_usd.toFixed(3)}` : ''}
                </div>
              ))}
            </div>
          )}

          <div className="fc-actions">
            {(set.status === 'collecting' || set.status === 'queued') && !running && (
              <button className="fc-btn primary" onClick={onRun}>Run now</button>
            )}
            {ready && set.branch_name && (
              <button className="fc-btn primary" onClick={onMerge}>Merge to main</button>
            )}
            {merged && <span className="fc-note">Merged locally — push manually if needed.</span>}
          </div>
        </div>
      )}
    </div>
  );
}

export default function Features() {
  const [sets, setSets] = useState([]);
  const [activeRuns, setActiveRuns] = useState([]);
  const [expanded, setExpanded] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [sr, rr] = await Promise.all([
        apiFetch('/api/feature-sets'),
        apiFetch('/api/worker/runs'),
      ]);
      if (sr.ok) setSets(await sr.json());
      if (rr.ok) {
        const runs = await rr.json();
        setActiveRuns(runs.filter(r => r.status === 'running'));
      }
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

  async function runNow(id) {
    await apiFetch(`/api/feature-sets/${id}/run`, { method: 'POST', body: '{}' });
    load();
  }

  async function merge(id) {
    if (!confirm('Merge this branch into main locally? (no push)')) return;
    await apiFetch(`/api/feature-sets/${id}/merge`, { method: 'POST', body: '{}' });
    load();
  }

  if (loading) return <div className="features-loading">Loading…</div>;

  return (
    <div className="features">
      <header className="features-header">
        <h1>Features</h1>
        <p className="hint">Captures aggregate into feature sets during the day. Everything runs at 11pm unless you tap Run now.</p>
      </header>

      {activeRuns.length > 0 && (
        <div className="working-strip">
          <div className="ws-title">Working on right now</div>
          {activeRuns.map(r => (
            <div key={r.run_id} className="ws-row">
              <span className="ws-project">{r.project_name}</span>
              <span className="ws-task">{r.task.slice(0, 80)}</span>
            </div>
          ))}
        </div>
      )}

      {sets.length === 0 && (
        <div className="empty">No feature sets yet. Toss in captures and they'll aggregate here.</div>
      )}

      <div className="features-list">
        {sets.map(s => (
          <FeatureCard
            key={s.id}
            set={s}
            expanded={expanded === s.id}
            onToggle={() => setExpanded(expanded === s.id ? null : s.id)}
            onRun={() => runNow(s.id)}
            onMerge={() => merge(s.id)}
          />
        ))}
      </div>
    </div>
  );
}
