'use strict'
// Loaded by Node alone: required.case.mjs requires it and nothing imports it, as lambda/daily-plan/rainLog.js is
// loaded in the test files that reach it only through handler.js. No vite conversion of it exists in the run, so
// what the report says of it is the Node conversion and nothing else. One function is called, one never is, and
// one arm is never taken: a count of zero has to come out as zero.
// only-node.v8.json beside this is V8's own record of this load, cut from a real run: cut it again (the test says
// how) when this file or required.case.mjs changes.

function called(n) {
  if (n > 10) return 'big'
  return 'small'
}

function notCalled() {
  return 'never'
}

module.exports = { called, notCalled }
