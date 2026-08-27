// src/lib/voiceCommitDebounce.js
//
// V5-HARVESTVOICEFLOW-001 (BD-068) — INVESTIGATION ARTIFACT, STILL UNWIRED. Nothing in src/ imports
// this but its own test file. Built on Dave's instruction after the on-device probe run of
// 2026-08-27, whose log is the fixture the tests replay (project-state/voiceflow-feasibility-V100
// -20260826.md §Device log, gardening-docs).
//
// WHY THIS EXISTS. The probe answered the question the feature hung on — Chrome Android re-arms the
// mic in 16-133 ms, gesture-free, with no permission re-prompt — and then surfaced a different
// problem that no amount of desk reasoning had predicted: THE RESULT STREAM IS NOISY AND
// NON-MONOTONIC. In 13 seconds of speaking four phrases, Chrome delivered:
//
//   * 11 finals with an EMPTY transcript;
//   * finals for a PREFIX of what Dave was still saying, superseded 195 ms and 353 ms later
//       6385ms FINAL "three"        ->  6580ms FINAL "three counts"
//      10323ms FINAL "231"          -> 10676ms FINAL "231 G"
//   * the same final twice — "231 G" at 10676 ms and again at 10950 ms.
//
// A consumer that acts on each final as it lands therefore searches for "three" and for "231", and —
// the serious case — fires save_and_advance TWICE off one spoken "next", silently skipping a
// planting. `isFinal` does not mean settled. This layer is what makes it mean settled.
//
// THE DUPLICATE IS THE VOICEDUPE BUG. Dave, 2026-08-27, on reading the probe log: "I suspect the
// 'emitted twice' is the same bug we've been chasing in the mic inputs for weeks." He is right, and
// the repo already proves it — `transcribe.js:183-185` carries an explicit guard whose own comment
// reads "Byte-identical re-delivery: not new speech, nothing changed, drop it entirely", added for
// BUG-VOICEDUPE-003 after his 2026-08-24 "bitter bitter melon" report. So Chrome genuinely
// re-delivers a final at the SAME result index, and a consumer that appends turns that into a
// doubled WORD ("Chinese Chinese") while a consumer that acts turns it into a doubled ACTION. Same
// root cause, two symptoms, seen at two layers. The probe reproduced it because it iterates
// `ev.results` from `ev.resultIndex` exactly as transcribe.js does but WITHOUT the slot guard — an
// earlier note in this investigation hedged that the duplicate might be a probe artifact; it is not,
// and that hedge is withdrawn.
//
// WHAT THE EXISTING FIX CANNOT COVER, and the reason this layer needs its own cross-session defence:
// `finalsByIndex` is declared INSIDE startLiveTranscription (transcribe.js:134), so it is PER
// SESSION and resets on every re-arm. For the single-capture flow it was written for — one session
// per press-and-hold — that is complete. In a continuous flow re-arming every 16-133 ms it is not:
// a duplicate that lands in the NEXT session meets a fresh, empty slot map at index 0 and passes the
// guard untouched. The measured duplicate gap was 274 ms and the measured re-arm gap 16-133 ms, so a
// duplicate crossing a session boundary is not hypothetical — it is well inside the observed range.
// That gap is exactly what DEFAULT_COMMAND_COOLDOWN_MS below closes, and it is why the cooldown is
// keyed on wall-clock rather than on session identity.
//
// THE ONE INVARIANT WORTH STATING UP FRONT, because every rule below serves it: an utterance commits
// AT MOST ONCE, and only after nothing has superseded it. Dave's own framing — "a silent wrong save
// is worse than a slow form" — decides every tie in favour of committing later or not at all.
//
// PURE STATE MACHINE, TIME PASSED IN. There is no clock and no timer here: every entry point takes
// the timestamp as an argument. That is what lets the tests replay the device log literally, at its
// real inter-event gaps, with no fake timers and no flake — the fixture IS the evidence. A
// production host would own the timer and call `tick()`; `dueAt()` tells it when. That host is
// deliberately NOT built (BD-068: "do not ship a half-flow off this row").
import { classify, normalise } from './voiceHarvestGrammar.js'

