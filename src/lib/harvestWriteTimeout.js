// BUG-HARVESTTIMEOUT-001 — how long a harvest write waits for the events Lambda.
//
// apiFetch gives up at API_TIMEOUT_MS (15s) by default, but garden-events is allowed 30s
// (scripts/lambda-config-expected.json). A harvest save that took 15–30s was therefore reported as
// "Request timed out" while the server went on to commit the row, and nothing in the UI could tell
// the two apart. 35s sits just above the server's own limit, so the client hears the real answer —
// the saved row or the gateway's timeout error — instead of aborting first. Passed per call as
// options.timeoutMs; the global default is unchanged.
//
// Lives in its own module, not in api.js: the page tests mock '../lib/api.js' down to useApiFetch,
// and a constant imported from there would be undefined in every one of them.
export const HARVEST_WRITE_TIMEOUT_MS = 35000
