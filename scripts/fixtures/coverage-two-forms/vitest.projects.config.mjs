// vitest.config.mjs beside this, as two projects: the shape the unit run has with the A3 trial's env key set
// (vitest.config.ts; the key is not named here, because scripts/test_ci_next.py holds the files that name it to
// four). `dom` runs under jsdom and holds the two cases that only import, `node` holds the two that require. So
// forms.js is imported in one project and required in the other, each
// project's vite text of it is converted in a pass of its own, and each project's workers are handed
// `provider: 'custom'` and evaluate the provider module themselves, where with one project only the main process
// does. Every hit count must come out as it does from the one-project run.
import one, { DIR } from './vitest.config.mjs'

const { include: _include, environment: _environment, ...test } = one.test

export default {
  ...one,
  test: {
    ...test,
    projects: [
      { extends: true, test: { name: 'dom', environment: 'jsdom', include: [`${DIR}/imported.case.mjs`, `${DIR}/pending.case.mjs`] } },
      { extends: true, test: { name: 'node', environment: 'node', include: [`${DIR}/required.case.mjs`, `${DIR}/both-ways.case.mjs`] } },
    ],
  },
}