// Settle window. The observed supersede gaps were 195 ms and 353 ms, so 500 ms clears both with
// margin. It is the single latency/safety dial: shorter feels quicker and risks committing a prefix,
// longer is safer and adds dead time between "next" and the following chooser.
export const DEFAULT_SETTLE_MS = 500

// A command that commits cannot commit again for this long. This is the ONLY defence against the
// duplicate-final case, and it has to be cross-session: the duplicate "231 G" arrived 274 ms after
// its twin, and at a 16-133 ms re-arm a duplicate can easily land in the NEXT session, where the
// pending-supersede logic cannot see it. The cost is that a genuine double "next" inside 1.5 s is
// swallowed and Dave says it again; the cost of the alternative is two saves and a skipped planting
// he never sees. Not symmetric, so not a tunable.
export const DEFAULT_COMMAND_COOLDOWN_MS = 1500

/**
 * @param {object}   opts
 * @param {function} opts.onCommit  (result, meta) => void — fires ONCE per settled utterance.
 * @param {function} [opts.onPending] (result|null) => void — the not-yet-committed utterance, for a
 *   live echo. This is the channel a confirmation UI would read (investigation question 4, still
 *   undecided); it is offered because the debounce is what makes such an echo honest — before this,
 *   there was no moment at which "what is about to be saved" was a stable value.
 * @param {number}   [opts.settleMs]
 * @param {number}   [opts.commandCooldownMs]
 */
// Which verbs MUTATE, grouped by what they mutate. The cooldown is keyed on this class rather than
// on the command string: `next` and `save` are different strings that both write a harvest row, and
// keying on the string let one spoken word heard two ways commit twice 300ms apart (measured).
// A verb absent from this map is non-destructive and is never cooldown-suppressed.
export const WRITE_CLASS = {
  save_and_advance: 'write',
  save: 'write',
  discard: 'destroy',
}

