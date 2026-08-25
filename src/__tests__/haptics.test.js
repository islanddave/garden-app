// haptics — V4-HAPTICVOCAB-001.
//
// WHAT THIS CAN AND CANNOT PROVE. Everything below is real: the vocabulary is data, the two gates
// are pure branches, and `navigator.vibrate` is a stub whose calls are counted. What it CANNOT
// prove is that any of it is felt. jsdom has no motor; Chrome's user-activation gate does not
// exist here; and the discriminability claim ("these five feel different eyes-free") is asserted
// below as a FEATURE VECTOR — pulse count and pulse weight-class — not as a fingertip measurement.
// A green run means the vocabulary is structurally distinct and the gates work. It does not mean
// Dave can tell a reject from an accept at the bench. That needs the on-device check in the lane
// report.
//
// Note the shape of the gate tests: preference and capability are TWO independent suppressors of
// one behaviour, so each test neutralises the other suppressor explicitly. Testing "pref off" with
// vibrate also absent would pass whichever gate you deleted.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  PATTERNS,
  HAPTIC_PREF_KEY,
  HAPTIC_DEFAULT_ENABLED,
  haptic,
  hapticsEnabled,
  hapticsSupported,
  setHapticsEnabled,
  hapticDigitAccepted,
  hapticDigitRejected,
  hapticSaveCommitted,
  hapticSaveFailed,
  hapticUndoApplied,
} from '../lib/haptics.js'

function installVibrate(impl = vi.fn(() => true)) {
  Object.defineProperty(navigator, 'vibrate', { value: impl, configurable: true, writable: true })
  return impl
}
function removeVibrate() {
  if ('vibrate' in navigator) delete navigator.vibrate
}

beforeEach(() => {
  try { localStorage.removeItem(HAPTIC_PREF_KEY) } catch { /* storage-less env */ }
  removeVibrate()
})
afterEach(() => {
  removeVibrate()
  vi.restoreAllMocks()
})

// ── The vocabulary ────────────────────────────────────────────────────────────────────────────
describe('the six events resolve to five structurally distinct patterns', () => {
  // A vibration pattern array alternates [pulse, gap, pulse, …], so the even indices are the pulses.
  const pulsesOf = (p) => (Array.isArray(p) ? p.filter((_, i) => i % 2 === 0) : [p])
  const weightOf = (ms) => (ms <= 20 ? 'tick' : ms <= 45 ? 'mid' : 'heavy')
  const signatureOf = (p) => pulsesOf(p).map(weightOf).join('+')

  it('gives every event a UNIQUE (count, weight-class) signature', () => {
    // The load-bearing assertion, and deliberately not `toEqual`-inequality of the arrays: two
    // patterns can be different arrays and still feel identical ([10] vs [11]). Feel is carried by
    // how many pulses there are and how heavy each one is, so that is what has to be unique.
    const sigs = Object.fromEntries(Object.entries(PATTERNS).map(([k, p]) => [k, signatureOf(p)]))
    expect(sigs).toEqual({
      digitAccepted: 'tick',
      digitRejected: 'tick+tick',
      saveCommitted: 'mid',
      saveFailed:    'heavy+heavy',
      undoApplied:   'tick+mid',
    })
    expect(new Set(Object.values(sigs)).size).toBe(Object.keys(PATTERNS).length)
  })

  it('separates a REJECTED keypress from an accepted one by pulse COUNT', () => {
    // The whole point of the module. Count is the axis a fingertip reads with no attention spent;
    // asking the user to judge 10ms against 14ms eyes-free would not be a signal.
    expect(pulsesOf(PATTERNS.digitAccepted)).toHaveLength(1)
    expect(pulsesOf(PATTERNS.digitRejected)).toHaveLength(2)
  })

  it('separates FAILURE from success on both axes at once', () => {
    // "Unmistakably unlike success" — so it may not rely on either axis alone.
    expect(pulsesOf(PATTERNS.saveFailed).length).not.toBe(pulsesOf(PATTERNS.saveCommitted).length)
    expect(weightOf(pulsesOf(PATTERNS.saveFailed)[0])).not.toBe(weightOf(pulsesOf(PATTERNS.saveCommitted)[0]))
  })

  it('makes UNDO the only ascending pattern, which is what separates it from a rejection', () => {
    // Same count and the same 40ms gap as digitRejected; the discriminator is that the second pulse
    // GROWS rather than matching. If undo were ever flattened to equal pulses this goes red.
    const [a, b] = pulsesOf(PATTERNS.undoApplied)
    expect(b).toBeGreaterThan(a)
    const [ra, rb] = pulsesOf(PATTERNS.digitRejected)
    expect(rb).toBe(ra)
  })

  it('keeps the accepted tick the lightest thing in the vocabulary', () => {
    // It fires on every keypress across a 12-variety session. Anything heavier is noise.
    const totals = Object.values(PATTERNS).map(p => pulsesOf(p).reduce((s, n) => s + n, 0))
    expect(Math.min(...totals)).toBe(PATTERNS.digitAccepted)
  })

  it('emits only positive integers, with odd-length arrays (pulse-gap-pulse)', () => {
    for (const p of Object.values(PATTERNS)) {
      const arr = Array.isArray(p) ? p : [p]
      expect(arr.length % 2).toBe(1)
      for (const n of arr) expect(Number.isInteger(n) && n > 0).toBe(true)
    }
  })

  it('has NO pattern for field advance — a ruling, not an omission', () => {
    // Quantity → weight is user-initiated and visible. A vocabulary that also fires on navigation
    // teaches the hand to ignore it, which costs the reject cue its meaning. Pinned so that adding
    // one is a deliberate edit that has to come here and delete this test.
    expect(PATTERNS.fieldAdvance).toBeUndefined()
    installVibrate()
    setHapticsEnabled(true)
    expect(haptic('fieldAdvance')).toBe(false)
    expect(navigator.vibrate).not.toHaveBeenCalled()
  })
})

