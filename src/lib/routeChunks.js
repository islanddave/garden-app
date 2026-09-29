// Split page chunks for routes reached only from More: /season-stats (Season stats + the stats-kit
// charts, ~20KB gzip that sat in the entry chunk) and /sources/:id (source edit).
//
// Same shape as ./collectionChunk.js, and for the same reason: a plain import() whose failure is a
// VALUE (null), never React.lazy. React.lazy caches a rejected payload permanently, so one dead spot
// mid-tap would make the page unreachable for the session (V4-LAZYRETRY-001; the full citation into
// the installed React source is in collectionChunk.js). Here a failed load leaves `cached` null and
// `inflight` cleared, so the next load() is a genuinely new import().
//
// Module-scope cache per chunk: once a page lands, later mounts resolve synchronously via peek() at
// first render and navigating back does not flash the loading state.
function pageChunk(importer) {
  let cached = null
  let inflight = null
  return {
    peek: () => cached,
    // Idempotent and concurrency-safe; never rejects.
    load() {
      if (cached) return Promise.resolve(cached)
      if (inflight) return inflight
      inflight = importer()
        .then((m) => {
          cached = m.default ?? m
          return cached
        })
        .catch(() => null)
        .finally(() => { inflight = null })
      return inflight
    },
    // Test seam only — the module cache would otherwise leak a loaded chunk across test files.
    __reset() {
      cached = null
      inflight = null
    },
  }
}

export const seasonStatsChunk = pageChunk(() => import('../pages/SeasonStats.jsx'))
export const sourceEditChunk = pageChunk(() => import('../pages/SourceEdit.jsx'))
