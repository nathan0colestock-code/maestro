import { useState, useRef, useCallback, useEffect } from 'react';
import { apiFetch } from './auth.js';
import './Capture.css';

function formatAge(isoString) {
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function RoutingResult({ routing }) {
  // routing_json comes back as a string from the DB; tolerate both shapes.
  let parsed = routing;
  if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch { return null; } }
  if (!parsed?.plan?.captures_decomposed?.length) return null;
  return (
    <div className="routing-result">
      {parsed.plan.captures_decomposed.map((item, i) => (
        <span key={i} className="routing-tag">
          <span className="routing-project">{item.project}</span>
          <span className="routing-action">{item.action}</span>
        </span>
      ))}
    </div>
  );
}

function haptic(kind = 'light') {
  try {
    if (typeof navigator?.vibrate === 'function') {
      navigator.vibrate(kind === 'success' ? [10, 40, 10] : kind === 'error' ? [40, 30, 40] : 15);
    }
  } catch { /* unsupported */ }
}

export default function Capture() {
  const [text, setText] = useState('');
  const [listening, setListening] = useState(false);
  const [status, setStatus] = useState(null); // null | 'sending' | 'sent' | 'error'
  const [errorMsg, setErrorMsg] = useState(null);
  const [recent, setRecent] = useState([]);
  const [recentLoaded, setRecentLoaded] = useState(false);
  const [mode, setMode] = useState('queue'); // 'queue' | 'notebook'
  const [glossResult, setGlossResult] = useState(null); // { review_url, date } after notebook send
  const recognitionRef = useRef(null);
  const textareaRef = useRef(null);

  const loadRecent = useCallback(async () => {
    try {
      const res = await apiFetch('/api/captures');
      if (res.ok) setRecent(await res.json());
    } catch { /* offline or no server yet */ }
    setRecentLoaded(true);
  }, []);

  useEffect(() => { loadRecent(); }, [loadRecent]);

  function startListening() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert('Voice input not supported in this browser. Try Safari on iOS.');
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    let finalTranscript = text;

    recognition.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i].transcript;
        if (e.results[i].isFinal) finalTranscript += (finalTranscript ? ' ' : '') + t;
        else interim = t;
      }
      setText(finalTranscript + (interim ? ' ' + interim : ''));
    };

    recognition.onerror = () => stopListening();
    recognition.onend = () => setListening(false);

    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  }

  function stopListening() {
    recognitionRef.current?.stop();
    setListening(false);
  }

  async function sendToQueue() {
    const trimmed = text.trim();
    if (!trimmed) return;

    setStatus('sending');
    setErrorMsg(null);
    try {
      const res = await apiFetch('/api/capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: trimmed }),
      });
      if (!res.ok) { const body = await res.text(); throw new Error(body || `HTTP ${res.status}`); }
      setText('');
      setStatus('sent');
      haptic('success');
      // Hold the success state longer so the user notices it (was 2s — too brief).
      setTimeout(() => setStatus(null), 4000);
      loadRecent();
    } catch (err) {
      setErrorMsg(err.message || 'send failed');
      setStatus('error');
      haptic('error');
      // Don't auto-clear; let user see error and retry.
    }
  }

  async function sendToGloss() {
    const trimmed = text.trim();
    if (!trimmed) return;

    setStatus('sending');
    setGlossResult(null);
    try {
      const res = await apiFetch('/api/gloss/voice', {
        method: 'POST',
        body: JSON.stringify({ transcript: trimmed }),
      });
      if (!res.ok) throw new Error(await res.text());
      const body = await res.json();
      setText('');
      setStatus('sent');
      setGlossResult({ review_url: body.review_url, date: body.date });
      setTimeout(() => setStatus(null), 4000);
    } catch {
      setStatus('error');
      setTimeout(() => setStatus(null), 3000);
    }
  }

  function send() {
    if (mode === 'notebook') return sendToGloss();
    return sendToQueue();
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
  }

  const isNotebook = mode === 'notebook';
  const sendLabel = isNotebook
    ? (status === 'sending' ? 'Sending…' : status === 'sent' ? 'Saved ✓' : status === 'error' ? 'Error ✗' : 'Save to Gloss')
    : (status === 'sending' ? 'Sending…' : status === 'sent' ? 'Sent ✓' : status === 'error' ? 'Error ✗' : 'Send');

  return (
    <div className="capture-screen">
      <header className="capture-header">
        <h1 className="capture-title">Maestro</h1>
        <p className="capture-subtitle">What's on your mind?</p>
      </header>

      <div className="mode-toggle">
        <button
          className={`mode-btn ${mode === 'queue' ? 'active' : ''}`}
          onClick={() => setMode('queue')}
        >
          Task Queue
        </button>
        <button
          className={`mode-btn ${mode === 'notebook' ? 'active' : ''}`}
          onClick={() => setMode('notebook')}
        >
          📓 Notebook
        </button>
      </div>

      <div className="input-area">
        <textarea
          ref={textareaRef}
          className="capture-textarea"
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isNotebook ? 'Speak or type a notebook capture…' : 'Toss in a note, idea, or task…'}
          rows={5}
          autoFocus
        />

        <div className="capture-actions">
          <button
            className={`mic-btn ${listening ? 'listening' : ''}`}
            onClick={listening ? stopListening : startListening}
            aria-label={listening ? 'Stop recording' : 'Start voice input'}
          >
            {listening ? '⬛' : '🎙'}
          </button>

          <button
            className={`send-btn ${status} ${isNotebook ? 'notebook-send' : ''}`}
            onClick={send}
            disabled={!text.trim() || status === 'sending'}
          >
            {sendLabel}
          </button>
        </div>

        {listening && (
          <p className="listening-hint" aria-live="polite">Listening… tap ⬛ to stop</p>
        )}

        {status === 'error' && errorMsg && (
          <div className="capture-error" role="alert">
            <span className="capture-error-msg">{errorMsg}</span>
            <button className="btn-retry" onClick={send} aria-label="Retry send">Retry</button>
            <button className="btn-dismiss" onClick={() => { setStatus(null); setErrorMsg(null); }} aria-label="Dismiss error">✕</button>
          </div>
        )}

        {isNotebook && status === 'sent' && glossResult?.review_url && (
          <div className="gloss-success">
            <a
              href={glossResult.review_url}
              target="_blank"
              rel="noreferrer"
              className="gloss-review-link"
            >
              View in Gloss →
            </a>
          </div>
        )}

        {isNotebook && (
          <p className="mode-hint">Voice memos go straight into your Gloss notebook.</p>
        )}
      </div>

      {!isNotebook && recentLoaded && recent.length > 0 && (
        <section className="recent-section">
          <h2 className="section-heading">Recent</h2>
          <ul className="recent-list">
            {recent.slice(0, 8).map(c => (
              <li key={c.id} className={`recent-item ${c.processed_at ? 'processed' : 'pending'}`}>
                <div className="recent-text">{c.text}</div>
                <div className="recent-meta">
                  <span className="recent-age">{formatAge(c.created_at)}</span>
                  {c.processed_at
                    ? <span className="recent-status routed">routed</span>
                    : <span className="recent-status queued">queued</span>}
                </div>
                {c.routing_json && <RoutingResult routing={c.routing_json} />}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
