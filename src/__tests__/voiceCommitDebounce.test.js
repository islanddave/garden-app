// V5-HARVESTVOICEFLOW-001 (BD-068) — the commit-debounce layer, tested against the REAL device log.
//
// The fixture below is Dave's own probe run: Chrome on Android, installed PWA, 2026-08-27, four
// spoken phrases, transcribed verbatim from the log he pasted (archived in gardening-docs
// project-state/voiceflow-feasibility-V100-20260826.md §Device log). Timestamps are his, in ms from
// probe start. Nothing here is invented or smoothed — the empty finals, the prefix finals, and the
// duplicated "231 G" are all exactly as the device produced them.
//
// That matters more than usual for this file. The whole reason a debounce layer exists is that the
// desk analysis did NOT predict any of those three defects; they only appeared on a real phone. A
// hand-written fixture would encode what I expected the stream to look like, which is precisely the
// thing that was wrong. Replaying the measured stream is the only version of this test that can
// falsify the layer.
import { describe, it, expect, vi } from 'vitest'
import { createCommitDebouncer, DEFAULT_SETTLE_MS, DEFAULT_COMMAND_COOLDOWN_MS } from '../lib/voiceCommitDebounce.js'

// Dave's log, verbatim. 'f' = a final result, 'end' = the recogniser's session end.
const DEVICE_LOG = [
  { t: 2598,  f: '' },
  { t: 2671,  f: '' },
  { t: 2834,  f: '' },
  { t: 3404,  f: 'cucumber' },
  { t: 3407,  end: true },
  { t: 5754,  f: '' },
  { t: 5957,  f: '' },
  { t: 6071,  f: '' },              // arrives around the simulated search round-trip
  { t: 6385,  f: 'three' },         // PREFIX of the next one
  { t: 6580,  f: 'three counts' },  // supersedes 195ms later; note the PLURAL Chrome heard
  { t: 6581,  end: true },
  { t: 9484,  f: '' },
  { t: 9641,  f: '' },
  { t: 9650,  f: '' },
  { t: 10114, f: '' },
  { t: 10323, f: '231' },           // PREFIX
  { t: 10676, f: '231 G' },         // supersedes 353ms later; note the ABBREVIATION
  { t: 10950, f: '231 G' },         // THE DUPLICATE — same text, 274ms later, same session
  { t: 10952, end: true },
  { t: 12571, f: '' },
  { t: 13265, f: 'next' },
  { t: 13267, end: true },
]

// Models a REAL host, which is the thing the first version of this harness got wrong. It drove only
// final()/sessionEnd() and never tick() — and because the old sessionEnd flushed everything, the
// tests passed while the settle window never executed. That blind spot is exactly what let the
// premature-command defect through. A host arms a timer on dueAt(); this advances the clock to each
// event and then, after the stream ends, runs the timer out so anything still pending settles.
function replay(events, opts = {}) {
  const commits = []
  const d = createCommitDebouncer({ onCommit: (r, m) => commits.push({ ...r, atMs: m.atMs }), ...opts })
  let last = 0
  for (const e of events) {
    last = e.t
    d.tick(e.t)                       // the host's timer, firing on its way to this event
    if (e.end) d.sessionEnd(e.t)
    else d.final(e.f, e.t)
  }
  const due = d.dueAt()
  if (due != null) d.tick(Math.max(due, last + 1))
  return { commits, d }
}

