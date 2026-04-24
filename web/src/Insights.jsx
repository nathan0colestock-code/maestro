import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from './auth.js';
import './Recommend.css';

// K: Insights tab — latest reflection summary, suite error rate, budget,
// and self-improvement PRs awaiting review.

export default function Insights() {
  const [reflection, setReflection] = useState(null);
  const [suiteLogs, setSuiteLogs] = useState([]);
  const [budget, setBudget] = useState(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await apiFetch('/api/self-improvement/latest');
      if (r.ok) setReflection(await r.json());
    } catch {}
    try {
      const r = await apiFetch('/api/suite-logs?level=warn');
      if (r.ok) setSuiteLogs(await r.json());
    } catch {}
    try {
      const r = await apiFetch('/api/self-improvement/budget');
      if (r.ok) setBudget(await r.json());
    } catch {}
    setLoaded(true);
  }, []);
  useEffect(() => { load(); }, [load]);

  // Compute error-rate-per-app over the loaded suite_logs window.
  const byApp = {};
  for (const r of suiteLogs) {
    byApp[r.app] = byApp[r.app] || { warn: 0, error: 0 };
    if (r.level === 'warn' || r.level === 'error') byApp[r.app][r.level]++;
  }

  return (
    <div className="recommend-page">
      <h2>Insights</h2>
      {!loaded && <div className="rec-empty">Loading…</div>}

      <section className="insight-section">
        <h3>Latest reflection</h3>
        {!reflection && <div className="rec-empty">No reflection yet. Runs nightly at 23:30.</div>}
        {reflection && <ReflectionCard data={reflection} />}
      </section>

      <section className="insight-section">
        <h3>Suite log activity (warn+error)</h3>
        {Object.keys(byApp).length === 0 && (
          <div className="rec-empty">No suite log entries yet. The collector runs hourly.</div>
        )}
        <ul className="rec-list">
          {Object.entries(byApp).map(([app, counts]) => (
            <li key={app} className="rec-item">
              <strong>{app}</strong>
              <span className="rec-meta"> warn: {counts.warn} / error: {counts.error}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="insight-section">
        <h3>Self-improvement budget today</h3>
        {budget && (
          <p>
            PRs opened: <strong>{budget.prs_opened ?? 0}</strong> /
            2 max · spend: <strong>${Number(budget.cost_usd || 0).toFixed(2)}</strong> / $3.00 cap
          </p>
        )}
      </section>
    </div>
  );
}

function ReflectionCard({ data }) {
  const s = data?.summary || {};
  return (
    <div className="rec-editor">
      <p><strong>Date:</strong> {data.date}</p>
      {Array.isArray(s.wins) && s.wins.length > 0 && (
        <>
          <strong>Wins</strong>
          <ul>{s.wins.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </>
      )}
      {Array.isArray(s.struggles) && s.struggles.length > 0 && (
        <>
          <strong>Struggles</strong>
          <ul>{s.struggles.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </>
      )}
      {Array.isArray(s.self_improvements) && s.self_improvements.length > 0 && (
        <>
          <strong>Proposed self-improvements</strong>
          <ul>
            {s.self_improvements.map((imp, i) => (
              <li key={i}>
                <code>{imp.target_file}</code>: {imp.description}
                {' '}<span className="rec-meta">(effort ~{imp.effort_hours}h, conf {imp.confidence})</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
