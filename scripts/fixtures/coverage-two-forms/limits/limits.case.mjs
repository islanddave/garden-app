// The known limits of the provider's rule for taking vite's item maps, in a real run (vitest.limits.config.mjs,
// run only by the test of scripts/ci-telemetry/coverage-v8-two-forms.mjs). The four order-*.js modules are loaded
// BOTH WAYS in this one worker, so the provider compares their two conversions: each is correct and each is
// refused. Of every other pair, Node alone loads the *.file.js and vite alone the *.vite.js, so the report holds
// the file's list of the one and vite's list of the other, and the test hands the rule the two as one file's.
import { test, expect } from 'vitest'
import { createRequire } from 'node:module'
import fieldAfterMethod from './order-field-after-method.js'
import staticAfterMethod from './order-static-after-method.js'
import fieldsOnly from './order-fields-only.js'
import defaultFunction from './order-default-function.js'
import early from './early-start.vite.js'
import late from './late-start.vite.js'
import shared from './shared-start.vite.js'

const required = createRequire(import.meta.url)

test('the four correct shapes, imported and required', () => {
  expect(required('./order-field-after-method.js')).not.toBe(fieldAfterMethod)
  expect(required('./order-static-after-method.js')).not.toBe(staticAfterMethod)
  expect(required('./order-fields-only.js')).not.toBe(fieldsOnly)
  expect(required('./order-default-function.js')).not.toBe(defaultFunction)
})

test('the three wrong pairs, one half imported and the other required', () => {
  expect(required('./early-start.file.js').second).toBe(early.second)
  expect(required('./late-start.file.js').f(() => 3)).toBe(late.f(() => 3))
  expect(required('./shared-start.file.js').run(4)).toBe(shared.run(4))
})
