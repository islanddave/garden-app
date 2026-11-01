// src/lib/voiceCommitDebounce.js
//
// V5-HARVESTVOICEFLOW-001 (BD-068): investigation artifact, still UNWIRED (only its test file imports it).
// The tests replay the on-device probe log (project-state/voiceflow-feasibility-V100-20260826.md,
// gardening-docs) as a fixture.
//
// WHY THIS EXISTS. Chrome Android re-arms the mic in 16-133 ms, but THE RESULT STREAM IS NOISY AND
// NON-MONOTONIC. In 13 s of speech it delivered:
//   * 11 finals with an EMPTY transcript;
//   * finals for a PREFIX of what was still being said, superseded 195 ms and 353 ms later
//       6385ms FINAL "three"  ->  6580ms FINAL "three counts"
//   * the same final twice ("231 G" at 10676 ms and again at 10950 ms).
// A consumer acting on each final would search for "three" and, the serious case, fire save_and_advance
// TWICE off one spoken "next", silently skipping a planting. `isFinal` does not mean settled; this layer
// makes it mean settled.
//
// The duplicate is the BUG-VOICEDUPE class: Chrome re-delivers a final at the SAME result index. A
// consumer that appends turns it into a doubled WORD, one that acts turns it into a doubled ACTION.
// transcribe.js guards the append case (BUG-VOICEDUPE-003), but `finalsByIndex` is declared INSIDE
// startLiveTranscription, so it is PER SESSION. In a continuous flow re-arming every 16-133 ms, a
// duplicate landing in the NEXT session (measured duplicate gap 274 ms) meets a fresh empty slot map and
// passes. DEFAULT_COMMAND_COOLDOWN_MS closes that gap, and is keyed on wall-clock, not session identity.
//
// THE INVARIANT: an utterance commits AT MOST ONCE, and only after nothing has superseded it. "A silent
// wrong save is worse than a slow form" decides every tie in favour of committing later or not at all.
//
// PURE STATE MACHINE, TIME PASSED IN. There is no clock or timer here: every entry point takes the
// timestamp as an argument, so the tests replay the device log at its real gaps with no fake timers. A
// production host would own the timer and call `tick()`; `dueAt()` says when. That host is deliberately
// NOT built (BD-068: do not ship a half-flow off this row).
import { classify, normalise, splitTrailingCommand } from './voiceHarvestGrammar.js'

// Settle window. The observed supersede gaps were 195 ms and 353 ms, so 500 ms clears both. It is the
// single latency/safety dial: shorter risks committing a prefix, longer adds dead time before the next
// chooser.
export const DEFAULT_SETTLE_MS = 500

// A command that commits cannot commit again for this long. This is the ONLY defence against the
// duplicate-final case, and it must be cross-session: a duplicate can land in the NEXT session, where the
// pending-supersede logic cannot see it. The cost is that a genuine double "next" inside 1.5 s is
// swallowed and has to be re-said; the alternative is two saves and a skipped planting nobody sees.
// Not symmetric, so not a tunable.
export const DEFAULT_COMMAND_COOLDOWN_MS = 1500

// Which verbs MUTATE, grouped by what they mutate. The cooldown is keyed on this class, not on the
// command string: `next` and `save` are different strings that both write a harvest row, and keying on
// the string let one word heard two ways commit twice. A verb absent here is non-destructive and is
// never cooldown-suppressed.
export const WRITE_CLASS = {
  save_and_advance: 'write',
  save: 'write',
  discard: 'destroy',
}

