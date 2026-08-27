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

function replay(events, opts = {}) {
  const commits = []
  const d = createCommitDebouncer({ onCommit: (r, m) => commits.push({ ...r, atMs: m.atMs }), ...opts })
  for (const e of events) {
    if (e.end) d.sessionEnd(e.t)
    else d.final(e.f, e.t)
  }
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

  it('fires save_and_advance exactly once', () => {
    const { commits } = replay(DEVICE_LOG)
    expect(commits.filter(c => c.kind === 'command')).toHaveLength(1)
  })

  // Proves the fixture is load-bearing rather than decorative: an unguarded consumer — which is what
  // every current caller of transcribe.js's onResult is — gets a materially worse result from the
  // SAME stream. If this ever matches the guarded count, the layer has stopped doing anything.
  it('an unguarded consumer would act 7 times on the same stream, twice wrongly', () => {
    const naive = DEVICE_LOG.filter(e => e.f).filter(e => e.f.trim() !== '')
    expect(naive).toHaveLength(7)
    expect(naive.map(e => e.f)).toEqual(['cucumber', 'three', 'three counts', '231', '231 G', '231 G', 'next'])
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
  it('suppresses a duplicate "next" that arrives in the NEXT session', () => {
    const { commits, d } = replay([
      { t: 13265, f: 'next' },
      { t: 13267, end: true },       // session ends, commits
      { t: 13400, f: 'next' },       // re-armed 133ms later; the duplicate lands here
      { t: 13405, end: true },
    ])
    expect(commits).toHaveLength(1)
    expect(d.stats().suppressedCommands).toBe(1)
  })

  it('allows the same command again once the cooldown has passed', () => {
    const { commits } = replay([
      { t: 1000, f: 'next' }, { t: 1005, end: true },
      { t: 1000 + DEFAULT_COMMAND_COOLDOWN_MS + 50, f: 'next' },
      { t: 1000 + DEFAULT_COMMAND_COOLDOWN_MS + 55, end: true },
    ])
    expect(commits).toHaveLength(2)
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
    d.reset()
    d.tick(5000)
    expect(onCommit).not.toHaveBeenCalled()
  })
})
