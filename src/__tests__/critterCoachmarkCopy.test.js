import { describe, it, expect } from 'vitest'
import {
  COACHMARK_COPY_VARIANTS,
  DEFAULT_COACHMARK_COPY,
  COACHMARK_MIN_VISIBLE_MS,
  OPT_IN_CRITTER_THRESHOLD,
  OPT_IN_COPY_VARIANTS,
  DEFAULT_OPT_IN_COPY,
} from '../lib/critterCoachmarkCopy.js'

describe('critterCoachmarkCopy', () => {
  describe('COACHMARK_COPY_VARIANTS', () => {
    it('has ≥3 variants for walkthrough room to swap', () => {
      expect(COACHMARK_COPY_VARIANTS.length).toBeGreaterThanOrEqual(3)
    })
    it('is frozen (cannot be accidentally mutated)', () => {
      expect(Object.isFrozen(COACHMARK_COPY_VARIANTS)).toBe(true)
    })
    it('default coachmark copy is the first variant', () => {
      expect(DEFAULT_COACHMARK_COPY).toBe(COACHMARK_COPY_VARIANTS[0])
    })
    it('every variant uses neutral verbs (no "task", "job", "chore", "earn", "unlock")', () => {
      // Mirrors critter-stage1-copy-variants verb-audit discipline (§3.21).
      const FORBIDDEN = /\b(task|job|chore|earn|unlocked?|achievement|XP)\b/i
      for (const v of COACHMARK_COPY_VARIANTS) {
        expect(v).not.toMatch(FORBIDDEN)
      }
    })
    it('mentions "dot" or "garden" or "visitor"/"critter" to bridge the BottomNav→Garden context', () => {
      for (const v of COACHMARK_COPY_VARIANTS) {
        expect(v).toMatch(/\b(dot|garden|visitor|critter)\b/i)
      }
    })
  })

  describe('COACHMARK_MIN_VISIBLE_MS', () => {
    it('is 1500ms per revision §3.7 (ADHD accidental route-change footgun)', () => {
      expect(COACHMARK_MIN_VISIBLE_MS).toBe(1500)
    })
  })

  describe('OPT_IN_CRITTER_THRESHOLD', () => {
    it('is 3 per revision §3.9 step 4', () => {
      expect(OPT_IN_CRITTER_THRESHOLD).toBe(3)
    })
  })

  describe('OPT_IN_COPY_VARIANTS', () => {
    it('has ≥3 variants probing "ping" word (per §3.21)', () => {
      expect(OPT_IN_COPY_VARIANTS.length).toBeGreaterThanOrEqual(3)
    })
    it('is frozen', () => {
      expect(Object.isFrozen(OPT_IN_COPY_VARIANTS)).toBe(true)
    })
    it('default points user to Settings → Notifications (self-nav, no laundering)', () => {
      expect(DEFAULT_OPT_IN_COPY).toMatch(/Settings\s*→\s*Notifications/)
    })
    it('NO variant uses an imperative button-like verb ("enable", "tap here", "click")', () => {
      // The point of §3.8 is the prompt is informational; no copy should feel like a button.
      const IMPERATIVE = /\b(tap here|click|press)\b/i
      for (const v of OPT_IN_COPY_VARIANTS) {
        expect(v).not.toMatch(IMPERATIVE)
      }
    })
  })
})
