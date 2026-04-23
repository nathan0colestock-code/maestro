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
- `GET /api/feature-sets/:id` — single feature set (daemon polls this between pipeline phases for the cancel flag)
- `POST /api/feature-sets/:id/status` — worker/daemon updates
- `POST /api/feature-sets/:id/cancel` — user-initiated stop of a running pipeline; daemon aborts at the next phase boundary with status=`cancelled`
- `POST /api/worker/*` — worker lifecycle pings
- `GET /api/projects` — per-project rollup incl. last deploy status
- `GET /api/status` — suite-standard status envelope

Auth: `X-Maestro-Password` (legacy) or `Authorization: Bearer <SUITE_API_KEY>` (for inter-suite status polling).

### Self-improving pipeline stats (2026-04)

Every `runMergePipeline` execution records `phase_timings` onto the feature set — per-phase `{ started_at, ended_at, duration_ms, status }`. Aggregate stats (p50, p95, mean, stddev, failure_rate per phase per project, 7-day lookback) are exposed via `GET /api/feature-sets/stats?project=X&days=7` and consumed by maestro itself:

- **Router Gemini prompt** gets a "Historical timing for each project" block — so routing decisions weight how expensive a deploy target is.
- **Worker prompts** carry "expected test runtime for this project" — so `claude -p` doesn't panic on legitimately slow suites.
- **Dynamic `WORKER_MAX_MS`** is `max(30 min, p95 × 3)` per-project — fast repos get tight budgets, slow ones get runway.
- **Regression flags** — if a phase runs >2σ above the 7-day mean (n ≥ 5), the feature set's note includes `regression: <phase> X.Xx slower than usual` so it's visible in the deploy indicator.

This is a **self-improvement signal**, not a user dashboard. The data flows into maestro's own decisions without surfacing a new UI.

### Pipeline hardening (2026-04)

The overnight loop (`local/daemon.js::runMergePipeline`) now runs all four phases atomically per feature set:

1. **Pre-merge tests** — run in the **primary AND every extra repo** that carries the branch (integration sets). A red test in any participant halts the whole pipeline with `status=test_failed`.
2. **Merge** — local `git merge --no-ff` across primary + extras; push to origin.
3. **Deploy** — sequential per project with `/api/status` health check. If any deploy fails, **every successful sibling is also rolled back** (fly rollback + git revert) so main doesn't drift across the repos that already merged. Status=`deploy_failed_reverted`.
4. **Integration tests** — post-deploy smoke against the just-shipped fleet.

Revert pushes are **verified** — after `git push origin main`, the daemon fetches and compares `origin/main` SHA against local HEAD. If they diverge (push failed, pre-commit hook on remote, etc.), a prominent warning is logged so the bad merge can't silently drift back in.

Workers have a **wall-clock guard** (`WORKER_MAX_MS`, default 60 min) so a stuck `claude -p` can't lock the project slot indefinitely.

Cancel: `POST /api/feature-sets/:id/cancel` sets a flag; `checkCancel` polls between every pipeline phase and aborts cleanly.

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
