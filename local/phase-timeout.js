// M-I-05 — per-phase timeout helper for runMergePipeline.
//
// Wraps a phase promise with a race: if the phase exceeds `ms`, reject with
// a typed error so the pipeline can abort cleanly instead of hanging
// forever. Extracted to its own file so the tests can import without
// side-effects from daemon.js (which starts main() on import).
//
// Call-site wiring in runMergePipeline deferred — see Maestro
// recommendation filed on the overnight run.

export const DEFAULT_PHASE_TIMEOUT_MS = Number(process.env.MAESTRO_PHASE_TIMEOUT_MS) || 180_000;

export async function withPhaseTimeout(phaseName, phasePromise, ms = DEFAULT_PHASE_TIMEOUT_MS) {
  let t;
  const timeoutPromise = new Promise((_, reject) => {
    t = setTimeout(() => {
      const err = new Error(`[pipeline] phase ${phaseName} timed out after ${ms}ms`);
      err.code = 'PHASE_TIMEOUT';
      err.phase = phaseName;
      reject(err);
    }, ms);
  });
  try {
    return await Promise.race([phasePromise, timeoutPromise]);
  } finally {
    clearTimeout(t);
  }
}
