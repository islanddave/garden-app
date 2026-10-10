// The FILE's list of a wrong pair the provider takes (limits.case.mjs requires it and nothing imports it): the
// second branch is the `(b || c) && 1` inside the call the `if` makes. shared-start.vite.js has another branch
// under that number.
const run = (value) => value
const [a, b, c, first, other] = [1, 0, 1, 1, 0]
if (a) run((b || c) && 1)
module.exports = { run, first, other }