describe('replaying the real device log', () => {
  it('commits exactly the four phrases Dave spoke, in order, once each', () => {
    const { commits } = replay(DEVICE_LOG)
    expect(commits.map(c => c.kind)).toEqual(['search', 'quantity', 'weight', 'command'])
    expect(commits[0]).toMatchObject({ kind: 'search', text: 'cucumber' })
    expect(commits[1]).toMatchObject({ kind: 'quantity', value: 3, unit: 'count' })
    expect(commits[2]).toMatchObject({ kind: 'weight', value: 231, unit: 'g' })
    expect(commits[3]).toMatchObject({ kind: 'command', command: 'save_and_advance' })
  })

  // The headline number: 22 raw finals in, 4 commits out.
  it('turns 22 raw events into 4 commits', () => {
    const { commits, d } = replay(DEVICE_LOG)
    expect(commits).toHaveLength(4)
    const s = d.stats()
    expect(s.droppedEmpty).toBe(11)   // every empty final, dropped
    expect(s.superseded).toBe(3)      // "three"->"three counts", "231"->"231 G", "231 G" repeat
    expect(s.committed).toBe(4)
  })

  it('never commits a prefix — "three" and "231" reach nothing', () => {
    const { commits } = replay(DEVICE_LOG)
    // Compared on the SEARCH text specifically. An earlier version of this assertion coerced every
    // commit to a string via `c.text ?? String(c.value)`, which turned the correctly-committed
    // weight 231 into the string '231' and collided it with the prefix it was checking for — the
    // test failed while the layer was right. The prefixes were both search-kind; that is the axis.
    const searches = commits.filter(c => c.kind === 'search').map(c => c.text)
    expect(searches).toEqual(['cucumber'])
    expect(searches).not.toContain('three')
    expect(searches).not.toContain('231')
  })

  it('commits the duplicated "231 G" exactly once', () => {
    const { commits } = replay(DEVICE_LOG)
    expect(commits.filter(c => c.kind === 'weight')).toHaveLength(1)
  })

  // HONESTY NOTE, and it limits what this fixture can be cited for: the device log contains exactly
  // ONE non-empty `next` final, so this assertion also passes with the layer removed entirely
  // (measured by the crucible). It evidences that the layer does not INVENT a second command — real,
  // but weaker than "prevents a double save". The log's one true duplicate is on the WEIGHT axis,
  // which is idempotent. Duplicate-COMMAND suppression is evidenced ONLY by the synthetic
  // cross-session case below, i.e. by exactly the kind of invented stream this file's header warns
  // about. A duplicate command has never been captured on a device.
  it('does not invent a second command from a stream containing one', () => {
    const { commits } = replay(DEVICE_LOG)
    expect(commits.filter(c => c.kind === 'command')).toHaveLength(1)
  })

  // WAS VACUOUS — REWRITTEN. The previous version only filtered the fixture array and never called
  // createCommitDebouncer at all, so it stayed GREEN when the crucible replaced the whole layer with
  // a pass-through. Its own comment claimed "if this ever matches the guarded count, the layer has
  // stopped doing anything", which was exactly the assurance it could not provide. Both counts now
  // come from the same fixture, one through real code.
  //
  // The claim about unguarded consumers was ALSO wrong and is corrected here: transcribe.js:194 has
  // guarded onResult since BUG-VOICEDUPE-003, and transcribe.rawEvents.test.js:154 pins it. This
  // fixture is the RAW recogniser stream (what the probe measured by bypassing that wrapper), not
  // what a transcribe.js consumer sees — which is a difference that decides where this layer may sit.
  it('turns the raw stream into strictly fewer, better actions than acting per final', () => {
    const naive = DEVICE_LOG.filter(e => e.f && e.f.trim() !== '')
    const { commits } = replay(DEVICE_LOG)
    expect(naive).toHaveLength(7)
    expect(commits).toHaveLength(4)
    expect(commits.length).toBeLessThan(naive.length)
    // The two the naive path gets WRONG, named rather than counted.
    expect(naive.map(e => e.f)).toContain('three')
    expect(naive.map(e => e.f)).toContain('231')
    expect(commits.filter(c => c.kind === 'search').map(c => c.text)).toEqual(['cucumber'])
  })
})

describe('the premature-command case — why the settle window exists', () => {
  // The single most valuable thing this layer does. Without it, a bare "next" heard while Dave is
  // still saying "next to the fence" has ALREADY saved by the time the rest arrives.
  it('lets a longer utterance rescue a premature "next" before it can save', () => {
    const { commits } = replay([
      { t: 1000, f: 'next' },
      { t: 1200, f: 'next to the fence' },
      { t: 1205, end: true },
    ])
    expect(commits).toHaveLength(1)
    expect(commits[0]).toMatchObject({ kind: 'search' })
    expect(commits[0].kind).not.toBe('command')
  })

  it('still commits a real "next" when nothing supersedes it', () => {
    const { commits } = replay([{ t: 1000, f: 'next' }, { t: 1005, end: true }])
    expect(commits).toEqual([expect.objectContaining({ command: 'save_and_advance' })])
  })
})