export function createCommitDebouncer({
  onCommit,
  onPending = null,
  onSuppressed = null,
  onCommitError = null,
  settleMs = DEFAULT_SETTLE_MS,
  commandCooldownMs = DEFAULT_COMMAND_COOLDOWN_MS,
  staleMs = DEFAULT_SETTLE_MS * 2,
} = {}) {
  const isWrite = (r) => r.kind === 'command' && !!WRITE_CLASS[r.command]
  let pending = null          // { text, norm, result, atMs }
  let lastWrite = null        // { klass, atMs } — see WRITE_CLASS
  const stats = {
    staleDropped: 0,
    droppedEmpty: 0, superseded: 0, regressed: 0, suppressedCommands: 0, committed: 0, commitErrors: 0,
  }

  const reportPending = () => {
    // Wrapped for the same reason transcribe.js wraps every consumer callback (:196, :212, :221):
    // this fires from inside the recogniser's own handlers, and a throwing host must not be able to
    // kill the session. The layer was asymmetric with the seam it sits beside; measured by the
    // crucible's qa seat, which showed a throwing handler propagating out of sessionEnd().
    if (!onPending) return
    try { onPending(pending ? pending.result : null) } catch { /* host's problem, not the mic's */ }
  }

  function commit(atMs) {
    if (!pending) return
    const { result } = pending
    pending = null

    // COOLDOWN KEYS ON THE WRITE CLASS, NOT THE COMMAND STRING. Measured defect: `next` and `save`
    // are different strings that both WRITE, so "next" at t and "save" at t+300 both committed —
    // one spoken word heard two ways double-writes. Every verb that mutates shares one slot.
    const klass = result.kind === 'command' ? WRITE_CLASS[result.command] : null
    if (klass) {
      if (lastWrite && lastWrite.klass === klass && (atMs - lastWrite.atMs) < commandCooldownMs) {
        stats.suppressedCommands += 1
        reportPending()
        // A swallowed command with no signal is indistinguishable from a dead mic, an unheard
        // utterance, or a failed save. The host needs to be able to say which.
        if (onSuppressed) { try { onSuppressed(result, 'cooldown') } catch { /* ignore */ } }
        return
      }
    }

    reportPending()

    // ARM THE COOLDOWN ONLY ON A HANDLER THAT RETURNED. Previously `lastCommand` was set BEFORE
    // onCommit, so a save that FAILED still armed the cooldown and swallowed the user's natural
    // recovery — saying it again — for 1500ms. Measured. The cooldown now defends against a
    // transport duplicate without also defending against a human retry.
    try {
      onCommit(result, { atMs })
    } catch (err) {
      stats.commitErrors += 1
      if (onCommitError) { try { onCommitError(result, err) } catch { /* ignore */ } }
      return   // NOT armed — the write did not happen, so a repeat is legitimate.
    }
    if (klass) lastWrite = { klass, atMs }
    stats.committed += 1
  }

  return {
    /**
     * A final result from the recogniser. `tMs` is the event's timestamp.
     */
    final(text, tMs) {
      const norm = normalise(text)

      // 1. EMPTY FINALS — 11 of them in a 13-second run. Dropped before anything else, so they can
      //    neither commit, supersede, nor restart a settle window.
      if (!norm) { stats.droppedEmpty += 1; return }

      const result = classify(text)

      if (pending) {
        // 2. SUPERSEDE. A later final whose text EXTENDS the pending one is the same utterance,
        //    more completely heard — replace it and restart the window. Identical text is a prefix
        //    of itself, so this is also the in-session de-duplication: "231 G" twice replaces once
        //    and commits once.
        //
        //    This is also the rule that makes a premature COMMAND safe, which is the whole point:
        //    a bare "next" pends rather than saving, and if the utterance was really "next to the
        //    fence" the extension arrives inside the window and the pending command is replaced by
        //    a search. Without the window, that save has already happened.
        if (norm !== pending.norm && norm.startsWith(pending.norm)) {
          stats.superseded += 1
          pending = { text, norm, result, atMs: tMs }
          reportPending()
          return
        }
        if (norm === pending.norm) {
          // Exact repeat: refresh the window without counting a supersede, so a stream of identical
          // finals cannot commit twice and cannot inflate the supersede stat.
          stats.superseded += 1
          pending = { text, norm, result, atMs: tMs }
          reportPending()
          return
        }
        // 3. REGRESSION — the new final is a TRUNCATION of what is pending ("three counts" then
        //    "three"). DEFENSIVE, NOT OBSERVED: it did not occur in the device log, and it is
        //    handled by keeping the longer pending text rather than by trusting arrival order,
        //    because the alternative silently downgrades a fully-heard utterance to a partial one.
        if (pending.norm.startsWith(norm)) { stats.regressed += 1; return }

        // 4. A genuinely different utterance. The pending one is finished — commit it, then pend
        //    the new one. This is what keeps two real phrases inside one session from collapsing.
        commit(tMs)
      }

      pending = { text, norm, result, atMs: tMs }
      reportPending()
    },

    /**
     * The recogniser's session ended. Chrome fires this 1-2 ms after the last final of an utterance
     * (measured), so it is a genuine utterance boundary.
     *
     * DATA FLUSHES HERE; A WRITE COMMAND DOES NOT. The earlier version flushed everything, and that
     * was wrong in a way only measurement showed: Chrome ends the session after EVERY utterance, so
     * `sessionEnd` is the DOMINANT commit path — replaying the device log through a real host timer
     * produced 4 commits via sessionEnd and ZERO via tick. The 500ms settle window never executed
     * once in the whole evidence base, which means the design's own "single most valuable
     * behaviour" — a bare "next" pending rather than saving, so "next to the fence" can supersede it
     * — was unreachable for the command axis. A session boundary landing between a command-word
     * prefix and its continuation committed an unrequested SAVE.
     *
     * So the asymmetry the rest of this file argues for is now actually paid: data commits
     * immediately (no cost, nothing destructive), and a write command waits out the full window,
     * which is the only thing that makes the supersede rule real rather than aspirational. It costs
     * 500ms on the destructive verb alone, and it converts an assumption about Chrome's
     * emulated-continuous path into a guarantee.
     */
    sessionEnd(tMs) {
      if (pending && pending.result.kind === 'command' && WRITE_CLASS[pending.result.command]) return
      commit(tMs)
    },

    /**
     * Drive the settle window. A host calls this from a timer; `dueAt()` says when.
     *
     * A PENDING WRITE PAST ITS STALENESS BOUND IS DISCARDED, NOT COMMITTED. Measured: before this,
     * `tick(60000)` on a write pended at t=0 committed a SIXTY-SECOND-OLD save_and_advance, stamped
     * with the tick's own timestamp. That became reachable only when write commands started waiting
     * out the window instead of flushing at sessionEnd — a defect introduced by the fix before it.
     * A commit later than the window is not a settled utterance, it is a resurrected one, and on a
     * platform that freezes timers on hidden pages it would fire against whatever planting is on
     * screen when the page wakes.
     */
    tick(tMs) {
      if (!pending) return
      const age = tMs - pending.atMs
      if (age < settleMs) return
      if (isWrite(pending.result) && age > staleMs) {
        const dropped = pending.result
        pending = null
        stats.staleDropped += 1
        reportPending()
        if (onSuppressed) { try { onSuppressed(dropped, 'stale') } catch { /* ignore */ } }
        return
      }
      commit(tMs)
    },

    /** When the pending utterance would commit on its own, or null. */
    dueAt() { return pending ? pending.atMs + settleMs : null },

    /** The utterance awaiting settle — what a confirmation UI would show. */
    peek() { return pending ? pending.result : null },

    /**
     * Drop the in-flight utterance.
     *
     * NO LONGER SAFE ON THE DESTRUCTIVE PATH, and the docstring used to claim it was. Once write
     * commands began waiting out the settle window instead of flushing at sessionEnd, the window in
     * which this silently destroys a REQUESTED save went from ~2 ms to >=500 ms — and the four hosts
     * named below are exactly the ones that fire inside it. A host that calls this while a write is
     * pending is cancelling a save the user asked for, with no signal. Check `peek()` first, or
     * commit it. Pinned as characterisation in the test file rather than papered over.
     *
     * Safe for every in-flow transition on the DATA path — a chooser re-opening, a route change, the
     * hook unmounting, the echo clearing.
     *
     * THIS IS THE ONE THAT HOSTS WILL REACH FOR, so it is the one that must not disarm anything.
     * The previous single `reset()` cleared the cooldown too, and that was a live footgun on the
     * destructive path: measured, a reset() between two "next"s 276ms apart let BOTH commit — a
     * double save — where without it the second was correctly suppressed. Every natural host
     * implementation (clear the echo, clean up on unmount) calls exactly this, so the safe operation
     * had to become the obvious one and the dangerous one had to be named.
     */
    resetPending() { pending = null; reportPending() },

    /**
     * Drop everything INCLUDING the duplicate-suppression memory. Only for a deliberate mic-off,
     * where the next utterance is genuinely a new intent and must not be eaten as a duplicate.
     * Never call this on a route change, an unmount, a chooser re-open, or after a save.
     */
    resetSession() { pending = null; lastWrite = null; reportPending() },

    /**
     * Release the cooldown for a write that did NOT take effect — the save-failure path calls this.
     * `commit` already declines to arm on a throwing handler, but a handler that resolves and THEN
     * discovers the POST failed (the async case, which is the common one) needs to say so.
     * Without it the user's natural recovery — say "next" again — is swallowed for 1500ms, which is
     * inside the human retry interval and turns a recoverable failure into an unrecoverable one.
     */
    invalidateLastWrite(token) {
      // TOKEN-SCOPED, and it must be. Measured race in the identity-free version: save A commits,
      // save B legitimately commits after the cooldown expires, THEN A's async POST fails and the
      // host calls this — clearing the cooldown B armed, so a transport duplicate of B is admitted.
      // Three commits where two are correct: a double save of B, caused by A's failure. The token is
      // the `atMs` the host already receives in onCommit's meta.
      if (token != null && (!lastWrite || lastWrite.atMs !== token)) return
      lastWrite = null
    },

    stats() { return { ...stats } },
  }
}
