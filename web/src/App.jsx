import { useState, useEffect } from 'react';
import Capture from './Capture.jsx';
import Dashboard from './Dashboard.jsx';
import Answer from './Answer.jsx';
import Features from './Features.jsx';
import Recommend from './Recommend.jsx';
import Login from './Login.jsx';
import { getPassword, clearPassword, apiFetch } from './auth.js';
import './App.css';

export default function App() {
  const [tab, setTab] = useState('capture');
  const [authed, setAuthed] = useState(!!getPassword());
  const [pendingQuestions, setPendingQuestions] = useState(0);

  useEffect(() => {
    if (!authed) return;
    let cancelled = false;
    async function poll() {
      try {
        const res = await apiFetch('/api/questions');
        if (res.ok) {
          const q = await res.json();
          if (!cancelled) setPendingQuestions(q.length);
        }
      } catch { /* offline */ }
    }
    poll();
    const t = setInterval(poll, 15_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [authed]);

  // Keyboard shortcuts: 1-4 switch tabs (ignored when typing)
  useEffect(() => {
    if (!authed) return;
    function onKey(e) {
      if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '1') setTab('capture');
      else if (e.key === '2') setTab('features');
      else if (e.key === '3') setTab('answer');
      else if (e.key === '4') setTab('dashboard');
      else if (e.key === '5') setTab('recommend');
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [authed]);

  if (!authed) return <Login onSuccess={() => setAuthed(true)} />;

  function logout() {
    if (!confirm('Sign out of Maestro?')) return;
    clearPassword();
    setAuthed(false);
  }

  const tabs = [
    { id: 'capture',   icon: '⬆', label: 'Capture',  shortcut: '1' },
    { id: 'features',  icon: '✦', label: 'Features', shortcut: '2' },
    {
      id: 'answer',
      icon: '?',
      label: pendingQuestions > 0 ? `Answer (${pendingQuestions})` : 'Answer',
      shortcut: '3',
      badge: pendingQuestions > 0,
    },
    { id: 'dashboard', icon: '⊞', label: 'Projects', shortcut: '4' },
    { id: 'recommend', icon: '💡', label: 'Ideas',    shortcut: '5' },
  ];

  return (
    <div className="app">
      <nav className="tab-bar">
        <div className="sidebar-brand">
          <span className="sidebar-logo">M</span>
          <span className="sidebar-name">Maestro</span>
        </div>

        {tabs.map(({ id, icon, label, shortcut, badge }) => (
          <button
            key={id}
            className={`tab-btn ${tab === id ? 'active' : ''}`}
            onClick={() => setTab(id)}
          >
            <span className="tab-icon">
              {icon}
              {badge && <span className="tab-dot" />}
            </span>
            <span className="tab-label">{label}</span>
            <span className="tab-shortcut" aria-hidden="true">{shortcut}</span>
          </button>
        ))}

        <div className="sidebar-footer">
          <button className="sidebar-logout-btn" onClick={logout}>Sign out</button>
        </div>
      </nav>

      <main className="app-content">
        {tab === 'capture'   && <Capture />}
        {tab === 'features'  && <Features />}
        {tab === 'dashboard' && <Dashboard onLogout={logout} />}
        {tab === 'answer'    && <Answer />}
        {tab === 'recommend' && <Recommend />}
      </main>
    </div>
  );
}
