// Maestro service worker.
// Primary job: make POST /api/capture survive bad connectivity on iPhone.
// If the network rejects (offline, timeout, 5xx) we stash the body in
// IndexedDB and replay it on the next `sync` event / page load.
//
// Secondary job: serve a lightweight offline fallback for navigations.

/* global importScripts, MaestroOfflineCapture */

importScripts('/offline-capture.js');

const VERSION = 'maestro-sw-v1';
const OFFLINE_URL = '/offline.html';
const PRECACHE = [OFFLINE_URL, '/manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await cache.addAll(PRECACHE);
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

function isCapturePost(req) {
  if (req.method !== 'POST') return false;
  const url = new URL(req.url);
  return url.pathname === '/api/capture';
}

async function storeCaptureRequest(request) {
  // Clone before reading — we only get one chance at the body stream.
  const body = await request.clone().text();
  // Only preserve headers that matter for the replay.
  const headers = {};
  for (const [k, v] of request.headers) {
    const lower = k.toLowerCase();
    if (lower === 'x-maestro-password' || lower === 'x-maestro-secret' || lower === 'authorization') {
      headers[k] = v;
    }
  }
  await MaestroOfflineCapture.enqueueCapture({ body, headers });
  // Opportunistically register a background sync; fall back silently if
  // the browser (Safari) doesn't support it — we also drain on page load.
  try {
    if (self.registration.sync) {
      await self.registration.sync.register('drain-captures');
    }
  } catch { /* no-op */ }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Offline-first capture queue
  if (isCapturePost(request)) {
    event.respondWith((async () => {
      try {
        const res = await fetch(request.clone());
        // Server replied — let it through even if it's a client error.
        // Network-level failures (TypeError) fall into the catch below.
        return res;
      } catch {
        await storeCaptureRequest(request);
        return new Response(
          JSON.stringify({ queued: true, offline: true }),
          {
            status: 202,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
    })());
    return;
  }

  // Navigation fallback: if the HTML fetch fails, show /offline.html
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch {
        const cache = await caches.open(VERSION);
        const cached = await cache.match(OFFLINE_URL);
        return cached || new Response('offline', { status: 503 });
      }
    })());
  }
});

// Background Sync — drain whenever connectivity returns.
self.addEventListener('sync', (event) => {
  if (event.tag === 'drain-captures') {
    event.waitUntil(MaestroOfflineCapture.drainCaptures());
  }
});

// Page can nudge the SW to drain immediately (e.g. on 'online' event).
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'drain-captures') {
    event.waitUntil(MaestroOfflineCapture.drainCaptures());
  }
});