describe('cross-session duplicate suppression — the gap transcribe.js cannot close', () => {
  // transcribe.js:183 dedupes byte-identical re-delivery, but finalsByIndex (line 134) lives INSIDE
  // startLiveTranscription, so it resets on every re-arm. A duplicate landing after a 16-133ms
  // re-arm meets an empty slot map and passes straight through. Measured duplicate gap: 274ms.
  // NOTE THE MECHANISM CHANGED, and for the better. Now that a write command holds the settle
  // window past sessionEnd, a duplicate arriving 133ms later (the measured re-arm gap) lands while
  // the first is STILL PENDING and is absorbed as an exact repeat — it never becomes a second
  // commit at all, so the cooldown never has to fire. The cooldown is now the backstop for a
  // duplicate arriving AFTER the window has already closed and the write has landed.
  it('absorbs a duplicate "next" arriving in the NEXT session, committing once', () => {
    const { commits, d } = replay([
      { t: 13265, f: 'next' },
      { t: 13267, end: true },       // Chrome's per-utterance boundary — command held, not flushed
      { t: 13400, f: 'next' },       // re-armed 133ms later; the duplicate lands here
      { t: 13405, end: true },
    ])
    expect(commits).toHaveLength(1)
    expect(d.stats().superseded).toBe(1)         // absorbed, not suppressed
    expect(d.stats().suppressedCommands).toBe(0)
  })

  it('suppresses a duplicate that arrives after the write has already landed', () => {
    const commits = []
    const d = createCommitDebouncer({ onCommit: r => commits.push(r) })
    d.final('next', 1000)
    d.tick(1500)                                  // window closes, write lands at 1500
    expect(commits).toHaveLength(1)
    d.final('next', 1600); d.tick(2200)           // 700ms after the commit — inside the cooldown
    expect(commits).toHaveLength(1)
    expect(d.stats().suppressedCommands).toBe(1)
  })

  it('allows the same command again once the cooldown has passed', () => {
    // Timed from the COMMIT, not from the utterance: the first write lands at 1500 (settle window),
    // so the second must land after 3000. Second utterance at 2600 -> commits at 3100.
    const commits = []
    const d = createCommitDebouncer({ onCommit: r => commits.push(r) })
    d.final('next', 1000); d.tick(1500)
    d.final('next', 2600); d.tick(3100)
    expect(commits).toHaveLength(2)
    expect(3100 - 1500).toBeGreaterThan(DEFAULT_COMMAND_COOLDOWN_MS)
  })

  // The cooldown is COMMAND-ONLY on purpose. Two identical harvests in a row is a real thing Dave
  // does — same crop, same weight, next planting — and suppressing that would lose data he entered.
  // Only the destructive verb gets the conservative treatment.
  it('does NOT suppress a repeated data value — two identical harvests are legitimate', () => {
    const { commits } = replay([
      { t: 1000, f: 'three counts' }, { t: 1005, end: true },
      { t: 1100, f: 'three counts' }, { t: 1105, end: true },
    ])
    expect(commits).toHaveLength(2)
  })
})

// Every case below is a defect the crucible MEASURED in the first version of this layer. Each one
// was a silent double-write or a swallowed recovery — the exact class the layer exists to prevent,
// reached through the layer itself.
describe('crucible-found defects', () => {
  it('holds a WRITE command past sessionEnd so a continuation can still supersede it', () => {
    // Was: sessionEnd flushed everything, and since Chrome ends the session after every utterance,
    // it was the dominant path — the settle window never ran, and a session boundary between "next"
    // and "next to the fence" committed an unrequested SAVE.
    const { commits } = replay([
      { t: 1000, f: 'next' },
      { t: 1002, end: true },              // Chrome's per-utterance boundary
      { t: 1200, f: 'next to the fence' }, // the continuation, next session
      { t: 1202, end: true },
    ])
    expect(commits).toHaveLength(1)
    expect(commits[0].kind).toBe('search')
  })

  it('still flushes DATA at sessionEnd — the 500ms is paid only on the destructive verb', () => {
    const { commits } = replay([{ t: 1000, f: '231 grams' }, { t: 1002, end: true }])
    expect(commits).toEqual([expect.objectContaining({ kind: 'weight', value: 231 })])
  })

  it('resetPending does NOT disarm duplicate suppression', () => {
    // Was: a single reset() cleared the cooldown, so a reset between two "next"s 276ms apart let
    // BOTH commit. Every natural host implementation calls this on a chooser re-open or an unmount.
    const commits = []
    const d = createCommitDebouncer({ onCommit: r => commits.push(r) })
    d.final('next', 1000); d.tick(1600)
    d.resetPending()
    d.final('next', 1876); d.tick(2500)
    expect(commits).toHaveLength(1)
    expect(d.stats().suppressedCommands).toBe(1)
  })

  it('suppresses across DIFFERENT write verbs — the cooldown keys on class, not string', () => {
    // Was: `next` -> save_and_advance and `save` -> save are different strings that both write, so
    // one spoken word heard two ways committed twice 300ms apart.
    const commits = []
    const d = createCommitDebouncer({ onCommit: r => commits.push(r) })
    d.final('next', 1000); d.tick(1600)
    d.final('save', 1700); d.tick(2300)
    expect(commits).toHaveLength(1)
  })

  it('does NOT arm the cooldown when the commit handler throws, so a retry is admitted', () => {
    const seen = []
    const errs = []
    const d = createCommitDebouncer({
      onCommit: r => { if (seen.length === 0) { seen.push(r); throw new Error('save failed') } seen.push(r) },
      onCommitError: (r, e) => errs.push(e.message),
    })
    d.final('next', 1000); d.tick(1600)
    expect(errs).toEqual(['save failed'])
    d.final('next', 1700); d.tick(2300)   // inside the cooldown, but the first write never landed
    expect(seen).toHaveLength(2)
    expect(d.stats().committed).toBe(1)   // only the one that returned counts
  })

  it('invalidateLastWrite releases the cooldown for an async save that failed after returning', () => {
    const commits = []
    const d = createCommitDebouncer({ onCommit: r => commits.push(r) })
    d.final('next', 1000); d.tick(1600)
    d.invalidateLastWrite()               // the POST rejected a moment later
    d.final('next', 1900); d.tick(2500)   // well inside 1500ms
    expect(commits).toHaveLength(2)
  })

  it('reports a suppressed command instead of swallowing it silently', () => {
    // Was: a suppressed command produced no onCommit, no pending, nothing — indistinguishable from
    // a dead mic, an unheard utterance, or a failed save.
    const suppressed = []
    const d = createCommitDebouncer({ onCommit: () => {}, onSuppressed: (r, why) => suppressed.push(why) })
    d.final('next', 1000); d.tick(1600)
    d.final('next', 1700); d.tick(2300)
    expect(suppressed).toEqual(['cooldown'])
  })

  it('a throwing onPending cannot kill the session', () => {
    const d = createCommitDebouncer({ onCommit: () => {}, onPending: () => { throw new Error('render blew up') } })
    expect(() => { d.final('cucumber', 1000); d.tick(1600) }).not.toThrow()
  })
})

