// VITE's list of a wrong pair the provider takes (limits.case.mjs imports it and nothing requires it): the second
// branch is what the `if` tests. Vite's source map starts it where the `if` starts, and it reaches over the place
// shared-start.file.js has its second branch, which lies inside that file's `if`.
const run = (value) => value
const [a, b, c, first, other] = [1, 0, 1, 1, 0]
if ((first || other) && c) run(1)
module.exports = { run, a, b }
