# Suite System Map

This file is the ground-truth description of how the five personal apps fit together. Maestro's router loads it at daemon startup and injects it into Gemini prompts so routing decisions can honor cross-app context. Workers read it when their feature set touches an integration point.

Keep this file accurate. If you add/remove an app or integration, update here before you commit.

---

## The fleet

| App | Dir | Fly app | Port (local) | Primary DB |
|---|---|---|---|---|
| **comms** | `/Users/nathancolestock/comms` | `comms-nc` | 3748 | `/data/comms.db` |
| **gloss** | `/Users/nathancolestock/gloss` | `gloss-nc` | (see fly.toml) | `/data/gloss.db` (file name may be `foxed.db` historically — the Litestream replica masks it) |
| **black** | `/Users/nathancolestock/black` | `black-hole` | 3749 | `/data/index.db` |
| **scribe** | `/Users/nathancolestock/scribe` | `scribe-nc` | (see fly.toml) | `/data/scribe.db` |
| **maestro** | `/Users/nathancolestock/maestro` | `maestro-nc` (cloud only) | (cloud: 3750; daemon: local only) | cloud `/data/maestro.db` |

All five back up SQLite to Cloudflare R2 (`nathan-suite-backups` bucket) via Litestream. Gloss additionally rclones scan images daily.

Every app exposes:
- `GET /api/health` — no auth, returns `{ ok: true, now: <ms> }`
- `GET /api/status` — Bearer auth (accepts the app's `API_KEY` OR the shared `SUITE_API_KEY`), returns `{ app, version, ok, uptime_seconds, metrics: { ... } }`

---

## Auth model

- Every app has its own `API_KEY` for inbound auth.
- A shared `SUITE_API_KEY` is accepted on `/api/status` so maestro can poll the fleet without knowing each app's `API_KEY`.
- Caller → callee headers: `Authorization: Bearer <callee's API_KEY>`. Legacy `X-API-Key` header is still accepted inbound on all apps for backward compat but not emitted by new code.

Env vars the caller side needs:
- comms calls nothing outbound (it's a hub)
- gloss calls comms → needs `COMMS_URL`, `COMMS_API_KEY`
- black calls comms and gloss → needs `COMMS_URL`, `COMMS_API_KEY`, `GLOSS_URL`, `GLOSS_API_KEY`
- scribe calls gloss → needs `GLOSS_URL`, `GLOSS_API_KEY`
- maestro calls all five `/api/status` → needs `SUITE_API_KEY`

---

## Integration points (the cross-app contracts)

| # | From | To | Surface | Purpose |
|---|---|---|---|---|
| 1 | gloss | comms | `POST /api/gloss/contacts` | Push contact profiles from gloss into comms when people are created/edited |
| 2 | gloss | comms | `POST /api/gloss/notes` | Push gloss note metadata into comms (optional legacy surface) |
| 3 | scribe | gloss | `GET /api/collections`, `POST /api/collections/:id/links` | Link scribe documents to gloss collections |
| 4 | black | comms | `GET /api/contacts/search` | Enrich search hits with contact context |
| 5 | black | gloss | `GET /api/pages/search` | Deep-link from black search to matching gloss pages |
| 6 | maestro | all 5 | `GET /api/status` | Fleet health polling; appears in iPhone dashboard |
| 7 | PWA → maestro-cloud | — | `POST /api/capture` | iPhone capture intake (offline-queued in SW) |
| 8 | maestro-daemon ↔ maestro-cloud | — | multiple `/api/*` | Daemon poll/state sync |

Each integration has (or should have) a contract doc at `docs/INTEGRATIONS/<slug>.md` in the primary repo (the owner of the endpoint) and a matching integration test at `maestro/tests/integration/<slug>.test.mjs`.

---

## Autonomous pipeline states

A feature set moves through these statuses (enforced softly — the daemon is trusted):

```
collecting → queued → running → {done, needs_answer, failed}
  done (AUTO_MERGE_ON_TESTS_PASS=true OR user taps merge)
    → merge_requested → test_failed            (pre-merge tests red → halt)
                      → merge_failed           (git merge conflict → halt)
                      → merged                  (old: user-initiated local merge only)
                      → merged_and_deployed     (full pipeline success)
                      → deploy_failed_reverted  (post-deploy health fail → Fly + git rolled back)
                      → integration_failed      (post-deploy integration tests red)
```

The daemon's `processMergeRequests` owns the critical path: pre-merge test → merge → deploy (with health check) → post-deploy integration test → mark terminal status.

---

## Deploy topology

Each app: `fly deploy -a <fly-app>` from its directory (for maestro, from `cloud/`). The daemon's `deployer.js` wraps this with a `/api/status` health check and auto-revert on failure (`fly releases rollback` + `git revert -m 1`).

---

## Where to look for things

| Need to... | Look at |
|---|---|
| Add a new cross-app endpoint | Write contract doc + integration test first, then both sides |
| Rename/move an app | Update `local/project-scanner.js`, `local/executor.js` (PROJECT_PATHS + FLY_DEPLOY_MAP), this file, and all cross-link READMEs |
| Add a new app to the suite | Same as rename, plus add to the project list in this file and integration tests |
| Debug an overnight run | `~/maestro/local/daemon.log` + `fly logs -a <app>` for each app touched |
| Change what `/api/status` returns | That app's `server.js` — keep shape `{ app, version, ok, uptime_seconds, metrics }` |

---

## Non-negotiables

1. **No broken prod**: the daemon auto-reverts on deploy health failure. Do not remove this.
2. **Tests before commits**: workers must run project tests before each commit.
3. **SUITE_API_KEY is shared, not per-app** — rotate it on all 5 Fly apps together.
4. **Secrets never committed** — `.env*` is gitignored in every repo; `~/.suite/*.env` is where local references live.