// ── The two gates ─────────────────────────────────────────────────────────────────────────────
describe('capability gate (preference neutralised: explicitly ON throughout)', () => {
  it('does not fire, and does not throw, when navigator.vibrate is absent', () => {
    setHapticsEnabled(true)
    removeVibrate()
    expect(hapticsSupported()).toBe(false)
    expect(() => haptic('digitAccepted')).not.toThrow()
    expect(haptic('digitAccepted')).toBe(false)
  })

  it('fires when vibrate IS a function and the preference is on', () => {
    setHapticsEnabled(true)
    const spy = installVibrate()
    expect(hapticsSupported()).toBe(true)
    expect(haptic('digitAccepted')).toBe(true)
    expect(spy).toHaveBeenCalledWith(PATTERNS.digitAccepted)
  })

  it('rejects a non-function vibrate property rather than calling it', () => {
    setHapticsEnabled(true)
    Object.defineProperty(navigator, 'vibrate', { value: true, configurable: true, writable: true })
    expect(hapticsSupported()).toBe(false)
    expect(haptic('digitAccepted')).toBe(false)
  })

  it('CONSULTS the capability rather than discovering it by throwing', () => {
    // NEUTRALISING A REDUNDANT SUPPRESSOR. Every assertion above is satisfied by the try/catch
    // alone: with vibrate absent, deleting the `hapticsSupported()` guard still returns false,
    // because the TypeError from calling a non-function is swallowed. Measured — that mutant
    // SURVIVED the rest of this file. The one observable the catch cannot fake is that the property
    // is READ for a capability test before it is read for a call: guarded, `haptic()` touches
    // `navigator.vibrate` twice; unguarded, once. Without this test the guard is unfalsifiable and
    // every keypress on a motor-less platform would construct and throw an exception.
    setHapticsEnabled(true)
    let reads = 0
    const fn = vi.fn(() => true)
    Object.defineProperty(navigator, 'vibrate', {
      configurable: true,
      get() { reads += 1; return fn },
    })
    expect(haptic('digitAccepted')).toBe(true)
    expect(reads).toBeGreaterThanOrEqual(2)
  })
})

