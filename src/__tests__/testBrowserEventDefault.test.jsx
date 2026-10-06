// OPS-RTLEVENTPRIORITY-001 — pins setup.ts's default window.event.
//
// React reads the priority of an update made outside its own handlers from window.event. Under vitest the
// jsdom global remembers the 'click' React's development build writes back around a handler, so every later
// update in the file renders at sync priority, in one pass, and a defect in the ORDER of two renders cannot
// show (BUG-TODAYV2DOUBLELOG-001). setup.ts installs helpers/browserEvent.js for every jsdom file; this file
// installs nothing of its own, so it goes red — 'click', not undefined — if that install is ever removed.
import { describe, it, expect } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

function Tap() {
  const [n, setN] = useState(0)
  return <button onClick={() => setN((v) => v + 1)}>taps {n}</button>
}

describe('window.event is the browser\'s by default (setup.ts)', () => {
  afterEach(cleanup)

  it('once React has handled a click no event is in progress', () => {
    render(<Tap />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByRole('button').textContent).toBe('taps 1')
    expect(window.event).toBeUndefined()
  })

  it('and it still is in the next case of the same file', () => {
    expect(window.event).toBeUndefined()
  })
})
