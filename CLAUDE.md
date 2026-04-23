# Maestro

Orchestration layer for Nathan's Claude Code workflow. Accepts voice/text captures from iPhone, understands all active projects and Claude sessions, decomposes and routes tasks intelligently.

## Architecture

Three-tier system:
- **cloud/** — Railway-deployed relay. Always-on Express + SQLite. Stores capture queue and last-known project state. Serves the PWA.
- **local/** — Laptop daemon. Reads `.claude/projects/` for active sessions, scans project CLAUDE.md + git log, uses Claude API to route captures, writes to tasks.md and CLAUDE.md files.
- **web/** — React + Vite PWA. Built to `cloud/public/`. Voice capture via Web Speech API. iPhone add-to-home-screen.

## Setup

### Cloud (Railway)
```bash
cd cloud && npm install
# Deploy: railway up
# Set env vars in Railway dashboard:
#   MAESTRO_SECRET=<random string>
#   PORT=3750
```

### Local Daemon
```bash
cd local && npm install
cp .env.example .env
# Edit .env:
#   ANTHROPIC_API_KEY=sk-ant-...
#   MAESTRO_CLOUD_URL=https://your-app.railway.app
#   MAESTRO_SECRET=<same string as Railway>
node daemon.js
```

### PWA (build)
```bash
cd web && npm install
npm run build   # outputs to cloud/public/
```

### PWA (dev)
```bash
# In one terminal: cd cloud && node server.js
# In another:      cd web && npm run dev
# Open http://localhost:5173
```

## Tracked Projects

Edit `local/project-scanner.js` PROJECTS array to add/remove projects.
Edit `local/executor.js` PROJECT_PATHS to match.

Current projects: flock, gloss, tend, comms, maestro, scribe, black.

## Key Files

| File | Purpose |
|------|---------|
| `cloud/server.js` | Express API + PWA server |
| `cloud/db.js` | SQLite schema |
| `local/daemon.js` | Main polling loop |
| `local/project-scanner.js` | Reads CLAUDE.md + git per project |
| `local/session-reader.js` | Detects active Claude Code sessions |
| `local/router.js` | Claude API routing + decomposition |
| `local/executor.js` | Writes tasks.md / CLAUDE.md |
| `web/src/Capture.jsx` | Voice + text input screen |
| `web/src/Dashboard.jsx` | Project status screen |

## API Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | /api/capture | yes | Store capture from iPhone |
| GET | /api/queue | yes | Daemon polls unprocessed captures |
| POST | /api/queue/:id/ack | yes | Mark processed |
| GET | /api/captures | yes | Recent captures with routing |
| GET | /api/projects | yes | Project + session state |
| POST | /api/state | yes | Daemon pushes state snapshot |
| POST | /api/tasks | yes | Store routed task |

## Session Detection

The daemon reads `~/.claude/projects/<encoded-path>/*.jsonl` files. If `mtime < 5 minutes`, the session is considered active. The encoded path is the project's filesystem path with `/` replaced by `-`.

## Future

- AUTO_LAUNCH_SESSIONS=true: daemon spawns `claude` CLI for idle projects
- SSE/WebSocket push for real-time iPhone updates
- Automatic CLAUDE.md regeneration from git history
- Extend to comms/tend Railway deployments (replacing ngrok)


## Context Notes

- [2026-04-23 17:37] Integration test probe.

- [2026-04-23 17:35] User issued a 'probe' command. Investigate the intended meaning and appropriate system response for such terse inputs.

- [2026-04-23 17:19] Verified that the Maestro router successfully accepts captures and creates feature sets, confirming the full autonomous pipeline is live.

- [2026-04-23 14:30] Recorded a test capture as part of deploy verification for the Maestro system.
