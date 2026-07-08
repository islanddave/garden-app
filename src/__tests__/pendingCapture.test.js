import { describe, it, expect } from 'vitest'
import { setPendingCapture, takePendingCapture } from '../lib/pendingCapture.js'
describe('pendingCapture (V4-PHOTOQUICK-001)', () => {
  it('parks a file and hands it over exactly once', () => {
    const f = new File(['x'], 'a.jpg', { type: 'image/jpeg' })
    setPendingCapture(f)
    expect(takePendingCapture()).toBe(f)
    expect(takePendingCapture()).toBe(null)
  })
  it('setPendingCapture(null) clears', () => {
    setPendingCapture(new File(['y'], 'b.jpg'))
    setPendingCapture(null)
    expect(takePendingCapture()).toBe(null)
  })
})
