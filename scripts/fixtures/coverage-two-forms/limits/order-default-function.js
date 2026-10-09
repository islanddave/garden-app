// A CORRECT shape the provider refuses (limits.case.mjs loads it both ways): a destructuring declaration with a
// default that is a function, this repo's own idiom for an injectable clock (lambda/harvests/season-stats.js:150).
// The converter lists the function's body before the declaration's value.
function read(ctx) {
  const { sql, query = {}, now = () => Date.now() } = ctx
  return [sql, query, now()]
}

module.exports = { read }
