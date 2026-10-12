// BUG-FERMENTSHUONESIDEDRANGE-001 — the ferment heat words with only one end of a range.
//
// fermentMath builds its own Scoville strings (shuRangeWords for a jar's estimate, ratingWords for a
// line's listed heat) and was never checked for a one-sided range when the shared variety chip was
// (shuLabel in lib/varietySpec.js, where only a minimum is a FLOOR and reads "5K+ SHU").
//
// These are NOT that chip, and "+" would be false here. On this path the low end alone is ONE figure,
// not a floor: the server's own rule is "high defaults to low" (lambda/preservation/shuEstimate.js
// lineRating, putUp.js for a typed estimate, lineRoutes.js for a stored line), and it is the figure the
// estimate was worked out from. A high end with no low end cannot be stored at all (kitchenLines.js
// ratingError: "a heat rating needs its low end"; putUp.js refuses an estimate the same way), so it is
// no figure and says nothing, never a number and never "0".
// Checked 2026-10-12: every case below was already right, so this file pins the words and changes none.
import { describe, it, expect } from 'vitest'
import { shuRangeWords, ratingWords } from '../components/putup/fermentMath.js'
import { lineWords } from '../components/putup/lines.js'

const line = (low, high) => ({ label: 'Jalapeño', shu_rating_low: low, shu_rating_high: high })

describe('a jar estimate (shuRangeWords) with one end, both, neither, zero', () => {
  it('only the low end is the one figure, with no "+" and no dash', () => {
    expect(shuRangeWords(2500, null)).toBe('est. 2.5k SHU')
    expect(shuRangeWords(2500, undefined)).toBe('est. 2.5k SHU')
    expect(shuRangeWords(2500, '')).toBe('est. 2.5k SHU')
  })
  it('only the high end is no figure: null, never the high end alone and never from 0', () => {
    expect(shuRangeWords(null, 8000)).toBeNull()
    expect(shuRangeWords(undefined, 8000)).toBeNull()
    expect(shuRangeWords('', 8000)).toBeNull()
  })
  it('both ends are a range; equal ends are said once', () => {
    expect(shuRangeWords(2500, 8000)).toBe('est. 2.5–8.0k SHU')
    expect(shuRangeWords(2500, 2500)).toBe('est. 2.5k SHU')
  })
  it('neither end is null', () => {
    expect(shuRangeWords(null, null)).toBeNull()
    expect(shuRangeWords(undefined, undefined)).toBeNull()
  })
  it('zero is a figure, on its own and as the low end', () => {
    expect(shuRangeWords(0, 0)).toBe('est. 0 SHU')
    expect(shuRangeWords(0, null)).toBe('est. 0 SHU')
    expect(shuRangeWords(0, 5000)).toBe('est. 0–5.0k SHU')
    expect(shuRangeWords(null, 0)).toBeNull()
  })
})

describe('a listed heat (ratingWords) with one end, both, neither, zero', () => {
  it('only the low end is the one figure, with no "+" and no dash', () => {
    expect(ratingWords(2500, null)).toBe('2,500 SHU')
    expect(ratingWords(2500, undefined)).toBe('2,500 SHU')
  })
  it('only the high end is no rating: empty, never the high end alone and never from 0', () => {
    expect(ratingWords(null, 8000)).toBe('')
    expect(ratingWords(undefined, 8000)).toBe('')
  })
  it('both ends are a range; equal ends are said once', () => {
    expect(ratingWords(2500, 8000)).toBe('2,500–8,000 SHU')
    expect(ratingWords(2500, 2500)).toBe('2,500 SHU')
  })
  it('neither end is empty', () => {
    expect(ratingWords(null, null)).toBe('')
    expect(ratingWords(undefined, undefined)).toBe('')
  })
  it('zero is a rating, on its own and as the low end', () => {
    expect(ratingWords(0, 0)).toBe('0 SHU')
    expect(ratingWords(0, null)).toBe('0 SHU')
    expect(ratingWords(0, 5000)).toBe('0–5,000 SHU')
    expect(ratingWords(null, 0)).toBe('')
  })
})

describe('the line as it reads on the card (lineWords) carries the same answers', () => {
  it('only the low end: "listed 2,500 SHU"', () => {
    expect(lineWords(line(2500, null))).toBe('Jalapeño · listed 2,500 SHU')
  })
  it('only the high end, or neither: the line says nothing about heat', () => {
    expect(lineWords(line(null, 8000))).toBe('Jalapeño')
    expect(lineWords(line(null, null))).toBe('Jalapeño')
  })
  it('both ends: the range', () => {
    expect(lineWords(line(2500, 8000))).toBe('Jalapeño · listed 2,500–8,000 SHU')
  })
  it('zero is said in words, with the high end absent or zero', () => {
    expect(lineWords(line(0, null))).toBe('Jalapeño · counted as 0')
    expect(lineWords(line(0, 0))).toBe('Jalapeño · counted as 0')
  })
})
