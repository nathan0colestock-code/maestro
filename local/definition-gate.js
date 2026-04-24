// SPEC 7 gate matcher — pure function extracted so unit tests can exercise
// it without importing daemon.js (which would kick off the loop).
//
// A feature set has an approved definition thread when the thread matches
// by title (case-insensitive substring) OR by overlapping affected_apps
// (≥2 shared apps — enough to identify the same cross-app feature).

export function matchThreadToSet(set, threads) {
  if (!Array.isArray(threads) || threads.length === 0) return null;
  const setTitle = String(set?.title || '').trim().toLowerCase();
  const setProjects = new Set(
    [set?.project_name, ...(Array.isArray(set?.extra_projects) ? set.extra_projects : [])]
      .filter(Boolean)
  );

  for (const t of threads) {
    if (t?.status && t.status !== 'approved') continue;
    const tTitle = String(t?.feature_title || '').trim().toLowerCase();
    if (setTitle && tTitle && (tTitle === setTitle || tTitle.includes(setTitle) || setTitle.includes(tTitle))) {
      return t;
    }
    if (Array.isArray(t?.affected_apps)) {
      const overlap = t.affected_apps.filter(a => setProjects.has(a));
      if (overlap.length >= 2) return t;
    }
  }
  return null;
}