describe('preference gate (capability neutralised: vibrate installed throughout)', () => {
  it('suppresses every pattern when the preference is off', () => {
    const spy = installVibrate()
    setHapticsEnabled(false)
    expect(hapticsEnabled()).toBe(false)
    for (const name of Object.keys(PATTERNS)) expect(haptic(name)).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })

  it('stores the preference as the house 1/0 convention under a versioned key', () => {
    setHapticsEnabled(true)
    expect(localStorage.getItem(HAPTIC_PREF_KEY)).toBe('1')
    setHapticsEnabled(false)
    expect(localStorage.getItem(HAPTIC_PREF_KEY)).toBe('0')
  })

  it('falls back to the default when the key is unset', () => {
    localStorage.removeItem(HAPTIC_PREF_KEY)
    expect(hapticsEnabled()).toBe(HAPTIC_DEFAULT_ENABLED)
  })

  it('treats any value that is not "1" as off, so a corrupt value cannot buzz', () => {
    localStorage.setItem(HAPTIC_PREF_KEY, 'true')
    expect(hapticsEnabled()).toBe(false)
  })

  it('degrades to the default — never to a throw — when localStorage is unavailable', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { throw new Error('SecurityError: storage is denied') },
    })
    try {
      installVibrate()
      expect(hapticsEnabled()).toBe(HAPTIC_DEFAULT_ENABLED)
      expect(() => setHapticsEnabled(true)).not.toThrow()
      expect(() => haptic('digitAccepted')).not.toThrow()
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original)
      else delete globalThis.localStorage
    }
  })
})

describe('prefers-reduced-motion is NOT consulted', () => {
  it('still fires with reduced-motion asserted by matchMedia', () => {
    // RULING (haptics.js §2): haptics are not motion. That media query is about visual vestibular
    // load, and honouring it here would silently disable the one channel that reaches this user on
    // the one surface where the alternative is a mis-recorded weight. This test exists so that
    // "helpfully" adding a reduced-motion gate goes red instead of shipping.
    const mm = vi.fn(() => ({ matches: true, media: '(prefers-reduced-motion: reduce)', addEventListener() {}, removeEventListener() {} }))
    Object.defineProperty(window, 'matchMedia', { value: mm, configurable: true, writable: true })
    setHapticsEnabled(true)
    const spy = installVibrate()
    expect(haptic('digitRejected')).toBe(true)
    expect(spy).toHaveBeenCalledWith(PATTERNS.digitRejected)
    expect(mm).not.toHaveBeenCalled()
  })
})

// ── Platform refusal ──────────────────────────────────────────────────────────────────────────
describe('a refused or throwing vibration degrades, it does not break the caller', () => {
  it('reports false when the platform REFUSES the request', () => {
    // Chrome returns false when it declines to vibrate — the in-app signal that the async
    // user-activation risk actually bit. saveCommitted/saveFailed are the two that can land here,
    // which is exactly why neither of them is ever the only channel.
    setHapticsEnabled(true)
    installVibrate(vi.fn(() => false))
    expect(haptic('saveCommitted')).toBe(false)
  })

  it('swallows a throwing vibrate — a feedback cue may never take down a save', () => {
    setHapticsEnabled(true)
    installVibrate(vi.fn(() => { throw new TypeError('bad pattern') }))
    expect(() => haptic('saveFailed')).not.toThrow()
    expect(haptic('saveFailed')).toBe(false)
  })
})

// ── The call-site surface the sibling lanes wire ──────────────────────────────────────────────
describe('named wrappers', () => {
  it('each fires its own pattern and nothing else', () => {
    setHapticsEnabled(true)
    const spy = installVibrate()
    const cases = [
      [hapticDigitAccepted, PATTERNS.digitAccepted],
      [hapticDigitRejected, PATTERNS.digitRejected],
      [hapticSaveCommitted, PATTERNS.saveCommitted],
      [hapticSaveFailed,    PATTERNS.saveFailed],
      [hapticUndoApplied,   PATTERNS.undoApplied],
    ]
    for (const [fn, pattern] of cases) {
      spy.mockClear()
      expect(fn()).toBe(true)
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy).toHaveBeenCalledWith(pattern)
    }
  })
})
