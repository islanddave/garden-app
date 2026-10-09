// A CORRECT shape the provider refuses (limits.case.mjs loads it both ways): a class with no method. A field whose
// value is a function with a body, then another field with a value: the converter lists the second value before
// the statement inside the first.
class Clock {
  now = () => {
    return Date.now()
  }

  zone = 'UTC'
}

module.exports = { Clock }
