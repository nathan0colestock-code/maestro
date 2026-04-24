import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from './auth.js';
import './Recommend.css';

// SPEC 7 — Feature Definition Phase.
// Lists open/answered threads, lets the user fill in answers + approve.
// Once approved, the cloud stores a generated spec; the daemon then unlocks
// dispatch for matching feature sets.

const STATUS_LABEL = {
  open: 'awaiting answers',
  answered: 'ready to approve',
  approved: 'approved ✓',
  rejected: 'rejected',
};

export default function Define() {
  const [threads, setThreads] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/definition-threads');
      if (res.ok) setThreads(await res.json());
    } catch { /* offline */ }
    setLoaded(true);
  }, []);
  useEffect(() => { load(); }, [load]);

  const active = threads.find(t => t.id === activeId);

  return (
    <div className="recommend-page">
      <h2>Define</h2>
      <p className="rec-help">Answer clarifying questions so workers don't guess. Approve a thread to unlock dispatch.</p>
      {error && <div className="rec-error">{error}</div>}
      {!loaded && <div className="rec-empty">Loading…</div>}
      {loaded && threads.length === 0 && <div className="rec-empty">No definition threads yet. New captures spanning multiple apps will land here.</div>}

      <ul className="rec-list">
        {threads.map(t => (
          <li key={t.id} className={`rec-item ${active?.id === t.id ? 'rec-item--active' : ''}`}>
            <button
              type="button"
              className="rec-item-btn"
              onClick={() => setActiveId(activeId === t.id ? null : t.id)}
            >
              <span className="rec-title">{t.feature_title}</span>
              <span className={`rec-chip rec-chip--${t.status}`}>{STATUS_LABEL[t.status] || t.status}</span>
              {Array.isArray(t.affected_apps) && t.affected_apps.length > 0 && (
                <span className="rec-meta">apps: {t.affected_apps.join(', ')}</span>
              )}
            </button>
            {active?.id === t.id && (
              <ThreadEditor thread={t} onChanged={load} onError={setError} />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ThreadEditor({ thread, onChanged, onError }) {
  const initialAnswers = thread.answers && typeof thread.answers === 'object' ? thread.answers : {};
  const [answers, setAnswers] = useState(initialAnswers);
  const [spec, setSpec] = useState(thread.generated_spec || '');
  const [busy, setBusy] = useState(false);

  const questions = Array.isArray(thread.questions) ? thread.questions : [];

  async function saveAnswers() {
    setBusy(true);
    try {
      const res = await apiFetch(`/api/definition-threads/${thread.id}/answer`, {
        method: 'POST', body: JSON.stringify({ answers }),
      });
      if (!res.ok) throw new Error('save failed');
      await onChanged();
    } catch (e) { onError(e.message); }
    setBusy(false);
  }

  async function approve() {
    const finalSpec = spec.trim() || `# ${thread.feature_title}\n\n(Spec not yet generated — approving as scoped.)`;
    setBusy(true);
    try {
      const res = await apiFetch(`/api/definition-threads/${thread.id}/approve`, {
        method: 'POST', body: JSON.stringify({ generated_spec: finalSpec }),
      });
      if (!res.ok) throw new Error('approve failed');
      await onChanged();
    } catch (e) { onError(e.message); }
    setBusy(false);
  }

  return (
    <div className="rec-editor">
      {questions.length === 0 && (
        <p className="rec-help">No clarifying questions needed for this thread.</p>
      )}
      {questions.map((q, i) => (
        <div key={i} className="rec-q">
          <label className="rec-q-label">{i + 1}. {q}</label>
          <textarea
            className="rec-textarea"
            value={answers[i] ?? answers[String(i)] ?? ''}
            onChange={e => setAnswers({ ...answers, [i]: e.target.value })}
            rows={2}
          />
        </div>
      ))}

      <label className="rec-q-label">Generated / edited spec (markdown):</label>
      <textarea
        className="rec-textarea"
        value={spec}
        onChange={e => setSpec(e.target.value)}
        rows={8}
        placeholder="Paste or edit the generated spec before approving."
      />

      <div className="rec-actions">
        <button disabled={busy} className="btn-secondary" onClick={saveAnswers}>Save answers</button>
        <button disabled={busy} className="btn-primary" onClick={approve}>Approve & unlock dispatch</button>
      </div>
    </div>
  );
}
