# Suite Integration Tests

These tests probe the **deployed** fleet to verify cross-app contracts still hold. They run automatically after every `merged_and_deployed` pipeline in the daemon (`processMergeRequests`), and can be run manually with:

```
cd ~/maestro && node --test --test-reporter=spec tests/integration/*.test.mjs
```

Environment needed (daemon inherits from its LaunchAgent env + `~/.suite/keys.env`):

| Var | Purpose |
|---|---|
| `SUITE_API_KEY` | Hits `/api/status` on all 5 apps |
| `COMMS_URL`, `GLOSS_URL`, `BLACK_URL`, `SCRIBE_URL`, `MAESTRO_URL` | Base URLs (defaults to `https://<fly-app>.fly.dev`) |

Optionally, for deep contract tests that need app-specific auth:

| Var | Purpose |
|---|---|
| `COMMS_API_KEY` | gloss→comms contact push |
| `GLOSS_API_KEY` | scribe→gloss linked collections |

When an optional key is missing, the related test is **skipped** (not failed) — the shape/reachability level still runs.

## What each file covers

| File | Integration point (# from SYSTEM.md) |
|---|---|
| `fleet-status.test.mjs` | #6 — maestro polls all 5 `/api/status` |
| `gloss-comms-contacts.test.mjs` | #1 — gloss→comms contact push endpoint |
| `scribe-gloss-collections.test.mjs` | #3 — scribe→gloss linked collections |
| `maestro-capture.test.mjs` | #7 — PWA→maestro capture intake |

If a worker adds a new integration point, it MUST add a test here before the feature set can ship green. Maestro's worker prompt references this directory.
