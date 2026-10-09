// VITE's list of a wrong pair the provider takes (limits.case.mjs imports it and nothing requires it): the second
// statement is a function in brackets, called where it stands. Vite's source map starts it where the function's
// body is, which is where the third statement starts and inside the second statement of late-start.file.js.
const f = (g) => g()
;(() => 2)()
module.exports = { f }
