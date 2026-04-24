// SPEC 6 — PWA push registration helper.
// Called once from main.jsx after the user is authed.

import { getPassword } from './auth.js';

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; ++i) out[i] = raw.charCodeAt(i);
  return out;
}

export async function registerPush() {
  if (typeof window === 'undefined') return { ok: false, reason: 'no-window' };
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return { ok: false, reason: 'unsupported' };
  }
  try {
    // Fetch VAPID key. Unauthenticated endpoint so we can probe without a
    // password (enabled=false short-circuits if the deploy hasn't set keys).
    const res = await fetch('/api/push/vapid-public');
    if (!res.ok) return { ok: false, reason: 'vapid-fetch-failed' };
    const { public_key, enabled } = await res.json();
    if (!enabled || !public_key) return { ok: false, reason: 'not-enabled' };

    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const perm = Notification.permission === 'granted'
        ? 'granted'
        : await Notification.requestPermission();
      if (perm !== 'granted') return { ok: false, reason: 'permission-denied' };
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(public_key),
      });
    }

    const password = getPassword();
    const headers = { 'Content-Type': 'application/json' };
    if (password) headers['X-Maestro-Password'] = password;
    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        endpoint: sub.endpoint,
        keys: sub.toJSON().keys,
        user_agent: navigator.userAgent,
      }),
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: 'error', error: err.message };
  }
}