/**
 * @param {object}   opts
 * @param {function} opts.onCommit  (result, meta) => void — fires ONCE per settled utterance.
 * @param {function} [opts.onPending] (result|null) => void — the not-yet-committed utterance, for a
 *   live echo. This is the channel a confirmation UI would read (investigation question 4, still
 *   undecided); the debounce is what makes such an echo honest.
 * @param {function} [opts.onSuppressed] (result, 'cooldown'|'stale') => void — a command that was swallowed.
 * @param {function} [opts.onCommitError] (result, err) => void — onCommit threw.
 * @param {number}   [opts.settleMs]
 * @param {number}   [opts.commandCooldownMs]
 * @param {number}   [opts.staleMs] a pending write older than this at tick() is discarded, not committed.
 */
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
    // Wrapped like every consumer callback in transcribe.js: this fires from inside the recogniser's own
    // handlers, and a throwing host must not be able to kill the session.
    if (!onPending) return
    try { onPending(pending ? pending.result : null) } catch { /* host's problem, not the mic's */ }
  }

  function commit(atMs) {
    if (!pending) return
    const { result } = pending
    pending = null

    // COOLDOWN KEYS ON THE WRITE CLASS, NOT THE COMMAND STRING: "next" at t and "save" at t+300 are
    // different strings that both WRITE, so one spoken word heard two ways would double-write. Every verb
    // that mutates shares one slot.
    // V5-VOICEONEBREATH-002: A ONE-BREATH UTTERANCE WRITES, SO IT HOLDS THE SAME SLOT. "cucumber three count
    // 231 grams next" classifies as `search` (the command is not the whole utterance), so on the rule above
    // it would take klass=null and get NO cooldown while performing the write a bare "next" performs. A
    // repeated final would then write two harvest rows (BUG-VOICEDUPE-001..005 recorded five such
    // recurrences). So the trailing command claims the slot too.
    const trailing = result.kind === 'command' ? null : splitTrailingCommand(result.transcript)
    const klass = result.kind === 'command'
      ? WRITE_CLASS[result.command]
      : (trailing?.command ? WRITE_CLASS[trailing.command] : null)
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

    // ARM THE COOLDOWN ONLY ON A HANDLER THAT RETURNED: a save that FAILED must not swallow the user's
    // natural recovery (saying it again) for the cooldown. It defends against a transport duplicate, not a
    // human retry.
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

      // 1. EMPTY FINALS are dropped first, so they can neither commit, supersede, nor restart a settle window.
      if (!norm) { stats.droppedEmpty += 1; return }

      const result = classify(text)

      if (pending) {
        // 2. SUPERSEDE. A later final whose text EXTENDS the pending one is the same utterance, more
        //    completely heard: replace it and restart the window. Identical text is a prefix of itself, so
        //    this is also the in-session de-duplication ("231 G" twice replaces once and commits once).
        //
        //    It is also what makes a premature COMMAND safe: a bare "next" pends rather than saving, and if
        //    the utterance was really "next to the fence" the extension arrives inside the window and
        //    replaces the pending command with a search.
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
        // 3. REGRESSION: the new final is a TRUNCATION of what is pending ("three counts" then "three").
        //    DEFENSIVE, NOT OBSERVED. Keep the longer pending text rather than trusting arrival order, which
        //    would silently downgrade a fully-heard utterance to a partial one.
        if (pending.norm.startsWith(norm)) { stats.regressed += 1; return }

        // 4. A genuinely different utterance. The pending one is finished — commit it, then pend
        //    the new one. This is what keeps two real phrases inside one session from collapsing.
        commit(tMs)
      }

      pending = { text, norm, result, atMs: tMs }
      reportPending()
    },

    /**
     * The recogniser's session ended. Chrome fires this 1-2 ms after the last final of an utterance, so it
     * is a genuine utterance boundary.
     *
     * DATA FLUSHES HERE; A WRITE COMMAND DOES NOT. Chrome ends the session after EVERY utterance, so
     * `sessionEnd` is the DOMINANT commit path (replaying the device log gave 4 commits via sessionEnd and
     * ZERO via tick). Flushing everything here meant the settle window never ran, so a bare "next" could not
     * pend and "next to the fence" could not supersede it: a session boundary between a command-word prefix
     * and its continuation committed an unrequested SAVE. So data commits immediately (nothing destructive)
     * and a write command waits out the full window, at a cost of 500ms on the destructive verb alone.
     */
    sessionEnd(tMs) {
      if (pending && pending.result.kind === 'command' && WRITE_CLASS[pending.result.command]) return
      commit(tMs)
    },

    /**
     * Drive the settle window. A host calls this from a timer; `dueAt()` says when.
     *
     * A PENDING WRITE PAST ITS STALENESS BOUND IS DISCARDED, NOT COMMITTED. Otherwise `tick(60000)` on a
     * write pended at t=0 commits a sixty-second-old save_and_advance stamped with the tick's own timestamp
     * (reachable because write commands wait out the window instead of flushing at sessionEnd). A commit
     * later than the window is a resurrected utterance, and on a platform that freezes timers on hidden
     * pages it would fire against whatever planting is on screen when the page wakes.
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
     * NOT SAFE ON THE DESTRUCTIVE PATH: write commands wait out the settle window (>=500 ms), so a host that
     * calls this while a write is pending silently cancels a save the user asked for. Check `peek()` first,
     * or commit it. Pinned as characterisation in the test file.
     *
     * Safe for every in-flow transition on the DATA path: a chooser re-opening, a route change, the hook
     * unmounting, the echo clearing.
     *
     * This is the one hosts reach for, so it must not disarm anything: clearing the cooldown too let two
     * "next"s 276ms apart BOTH commit (a double save). The dangerous variant is resetSession().
     */
    resetPending() { pending = null; reportPending() },

    /**
     * Drop everything INCLUDING the duplicate-suppression memory. Only for a deliberate mic-off,
     * where the next utterance is genuinely a new intent and must not be eaten as a duplicate.
     * Never call this on a route change, an unmount, a chooser re-open, or after a save.
     */
    resetSession() { pending = null; lastWrite = null; reportPending() },

    /**
     * Release the cooldown for a write that did NOT take effect; the save-failure path calls this. `commit`
     * already declines to arm on a throwing handler, but a handler that resolves and THEN discovers the POST
     * failed (the common async case) must say so, or the user's retry ("next" again) is swallowed for the
     * cooldown, turning a recoverable failure into an unrecoverable one.
     */
    invalidateLastWrite(token) {
      // TOKEN-SCOPED, and it must be: save A commits, save B commits after the cooldown expires, THEN A's
      // async POST fails and the host calls this. Without the token it clears the cooldown B armed, so a
      // transport duplicate of B is admitted (a double save of B, caused by A's failure). The token is the
      // `atMs` the host already receives in onCommit's meta.
      if (token != null && (!lastWrite || lastWrite.atMs !== token)) return
      lastWrite = null
    },

    stats() { return { ...stats } },
  }
}
