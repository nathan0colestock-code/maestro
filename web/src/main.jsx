import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { registerPush } from './push.js';
import './index.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);

// SPEC 6 — opportunistically register for push. Safe no-op if VAPID is not
// configured or the browser doesn't support PushManager. Fires once on load.
if (typeof window !== 'undefined') {
  setTimeout(() => { registerPush().catch(() => {}); }, 2500);
}
