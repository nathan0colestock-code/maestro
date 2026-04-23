import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from './auth.js';
import './Dashboard.css';

function formatAge(isoString) {
  if (!isoString) return 'never';
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// Map the pipeline's last_deploy_status to a visible dot on the project card.
// The daemon produces these terminal statuses on merged feature sets — green
// means prod is healthy with the latest code; any other colour means the
// overnight loop flagged a problem the developer needs to review.
function deployBadge(project) {
  const status = project.last_deploy_status;
  if (!status) return null;
  const labels = {
    ok: { cls: 'deploy-ok', symbol: '●', title: 'Deploy healthy' },
    reverted: { cls: 'deploy-reverted', symbol: '⚠', title: 'Deploy rolled back — prod is on previous good release' },
    integration_failed: { cls: 'deploy-warn', symbol: '⚠', title: 'Deployed but integration tests failed' },
    test_failed: { cls: 'deploy-bad', symbol: '✕', title: 'Pre-merge tests failed — not deployed' },
    merge_failed: { cls: 'deploy-bad', symbol: '✕', title: 'Merge conflict — not deployed' },
  };
  const b = labels[status];
  if (!b) return null;
  return (
    <span className={`deploy-dot ${b.cls}`} title={`${b.title} · ${formatAge(project.last_deploy_at)}`}>
      {b.symbol}
    </span>
  );
}

function ProjectCard({ project, expanded, onToggle }) {
  const session = project.session;
  const isActive = session?.is_active === 1;
  const activeWorkers = project.active_workers || 0;
  const runs = project.worker_runs || [];
  const runningRun = runs.find(r => r.status === 'running');

  return (
    <div className={`project-card ${isActive ? 'active' : ''}`} onClick={onToggle}>
      <div className="project-header">
        <div className="project-name-row">
          <span className={`status-dot ${isActive ? 'active' : 'idle'}`} />
          <span className="project-name">{project.name}</span>
          {deployBadge(project)}
          {project.open_task_count > 0 && (
            <span className="task-badge">{project.open_task_count}</span>
          )}
          {activeWorkers > 0 && (
            <span className="worker-badge" title="Autonomous worker running">
              ⚙ {activeWorkers}
            </span>
          )}
        </div>
        <span className="expand-icon">{expanded ? '▲' : '▼'}</span>
      </div>

      {project.current_focus && (
        <p className="project-focus">{project.current_focus}</p>
      )}

      {runningRun && (
        <p className="worker-status">
          Working on: {runningRun.task}
        </p>
      )}

      {session && !runningRun && (
        <p className="session-status">
          {isActive
            ? `Claude active — ${session.last_action || 'working'}`
            : `Last session ${formatAge(session.last_active)}`}
        </p>
      )}

      {expanded && (
        <div className="project-details" onClick={e => e.stopPropagation()}>
          {project.last_deploy_at && (
            <div className="detail-row">
              <span className="detail-label">Last deploy</span>
              <span className="detail-value">
                {project.last_deploy_status === 'ok' ? '✓ healthy' : `⚠ ${project.last_deploy_status}`}
                {' · '}
                {formatAge(project.last_deploy_at)}
              </span>
            </div>
          )}
          {project.last_deploy_note && project.last_deploy_status !== 'ok' && (
            <div className="detail-row">
              <span className="detail-label">Deploy note</span>
              <span className="detail-value" style={{ whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: '11px' }}>
                {project.last_deploy_note.slice(0, 400)}
                {project.last_deploy_note.length > 400 ? '…' : ''}
              </span>
            </div>
          )}
          {project.last_commit && (
            <div className="detail-row">
              <span className="detail-label">Last commit</span>
              <span className="detail-value">{project.last_commit}</span>
            </div>
          )}
          {session?.agent_type && (
            <div className="detail-row">
              <span className="detail-label">Agent type</span>
              <span className="detail-value">{session.agent_type}</span>
            </div>
          )}
          {project.pending_tasks?.length > 0 && (
            <div className="tasks-section">
              <p className="detail-label">Queued tasks</p>
              <ul className="task-list">
                {project.pending_tasks.map(t => (
                  <li key={t.id} className="task-item">
                    <span className="task-text">{t.text}</span>
                    {t.context && <span className="task-context">{t.context}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {runs.length > 0 && (
            <div className="tasks-section">
              <p className="detail-label">Recent worker runs</p>
              <ul className="task-list">
                {runs.map(r => (
                  <li key={r.run_id} className={`task-item worker-run worker-${r.status}`}>
                    <span className="task-text">{r.task}</span>
                    <span className="task-context">
                      {r.status === 'running'
                        ? `running — started ${formatAge(r.started_at)}`
                        : `${r.status} — ${formatAge(r.ended_at || r.started_at)}${r.cost_usd ? ` · $${r.cost_usd.toFixed(3)}` : ''}`}
                    </span>
                    {r.summary && r.status !== 'running' && (
                      <span className="task-context worker-summary">{r.summary.slice(0, 240)}{r.summary.length > 240 ? '…' : ''}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {project.description && (
            <p className="project-description">{project.description}</p>
          )}
        </div>
      )}
    </div>
  );
}

export default function Dashboard({ onLogout }) {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState({});
  const [lastRefresh, setLastRefresh] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/projects');
      if (!res.ok) throw new Error(`${res.status}`);
      setProjects(await res.json());
      setError(null);
      setLastRefresh(new Date());
    } catch (err) {
      setError('Could not reach Maestro cloud relay');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, [load]);

  function toggleExpand(name) {
    setExpanded(prev => ({ ...prev, [name]: !prev[name] }));
  }

  const activeCount = projects.filter(p => p.session?.is_active).length;

  return (
    <div className="dashboard-screen">
      <header className="dashboard-header">
        <div className="dashboard-title-row">
          <h1 className="dashboard-title">Projects</h1>
          <div className="dashboard-actions">
            <button className="refresh-btn" onClick={load} title="Refresh">↻</button>
            {onLogout && (
              <button className="refresh-btn" onClick={onLogout} title="Sign out">⎋</button>
            )}
          </div>
        </div>
        <p className="dashboard-subtitle">
          {loading
            ? 'Loading…'
            : error
            ? error
            : `${projects.length} projects · ${activeCount} active · updated ${formatAge(lastRefresh)}`}
        </p>
      </header>

      {!loading && !error && projects.length === 0 && (
        <div className="empty-state">
          <p>No projects yet.</p>
          <p className="empty-hint">Start the local daemon on your laptop to sync project state.</p>
        </div>
      )}

      <div className="project-list">
        {projects.map(project => (
          <ProjectCard
            key={project.name}
            project={project}
            expanded={!!expanded[project.name]}
            onToggle={() => toggleExpand(project.name)}
          />
        ))}
      </div>
    </div>
  );
}
