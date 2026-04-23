// Offline capture queue — shared between the service worker and the page.
// Pure IndexedDB helpers. No imports (loaded via importScripts in the SW,
// and via <script> or direct fetch from the page if needed).
//
// Schema: single object store "offline-captures" keyed by auto-increment id.
// Each record: { body, headers, createdAt }.
//
// IMPORTANT: this file is the single source of truth for the queue + drain
// logic. Keep it dependency-free so it can run in a ServiceWorkerGlobalScope,
// a Window, and under Node's "fake-indexeddb" in tests.

(function attach(global) {
  const DB_NAME = 'maestro-offline';
  const DB_VERSION = 1;
  const STORE = 'offline-captures';

  function openDB(idbFactory) {
    const factory = idbFactory || global.indexedDB;
    return new Promise((resolve, reject) => {
      const req = factory.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function tx(db, mode, fn) {
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const store = t.objectStore(STORE);
      let result;
      Promise.resolve(fn(store)).then(v => { result = v; }).catch(reject);
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function enqueueCapture({ body, headers }, { idbFactory } = {}) {
    const db = await openDB(idbFactory);
    try {
      return await tx(db, 'readwrite', (store) => {
        return reqToPromise(store.add({
          body: body ?? '',
          headers: headers ?? {},
          createdAt: new Date().toISOString(),
        }));
      });
    } finally {
      db.close();
    }
  }

  async function listQueued({ idbFactory } = {}) {
    const db = await openDB(idbFactory);
    try {
      return await tx(db, 'readonly', (store) => reqToPromise(store.getAll()));
    } finally {
      db.close();
    }
  }

  async function deleteQueued(id, { idbFactory } = {}) {
    const db = await openDB(idbFactory);
    try {
      return await tx(db, 'readwrite', (store) => reqToPromise(store.delete(id)));
    } finally {
      db.close();
    }
  }

  // Drain the queue: POST each stored capture to /api/capture. Any request
  // that succeeds (2xx) OR is rejected as a client error (4xx — the server
  // saw it, so don't retry forever) is removed. 5xx / network errors are
  // left in the queue for the next drain.
  //
  // Returns { sent, failed, remaining } — helpful for tests + UI.
  async function drainCaptures(options = {}) {
    const fetchFn = options.fetch || global.fetch?.bind(global);
    if (!fetchFn) throw new Error('drainCaptures: no fetch available');
    const endpoint = options.endpoint || '/api/capture';

    const items = await listQueued(options);
    let sent = 0;
    let failed = 0;

    for (const item of items) {
      try {
        const res = await fetchFn(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(item.headers || {}),
          },
          body: item.body,
        });
        if (res.ok || (res.status >= 400 && res.status < 500)) {
          await deleteQueued(item.id, options);
          if (res.ok) sent += 1; else failed += 1;
        } else {
          // 5xx — leave in queue, try again later
          failed += 1;
        }
      } catch {
        // network error — leave in queue
        failed += 1;
      }
    }

    const remaining = (await listQueued(options)).length;
    return { sent, failed, remaining };
  }

  const api = {
    DB_NAME,
    STORE,
    openDB,
    enqueueCapture,
    listQueued,
    deleteQueued,
    drainCaptures,
  };

  // Expose on global (self for SW, window for page). Also support CommonJS
  // for Node test environments.
  global.MaestroOfflineCapture = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof self !== 'undefined' ? self : typeof global !== 'undefined' ? global : this);
