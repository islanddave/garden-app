// src/__tests__/helpers/settle.js — let a fetch answer's render land before the test goes on (OPS-RTLEVENTPRIORITY-001).
//
// WHY THIS EXISTS. Since helpers/browserEvent.js went global (setup.ts), what a resolved fetch sets is DEFAULT
// priority, as in a browser: React renders it from a scheduler TASK, not in the microtask that set it. A helper that
// waits for the fetch to have been CALLED and then flushes microtasks (`await act(async () => { await
// Promise.resolve() })`) therefore returns with the answer set and not yet on the page; the next line reads or types
// into the page as it was before the load. That is green nearly always (waitFor ends on a setTimeout(0), which
// usually lets the scheduler's task run first) and red now and then.
//
// WHAT IT DOES. Waits one setImmediate inside act. The scheduler posted its own setImmediate when the answer was set,
// which is earlier, so its render runs first — order, not duration; nothing here is a timeout. act then flushes the
// effects of that render on the way out.
//
// WHEN NOT TO USE IT. Where the test knows what the answer puts on the page, `await screen.findBy…` on that element
// says more and is the first choice. This is for a shared "the mount-time load has settled" step whose callers go on
// to many different elements. It hangs under fake timers that fake setImmediate.
import { expect } from 'vitest'
import { act, fireEvent, waitFor } from '@testing-library/react'

export async function settle() {
  await act(async () => { await new Promise(resolve => setImmediate(resolve)) })
}

// A <select> has no value it has no <option> for: set one before a fetched option list is on the page and the
// change is dropped without a word. Waits for the option, then changes — what a hand on the control would do.
export async function chooseOption(select, value) {
  await waitFor(() => expect([...select.options].map(option => option.value)).toContain(value))
  fireEvent.change(select, { target: { value } })
}
