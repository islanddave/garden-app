// cdp-socket.mjs — the one place that decides which WebSocket a layout gate attaches to Chrome with.
//
// WHY THIS EXISTS (OPS-LAYOUTGATESUNWIRED-001). Every gate in this directory opened its CDP session
// with a bare global `WebSocket`, on the header note "Node 22+ ships a global WebSocket, so this
// needs no dependency". True locally, false in CI: .github/workflows/ci.yml pins node-version
// '20.19.0', and 20.19.0 has no global WebSocket unless it is started with --experimental-websocket.
// MEASURED, not assumed, on this base:
//   npx node@20.19.0 -e "typeof WebSocket"                    -> undefined
//   node@20.19.0 scripts/layout-gate/save-band-clearance.mjs  -> FAIL "WebSocket is not defined", exit 1
// So these gates could not have been added to CI as they stood — they would have thrown at attach()
// after paying for a Vite boot and a Chrome launch. That toolchain gap is the whole reason
// gate:save-band and gate:log-chooser were real, passing, hand-run gates wired into no workflow,
// and why BUG-FRAMEPADOCCLUDE-001 — a weigh-in keypad whose bottom row committed the harvest —
// shipped to production and survived two releases before a human ran the gate by hand.
//
// PREFER THE GLOBAL. On Node 22+/26 this returns the exact same builtin the gates were authored and
// pass against, so nothing about a local run changes. `ws` is the CI-only fallback path.
//
// WHY `ws` IS NOW A DECLARED devDependency. It was already resolvable in node_modules, but only as a
// transitive of jsdom — a phantom dependency that disappears the day jsdom drops or swaps it, which
// would take these gates down with it and look like a Chrome problem. A gate's transport is not
// something to inherit by accident.
//
// IMPORT SHAPE. Resolve the BARE specifier, never node_modules/ws/index.js: ws's package `exports`
// maps `import` to wrapper.mjs (named + default exports) and `require` to index.js, which is CJS and
// raises "Named export 'WebSocket' not found" if a file path is imported directly.
export async function resolveWebSocket() {
  if (typeof globalThis.WebSocket === 'function') return globalThis.WebSocket
  const mod = await import('ws')
  return mod.WebSocket ?? mod.default
}
