// A CORRECT shape the provider refuses (limits.case.mjs loads it both ways): order-field-after-method.js with a
// static field, which the converter lists before the method's statement just the same.
class Limit {
  over(n) {
    return n > Limit.MAX
  }

  static MAX = 7
}

module.exports = { Limit }
