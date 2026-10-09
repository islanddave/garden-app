// The FILE's list of a wrong pair the provider takes (limits.case.mjs requires it and nothing imports it): the
// second statement is a call of `f` at the start of its line, and the third is the `2` inside it.
// late-start.vite.js has another statement under the second number.
const f = (g) => g()
f(() => 2)
module.exports = { f }
