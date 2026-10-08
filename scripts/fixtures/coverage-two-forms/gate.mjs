// What late.mjs waits on. With the flag set, in pending.case.mjs alone, it never settles, so late.mjs stays where
// its import of this left it for as long as that worker lives.
export const gate = globalThis.__COVERAGE_TWO_FORMS_HOLD__ ? await new Promise(() => {}) : 'open'
