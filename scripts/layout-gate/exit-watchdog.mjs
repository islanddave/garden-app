// exit-watchdog.mjs — names whatever keeps a layout gate alive after it has printed PASS.
//
// WHY THIS EXISTS. The gates that call this exit NATURALLY on the green path — they print PASS and
// run off the end of the module, with no process.exit(0) — so anything still holding Node's event
// loop turns into silent wall time rather than a failure. Eight of them idled 80-90 s per CI run
// that way (save-band-stability 169 s), 789 s of every build-and-test job, on per-call CDP timeouts
// that were armed and never cleared: PASS at 2-45 s, then node waiting for the last timer to fire.
// The timers are cleared on reply now; this is what stops the next leaked handle (a timer, a
// socket, a child's pipe, a server) from costing the same minutes unnoticed.
//
// HOW. Call armExitWatchdog() immediately after the PASS line. It arms an UNREF'D timer, and an
// unref'd timer cannot keep the event loop alive by itself: a process with nothing left to do exits
// at once and the watchdog never fires. It fires only if something ELSE is still holding the loop
// EXIT_WATCHDOG_MS after PASS, and then it says what on stderr and exits 1 — a named red instead of
// a quiet minute and a half.
//
// READING THE LIST. process.getActiveResourcesInfo() also names the process's own piped stdout and
// stderr ("PipeWrap", one each under `npm run`), which hold nothing open — a bare piped node reports
// the same one-per-stream and exits at once. The culprit is whatever ELSE is there. MEASURED
// 2026-10-02 on gate:inventory-list: a setInterval leaked after PASS reads
// ["PipeWrap","PipeWrap","Timeout"], and the old uncleared CDP timeouts read the two pipes plus ten
// "Timeout" — exit 1 at PASS + 15.0 s both times, against exit 0 at PASS + 0.0 s with neither.
//
// NOT process.exit(0) after PASS, deliberately. That would make the same wait disappear by hiding
// the handle that caused it, and a gate that cannot say why it is still running is the thing this
// directory exists to refuse.
import { basename } from 'node:path'

export const EXIT_WATCHDOG_MS = 15000

export function armExitWatchdog(script = basename(process.argv[1] ?? 'layout gate')) {
  const timer = setTimeout(() => {
    console.error(`[exit-watchdog] ${script}: process still alive ${EXIT_WATCHDOG_MS / 1000} s after PASS; active resources: ${JSON.stringify(process.getActiveResourcesInfo())}`)
    process.exit(1)
  }, EXIT_WATCHDOG_MS)
  timer.unref()
  return timer
}
