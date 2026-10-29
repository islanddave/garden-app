// OPS-JSXCLASSICFALLBACK-001 — proves the JSX automatic runtime is active in the unit transform.
// THIS FILE MUST NOT `import React`: the inline <Probe /> is compiled by the transform under test, and
// under esbuild's classic fallback it throws `ReferenceError: React is not defined`.
// Under vitest 4 the automatic runtime is configured whether or not vitest.config.ts's `esbuild` block
// is present, so a green run here is not evidence that removing that block is safe.
import { render, screen } from '@testing-library/react'

function Probe() {
  return <div data-testid="inline-probe">inline</div>
}

describe('JSX automatic runtime (vitest.config.ts esbuild block)', () => {
  it('compiles inline JSX in a test file that never imports React', () => {
    render(<Probe />)
    expect(screen.getByTestId('inline-probe').textContent).toBe('inline')
  })
})
