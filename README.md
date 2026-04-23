# Maestro

The **autonomous orchestration layer** for a five-app personal suite. Maestro turns a voice-memo or iPhone-PWA capture into deployed, tested code that you wake up to in the morning.

The flow, every night:

```
 iPhone PWA capture  ──▶  cloud intake (maestro-nc)
                              │
                              ▼
                      Gemini router classifies which project(s)
                              │
                              ▼
                      feature set queued for overnight run
                              │
                              ▼  (23:00 local, or catchup on next open)
                    local daemon picks up → spawns `claude -p` worker in the right repo
                              │
                              ▼
                    worker implements on maestro/<slug> branch, runs tests
                              │
                              ▼
                    tests green  →  merge to main  →  fly deploy  →  health check
                              │                                           │
                              ▼                                           ▼
                   tests red / deploy bad:                     feature set = merged_and_deployed
                   revert, mark for you to review
                              │
                              ▼
                   morning: iPhone PWA shows green/red per project
```

---

## Architecture

| Component | Where | What |
|---|---|---|
| **cloud** | Fly.io (`maestro-nc`), `cloud/` | REST API for capture intake, feature-set state, worker pings; serves the PWA dashboard |
| **web** | `web/` (PWA) | iPhone home-screen app for dropping captures and watching project health. Works offline (IndexedDB queue replays on reconnect) |
| **local daemon** | user's laptop (`local/`, `com.maestro.daemon.plist` LaunchAgent) | Polls cloud, spawns Claude workers in project repos, runs the test + merge + deploy pipeline |
| **workers** | ephemeral `claude -p` sessions | Do the actual coding on a branch; return a plain-language summary |

The daemon is the only piece with git write access. The cloud never touches repos.

---

## Stack

- Node 20
- SQLite (cloud), better-sqlite3
- Express (cloud API)
- React + Vite (web PWA)
- Google Gemini (router + synthesis)
- Anthropic Claude CLI (workers)
- Deployed to [Fly.io](https://fly.io) as **`maestro-nc`**
- SQLite replicated to Cloudflare R2 via [Litestream](https://litestream.io)

---

## Quick start

### Cloud
```bash
cd cloud
npm install
cp .env.example .env     # set MAESTRO_SECRET, MAESTRO_PASSWORD, GEMINI_API_KEY
node server.js
```

### Local daemon
```bash
cd local
npm install
cp .env.example .env     # set MAESTRO_CLOUD_URL, MAESTRO_SECRET, GEMINI_API_KEY, AUTO_MERGE_ON_TESTS_PASS
node daemon.js
# or register as a LaunchAgent — see local/README.md
```

### Web PWA
```bash
cd web
npm install
npm run dev              # dev on :5173
npm run build            # produces web/dist/ served by cloud/server.js
```

---

## API (cloud)

- `POST /api/capture` — drop a capture (PWA calls this)
- `GET /api/feature-sets` — list feature sets
- `POST /api/feature-sets/:id/status` — worker/daemon updates
- `POST /api/worker/*` — worker lifecycle pings
- `GET /api/projects` — per-project rollup incl. last deploy status
- `GET /api/status` — suite-standard status envelope

Auth: `X-Maestro-Password` (legacy) or `Authorization: Bearer <SUITE_API_KEY>` (for inter-suite status polling).

---

## Deploy

```bash
cd cloud
fly deploy -a maestro-nc
```

---

## Suite siblings

Maestro is the **orchestration** node of a five-app personal suite — the only app whose job is to modify the other apps. Independent processes, all on [Fly.io](https://fly.io), all backed up to R2 via Litestream.

| App | Role | How Maestro interacts |
|---|---|---|
| **[comms](https://github.com/nathan0colestock-code/comms)** | iMessage + Gmail + contacts | Dispatches feature sets targeting comms; polls `/api/status` |
| **[gloss](https://github.com/nathan0colestock-code/gloss)** | Personal knowledge graph | Dispatches feature sets targeting gloss; polls `/api/status` |
| **[scribe](https://github.com/nathan0colestock-code/scribe)** | Collaborative document editor | Dispatches feature sets targeting scribe; polls `/api/status` |
| **[black](https://github.com/nathan0colestock-code/black)** | Personal file search | Dispatches feature sets targeting black; polls `/api/status` |

Every app exposes `GET /api/status` → `{ app, version, ok, uptime_seconds, metrics }`, Bearer-authed. Maestro uses the shared `SUITE_API_KEY` to poll all five and surfaces their health in the PWA dashboard.

**Cross-app feature sets** are supported: a single capture like "add a link from gloss sidebar to the comms dashboard" produces a feature set with `extra_projects: ['comms']`, the worker gets `--add-dir` for the comms repo, and writes a shared contract spec into `docs/INTEGRATIONS/<slug>.md` in the primary repo before coding either side.

---

## License

Private.
