// src/__tests__/helpers/browserEvent.js — window.event as a browser keeps it (BUG-TODAYV2DOUBLELOG-001).
//
// WHY THIS EXISTS. React gives every state update a priority, and for an update made outside its own event
// handlers it reads that priority from window.event (react-dom getCurrentEventPriority): no event in progress
// means DEFAULT priority, a click in progress means SYNC. In a browser window.event is empty again as soon as
// an event has been dispatched, so what a POST's answer sets is default priority — and anything that re-renders
// at sync priority (a useSyncExternalStore signal, the next tap) is rendered FIRST, alone, without it.
//
// Under vitest that never happens. React's development build writes window.event back around every handler it
// calls (`window.event = windowEvent`, invokeGuardedCallbackDev), and vitest's jsdom window REMEMBERS a value
// assigned to one of its keys. Measured 2026-10-06: empty after a plain DOM click, 'click' for the rest of the
// file once React has called one handler. From the first tap on, every update in the file is a click's, lands
// in one render with everything else, and no defect in the ORDER of two renders can show.
//
// That hid a real one through two lanes and two reviews: the end of every Water all on the Today preview
// dropped its done line and its Undo in Chrome (gate:today-shape:v2), with 691 tests green. Eleven of the
// cases then in TodayV2NeedsCare.test.jsx go red at that commit with this helper installed, none without.
//
// WHAT IT DOES. Points the global's `event` at the JSDOM window's own (which jsdom does empty after a
// dispatch) and ignores React's write-back. Call it in beforeEach and call what it returns in afterEach.
//
// WHAT IT DOES NOT DO. A real finger's tap keeps window.event set through the microtasks its handler queued;
// fireEvent runs those after the dispatch has returned, so here they are default priority. A network answer
// is never one of them — it arrives in a later task, in a browser and here alike.
export function browserEvent() {
  const found = Object.getOwnPropertyDescriptor(globalThis, 'event')
  const jsdomWindow = globalThis.jsdom?.window
  if (!jsdomWindow) throw new Error('browserEvent: no JSDOM window on the global — this helper needs vitest\'s jsdom environment')
  Object.defineProperty(globalThis, 'event', { configurable: true, get: () => jsdomWindow.event, set() {} })
  return () => { if (found) Object.defineProperty(globalThis, 'event', found); else delete globalThis.event }
}
