// Suite app switcher — Google-Workspace-style grid in the top-right of every
// suite app's header. Served from maestro-nc so there's one source of truth.
//
// Usage: <script src="https://maestro-nc.fly.dev/suite-switcher.js" defer></script>
// Optional: set `window.__SUITE_CURRENT__ = 'gloss'` before this loads to dim
//           the current app's tile so you don't click back into the app
//           you're already in.
//
// The script is self-contained: CSS is injected into <head>, the button mounts
// itself into document.body as `position: fixed` top-right. No app-side markup
// needed. Safe to load multiple times (guarded by window.__SUITE_SWITCHER__).

(function () {
  if (window.__SUITE_SWITCHER__) return;
  window.__SUITE_SWITCHER__ = true;

  const APPS = [
    { key: 'gloss',   label: 'Gloss',    url: 'https://gloss-nc.fly.dev',    hue: '#c9a97a' },
    { key: 'comms',   label: "Comm's",   url: 'https://comms-nc.fly.dev',    hue: '#6b9bd1' },
    { key: 'black',   label: 'Black',    url: 'https://black-hole.fly.dev',  hue: '#3b3b3b' },
    { key: 'scribe',  label: 'Scribe',   url: 'https://scribe-nc.fly.dev',   hue: '#8a6da5' },
  ];

  const STYLE = `
    .suite-switcher-btn {
      position: fixed; top: 12px; right: 12px; z-index: 2147483000;
      width: 36px; height: 36px; border-radius: 50%;
      background: rgba(255, 255, 255, 0.92);
      border: 1px solid rgba(0, 0, 0, 0.08);
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.08);
      display: grid; place-items: center; cursor: pointer;
      transition: background 120ms ease, transform 120ms ease;
      padding: 0;
    }
    .suite-switcher-btn:hover { background: rgba(255, 255, 255, 1); transform: scale(1.04); }
    .suite-switcher-btn:focus { outline: 2px solid #6b9bd1; outline-offset: 2px; }
    .suite-switcher-btn svg { display: block; }
    @media (prefers-color-scheme: dark) {
      .suite-switcher-btn {
        background: rgba(40, 40, 40, 0.92);
        border-color: rgba(255, 255, 255, 0.1);
      }
      .suite-switcher-btn:hover { background: rgba(60, 60, 60, 1); }
      .suite-switcher-btn svg circle { fill: #e8e8e8; }
    }
    .suite-switcher-panel {
      position: fixed; top: 56px; right: 12px; z-index: 2147483000;
      background: #fff;
      border: 1px solid rgba(0, 0, 0, 0.08);
      border-radius: 10px;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.18);
      padding: 14px;
      display: none;
      grid-template-columns: repeat(2, 1fr);
      gap: 6px;
      width: 232px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    }
    .suite-switcher-panel.open { display: grid; }
    @media (prefers-color-scheme: dark) {
      .suite-switcher-panel { background: #2a2a2a; border-color: rgba(255, 255, 255, 0.12); color: #eee; }
    }
    .suite-switcher-tile {
      display: flex; flex-direction: column; align-items: center; gap: 4px;
      padding: 10px 8px; border-radius: 8px;
      text-decoration: none; color: inherit;
      transition: background 100ms ease;
      font-size: 12px;
    }
    .suite-switcher-tile:hover { background: rgba(0, 0, 0, 0.05); }
    @media (prefers-color-scheme: dark) {
      .suite-switcher-tile:hover { background: rgba(255, 255, 255, 0.06); }
    }
    .suite-switcher-tile.current { opacity: 0.4; pointer-events: none; }
    .suite-switcher-tile-icon {
      width: 34px; height: 34px; border-radius: 8px;
      display: grid; place-items: center;
      color: #fff; font-weight: 700; font-size: 15px;
      letter-spacing: 0.02em;
    }
  `;

  function injectStyle() {
    const el = document.createElement('style');
    el.textContent = STYLE;
    document.head.appendChild(el);
  }

  // Nine-dot grid icon (Google-Workspace style).
  function iconSVG() {
    const dots = [0, 1, 2].flatMap(r => [0, 1, 2].map(c => `<circle cx="${4 + c * 5}" cy="${4 + r * 5}" r="1.6" fill="#555" />`)).join('');
    return `<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">${dots}</svg>`;
  }

  function mount() {
    injectStyle();
    const current = window.__SUITE_CURRENT__ || null;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'suite-switcher-btn';
    btn.setAttribute('aria-label', 'Suite apps');
    btn.innerHTML = iconSVG();

    const panel = document.createElement('div');
    panel.className = 'suite-switcher-panel';
    panel.setAttribute('role', 'menu');
    for (const a of APPS) {
      const tile = document.createElement('a');
      tile.className = 'suite-switcher-tile' + (a.key === current ? ' current' : '');
      tile.href = a.url;
      tile.target = a.key === current ? '_self' : '_blank';
      tile.rel = 'noopener';
      tile.innerHTML = `
        <div class="suite-switcher-tile-icon" style="background:${a.hue}">${a.label.charAt(0).toUpperCase()}</div>
        <div>${a.label}</div>
      `;
      panel.appendChild(tile);
    }

    function close() { panel.classList.remove('open'); }
    function toggle() { panel.classList.toggle('open'); }
    btn.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
    document.addEventListener('click', (e) => { if (!panel.contains(e.target) && e.target !== btn) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

    document.body.appendChild(btn);
    document.body.appendChild(panel);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
