// VITE's list of a wrong pair the provider takes (limits.case.mjs imports it and nothing requires it): the second
// statement is a value of four lines. It lies over the place early-start.file.js has its second statement, starts
// before it and ends on its line.
const first = 1
const second = String(
  // three lines before the file's statement
  first,
)
module.exports = { first, second }
