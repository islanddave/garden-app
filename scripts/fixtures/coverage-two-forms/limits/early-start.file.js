// The FILE's list of a wrong pair the provider takes (limits.case.mjs requires it and nothing imports it): the
// second statement is the value on the line above module.exports. early-start.vite.js has another statement
// under that number, one that starts three lines before this one and ends on its line.
const first = 1
//
//
//
const second = String(first)
module.exports = { first, second }
