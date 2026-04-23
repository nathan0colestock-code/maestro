import { useState, useEffect } from 'react';
import Capture from './Capture.jsx';
import Dashboard from './Dashboard.jsx';
import Answer from './Answer.jsx';
import Features from './Features.jsx';
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

  if (!authed) return <Login onSuccess={() => setAuthed(true)} />;

  function logout() {
    if (!confirm('Sign out of Maestro?')) return;
    clearPassword();
    setAuthed(false);
  }

  return (
    <div className="app">
      <main className="app-content">
        {tab === 'capture' && <Capture />}
        {tab === 'features' && <Features />}
        {tab === 'dashboard' && <Dashboard onLogout={logout} />}
        {tab === 'answer' && <Answer />}
      </main>

      <nav className="tab-bar">
        <button
          className={`tab-btn ${tab === 'capture' ? 'active' : ''}`}
          onClick={() => setTab('capture')}
        >
          <span className="tab-icon">⬆</span>
          <span className="tab-label">Capture</span>
        </button>
        <button
          className={`tab-btn ${tab === 'features' ? 'active' : ''}`}
          onClick={() => setTab('features')}
        >
          <span className="tab-icon">✦</span>
          <span className="tab-label">Features</span>
        </button>
        <button
          className={`tab-btn ${tab === 'answer' ? 'active' : ''}`}
          onClick={() => setTab('answer')}
        >
          <span className="tab-icon">
            ?{pendingQuestions > 0 && <span className="tab-dot" />}
          </span>
          <span className="tab-label">
            Answer{pendingQuestions > 0 ? ` (${pendingQuestions})` : ''}
          </span>
        </button>
        <button
          className={`tab-btn ${tab === 'dashboard' ? 'active' : ''}`}
          onClick={() => setTab('dashboard')}
        >
          <span className="tab-icon">⊞</span>
          <span className="tab-label">Projects</span>
        </button>
      </nav>
    </div>
  );
}
