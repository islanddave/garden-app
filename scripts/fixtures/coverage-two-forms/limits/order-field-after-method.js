// A CORRECT shape the provider refuses (limits.case.mjs loads it both ways): a class with a field that has a
// value, after a method. The converter lists the field's value BEFORE the method's statement in both forms, so the
// file's own list is not in order and ORDER refuses it. Editing this file moves the places the test names.
class Counter {
  bump() {
    return this.count + 1
  }

  count = 0
}

module.exports = { Counter }
