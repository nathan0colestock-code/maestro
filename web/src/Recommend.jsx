import { useState, useEffect, useCallback, useRef } from 'react';
import { apiFetch } from './auth.js';
import './Capture.css';
import './Recommend.css';

// "Suggest improvement" — first-class input stream for the nightly analyst.
// Open-ended product direction (voice or text), distinct from per-capture
// routing correction. The analyst ranks these above telemetry-only hunches.

const APPS = ['suite', 'maestro', 'gloss', 'comms', 'black', 'scribe'];

const STATUS_LABEL = {
  new: 'new',
  clustered: 'under review',
  proposed: 'proposed',
  shipped: 'shipped ✓',
  rejected: 'declined',
  duplicate: 'duplicate',
};

function statusClass(status) {
  if (status === 'shipped')  return 'rec-chip rec-chip--shipped';
  if (status === 'proposed') return 'rec-chip rec-chip--proposed';
  if (status === 'rejected' || status === 'duplicate') return 'rec-chip rec-chip--closed';
  return 'rec-chip';
}

export default function Recommend() {
  const [text, setText] = useState('');
  const [listening, setListening] = useState(false);
  const [target, setTarget] = useState('suite');
  const [priority, setPriority] = useState(3);
  const [status, setStatus] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);
  const [items, setItems] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const recognitionRef = useRef(null);

  const loadItems = useCallback(async () => {
    try {
      const res = await apiFetch('/api/recommendations');
      if (res.ok) setItems(await res.json());
    } catch { /* offline */ }
    setLoaded(true);
  }, []);

  useEffect(() => { loadItems(); }, [loadItems]);

  function startListening() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { alert('Voice input not supported. Try Safari on iOS.'); return; }
    const r = new SR();
    r.continuous = true;
    r.interimResults = true;
    r.lang = 'en-US';
    let final = text;
    r.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) final += (final ? ' ' : '') + t;
        else interim += t;
      }
      setText(interim ? `${final} ${interim}` : final);
    };
    r.onerror = (e) => { setErrorMsg(`Voice: ${e.error || 'error'}`); setListening(false); };
    r.onend = () => setListening(false);
    recognitionRef.current = r;
    r.start();
    setListening(true);
  }

  function stopListening() {
    recognitionRef.current?.stop();
    setListening(false);
  }

  async function submit() {
    const trimmed = text.trim();
    if (!trimmed) return;
    setStatus('sending');
    setErrorMsg(null);
    try {
      const res = await apiFetch('/api/recommendations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: trimmed,
          source: listening ? 'pwa_voice' : 'pwa_text',
          priority,
          target_app: target === 'suite' ? null : target,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      setText('');
      setStatus('sent');
      loadItems();
      setTimeout(() => setStatus(null), 3000);
    } catch (err) {
      setErrorMsg(err.message || 'send failed');
      setStatus('error');
    }
  }

  return (
    <div className="capture-screen">
      <header className="capture-header">
        <h1 className="capture-title">💡 Ideas</h1>
        <p className="capture-subtitle">
          Your voice and text suggestions are first-class input to the nightly analyst.
        </p>
      </header>

      <div className="input-area">
        <textarea
          className="capture-textarea"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={listening ? 'Listening…' : 'What should the suite do better?'}
          rows={4}
          aria-label="Improvement suggestion"
        />

        <div className="rec-meta-row">
          <label className="rec-field">
            <span className="rec-field-label">Target</span>
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              {APPS.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
          </label>
          <label className="rec-field">
            <span className="rec-field-label">Priority</span>
            <select value={priority} onChange={(e) => setPriority(Number(e.target.value))}>
              <option value={1}>1 · low</option>
              <option value={2}>2</option>
              <option value={3}>3 · normal</option>
              <option value={4}>4</option>
              <option value={5}>5 · urgent</option>
            </select>
          </label>
        </div>

        <div className="capture-actions">
          <button
            className={`mic-btn ${listening ? 'listening' : ''}`}
            onClick={listening ? stopListening : startListening}
            aria-label={listening ? 'Stop recording' : 'Start voice input'}
          >
            {listening ? '⬛' : '🎙'}
          </button>
          <button
            className={`send-btn ${status}`}
            onClick={submit}
            disabled={!text.trim() || status === 'sending'}
          >
            {status === 'sending' ? 'Sending…' : status === 'sent' ? 'Sent ✓' : status === 'error' ? 'Error ✗' : 'Submit'}
          </button>
        </div>

        {status === 'error' && errorMsg && (
          <div className="capture-error" role="alert">
            <span className="capture-error-msg">{errorMsg}</span>
            <button className="btn-retry" onClick={submit}>Retry</button>
            <button className="btn-dismiss" onClick={() => { setStatus(null); setErrorMsg(null); }}>✕</button>
          </div>
        )}
      </div>

      <section className="recent-section">
        <h2 className="section-heading">Your suggestions</h2>
        {!loaded ? <p className="rec-muted">Loading…</p>
          : items.length === 0 ? <p className="rec-muted">No suggestions yet. Speak what's on your mind.</p>
          : (
            <ul className="recent-list">
              {items.map(item => (
                <li key={item.id} className="recent-item">
                  <div className="recent-text">{item.text}</div>
                  <div className="recent-meta">
                    <span className={statusClass(item.status)}>{STATUS_LABEL[item.status] || item.status}</span>
                    {item.target_app && <span className="rec-chip">→ {item.target_app}</span>}
                    {item.priority >= 4 && <span className="rec-chip rec-chip--urgent">P{item.priority}</span>}
                    {item.linked_pr_url && (
                      <a href={item.linked_pr_url} target="_blank" rel="noreferrer" className="rec-chip rec-chip--link">PR</a>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )
        }
      </section>
    </div>
  );
}