describe('the settle window on its own (no session end)', () => {
  it('holds a final until the window expires, then commits once', () => {
    const commits = []
    const d = createCommitDebouncer({ onCommit: r => commits.push(r) })
    d.final('cucumber', 1000)
    d.tick(1000 + DEFAULT_SETTLE_MS - 1)
    expect(commits).toHaveLength(0)
    expect(d.dueAt()).toBe(1000 + DEFAULT_SETTLE_MS)
    d.tick(1000 + DEFAULT_SETTLE_MS)
    expect(commits).toHaveLength(1)
    d.tick(9999)
    expect(commits).toHaveLength(1)   // and never again
  })

  it('a supersede restarts the window rather than extending the old one', () => {
    const commits = []
    const d = createCommitDebouncer({ onCommit: r => commits.push(r) })
    d.final('three', 1000)
    d.final('three counts', 1300)
    d.tick(1500)                       // past the FIRST deadline, not the second
    expect(commits).toHaveLength(0)
    expect(d.dueAt()).toBe(1800)
    d.tick(1800)
    expect(commits).toEqual([expect.objectContaining({ value: 3, unit: 'count' })])
  })
})

describe('two genuinely different utterances inside one session', () => {
  it('commits both — a non-prefix final ends the pending one', () => {
    const { commits } = replay([
      { t: 1000, f: 'cucumber' },
      { t: 1200, f: 'tomato' },   // not a prefix — cucumber is finished
      { t: 1205, end: true },
    ])
    expect(commits.map(c => c.text)).toEqual(['cucumber', 'tomato'])
  })
})

describe('regression guard — a truncated re-delivery must not downgrade a settled utterance', () => {
  // DEFENSIVE, and labelled as such: this shape did NOT occur in the device log. It is handled by
  // keeping the longer text rather than trusting arrival order, because the alternative silently
  // replaces a fully-heard utterance with a partial one.
  it('keeps "three counts" when a bare "three" arrives after it', () => {
    const { commits, d } = replay([
      { t: 1000, f: 'three counts' },
      { t: 1100, f: 'three' },
      { t: 1105, end: true },
    ])
    expect(commits).toEqual([expect.objectContaining({ value: 3, unit: 'count' })])
    expect(d.stats().regressed).toBe(1)
  })
})

describe('the pending channel — what a confirmation UI would read', () => {
  it('reports the utterance awaiting settle, then clears it on commit', () => {
    const seen = []
    const d = createCommitDebouncer({ onCommit: () => {}, onPending: p => seen.push(p ? p.kind : null) })
    d.final('three', 1000)
    d.final('three counts', 1200)
    expect(d.peek()).toMatchObject({ kind: 'quantity', value: 3 })
    d.sessionEnd(1205)
    expect(d.peek()).toBeNull()
    expect(seen).toEqual(['search', 'quantity', null])
  })

  it('reset drops a pending utterance without committing it', () => {
    const onCommit = vi.fn()
    const d = createCommitDebouncer({ onCommit })
    d.final('next', 1000)
    d.resetPending()
    d.tick(5000)
    expect(onCommit).not.toHaveBeenCalled()
  })
})
