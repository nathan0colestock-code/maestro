import { useState, useEffect, useRef, useCallback } from 'react';
import { apiFetch } from './auth.js';
import './Answer.css';

export default function Answer() {
  const [questions, setQuestions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [index, setIndex] = useState(0);
  const [answer, setAnswer] = useState('');
  const [listening, setListening] = useState(false);
  const [status, setStatus] = useState(null);
  const recognitionRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/questions');
      if (res.ok) {
        const data = await res.json();
        setQuestions(data);
        if (index >= data.length) setIndex(0);
      }
    } catch { /* offline */ }
    setLoading(false);
  }, [index]);

  useEffect(() => {
    load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [load]);

  const current = questions[index];

  function startListening() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert('Voice input not supported in this browser.');
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    let finalTranscript = answer;

    recognition.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i].transcript;
        if (e.results[i].isFinal) finalTranscript += (finalTranscript ? ' ' : '') + t;
        else interim = t;
      }
      setAnswer(finalTranscript + (interim ? ' ' + interim : ''));
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

  async function submit() {
    if (!current || !answer.trim()) return;
    setStatus('sending');
    try {
      const res = await apiFetch(`/api/questions/${current.id}/answer`, {
        method: 'POST',
        body: JSON.stringify({ answer: answer.trim() }),
      });
      if (!res.ok) throw new Error();
      setAnswer('');
      setStatus('sent');
      setTimeout(() => setStatus(null), 1500);
      // Move to next question (list will refresh on next poll)
      setQuestions(qs => qs.filter(q => q.id !== current.id));
      if (index >= questions.length - 1) setIndex(0);
    } catch {
      setStatus('error');
      setTimeout(() => setStatus(null), 2500);
    }
  }

  function skip() {
    setAnswer('');
    setIndex(i => (i + 1) % Math.max(1, questions.length));
  }

  return (
    <div className="answer-screen">
      <header className="answer-header">
        <h1 className="answer-title">Questions</h1>
        <p className="answer-subtitle">
          {loading ? 'Loading…' : questions.length === 0 ? 'No questions — Claude is working autonomously.' : `${questions.length} question${questions.length > 1 ? 's' : ''} waiting`}
        </p>
      </header>

      {current && (
        <>
          <div className="question-card">
            <div className="question-project">{current.project_name}</div>
            {current.task_text && <div className="question-task">Task: {current.task_text}</div>}
            <div className="question-text">{current.question}</div>
          </div>

          <div className="answer-input-area">
            <textarea
              className="answer-textarea"
              value={answer}
              onChange={e => setAnswer(e.target.value)}
              placeholder="Speak or type your answer…"
              rows={4}
              autoFocus
            />

            <div className="answer-actions">
              <button
                className={`mic-btn ${listening ? 'listening' : ''}`}
                onClick={listening ? stopListening : startListening}
                aria-label={listening ? 'Stop recording' : 'Start voice input'}
              >
                {listening ? '⬛' : '🎙'}
              </button>

              <button className="skip-btn" onClick={skip} disabled={questions.length < 2}>
                Skip
              </button>

              <button
                className={`send-btn ${status}`}
                onClick={submit}
                disabled={!answer.trim() || status === 'sending'}
              >
                {status === 'sending' ? 'Sending…' : status === 'sent' ? 'Sent ✓' : status === 'error' ? 'Error ✗' : 'Answer'}
              </button>
            </div>

            {listening && <p className="listening-hint">Listening…</p>}
          </div>

          {questions.length > 1 && (
            <p className="question-nav">{index + 1} of {questions.length}</p>
          )}
        </>
      )}
    </div>
  );
}
