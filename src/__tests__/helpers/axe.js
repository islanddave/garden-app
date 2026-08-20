// src/__tests__/helpers/axe.js — the automated a11y gate's engine (V4-A11YGATE-001).
//
// WHY THIS EXISTS. V4-WATERWHY-002 shipped `<div aria-label={sentence}>` to dev (2851779): a
// role-less div maps to role=generic, generic cannot be named, so the label was DISCARDED and the
// lane announced nothing at all. Nothing in the repo could catch it — there is no jsx-a11y, no axe,
// and `getByLabelText` matches the ATTRIBUTE, so the existing tests were green on a silent surface.
// This module makes axe-core adjudicate rendered DOM inside the normal vitest run.
//
// TWO DESIGN DECISIONS THAT MATTER, both measured against axe-core 4.13.0 under jsdom:
//
// 1. INCOMPLETE COUNTS AS A FAILURE (for the enabled rules). axe reports `aria-prohibited-attr` as a
//    *violation* only when the element has no text content; when it HAS text — which is 14 of the 16
//    real instances in this repo — it downgrades to `incomplete` ("not well supported"), because the
//    text content still produces some accessible name. That downgrade is exactly wrong for us: the
//    author's label is still being thrown away, and a gate that ignored `incomplete` would have
//    caught 2 of 16. Every rule enabled below is a deterministic DOM/ARIA-structure rule with no
//    jsdom-specific uncertainty, so `incomplete` here means "really is wrong", not "can't tell".
//
// 2. THE RULE SET IS DELIBERATELY SMALL. Enabling axe's defaults buries the signal: color-contrast
//    and target-size need layout jsdom does not have (permanently incomplete), and the landmark /
//    region / heading-order / html-lang family is document-scoped nonsense against an RTL container
//    holding one component. See RULES_OFF below for the full deferred list and the ratchet order.

import axe from 'axe-core'

// ENABLED — the naming-and-role core. Ordered by how directly each one covers the WATERWHY class.
export const A11Y_RULES = [
  'aria-prohibited-attr',   // THE rule. aria-label on an element whose role can't carry a name.
  'aria-allowed-attr',      // sibling class: aria-* that the element's role does not support.
  'aria-required-attr',     // a role adopted without the state it needs (role=checkbox, no aria-checked).
  'aria-valid-attr',        // typo'd aria-* attributes (aria-lable) — silent no-ops otherwise.
  'aria-valid-attr-value',  // aria-labelledby pointing at an id that isn't in the DOM.
  'aria-roles',             // invented role values.
  'role-img-alt',           // guards the FIX pattern: role="img" added without a name is still silent.
  'button-name',            // icon-only buttons are this app's dominant control.
  'link-name',
  'image-alt',
  'aria-hidden-focus',      // focusable descendant of aria-hidden — the icon-wrapper keyboard trap.
  'aria-hidden-body',
]

// DEFERRED — off on purpose, with the reason. Ratchet these on in roughly this order.
export const RULES_OFF = {
  'color-contrast': 'jsdom does not lay out or paint; axe returns incomplete for every node. Needs a real browser (the harness on :5311), not this suite.',
  'target-size': 'same — needs layout boxes.',
  'scrollable-region-focusable': 'same — needs overflow computation.',
  'region': 'document-scoped. RTL mounts one component into a bare div, so every render is "not in a landmark".',
  'landmark-one-main': 'document-scoped, same reason.',
  'landmark-unique': 'document-scoped, same reason.',
  'page-has-heading-one': 'document-scoped, same reason.',
  'html-has-lang': 'document-scoped; index.html owns it, no component can satisfy it.',
  'bypass': 'document-scoped; skip-link concern, not a component concern.',
  'heading-order': 'a component rendered in isolation legitimately starts at h2/h3. Would need a full-page render set to mean anything.',
  'duplicate-id-aria': 'candidate for the next ratchet step — needs a pass over the id-generating components first.',
  'label': 'candidate for the next ratchet step; forms/ has its own labelling conventions to audit before turning this on.',
  'nested-interactive': 'candidate for the next ratchet step; several tiles nest a button inside a tappable card by design and each needs a judgement call.',
  'aria-input-field-name': 'candidate for the next ratchet step, together with `label`.',
}

const AXE_OPTS = {
  runOnly: { type: 'rule', values: A11Y_RULES },
  // Cheap output: we format our own message and never need the remediation prose or the
  // full ancestry, and `resultTypes` stops axe collecting node data for passes.
  resultTypes: ['violations', 'incomplete'],
  elementRef: false,
}

/**
 * Run the gate's rule set over a container and return a flat list of findings.
 * `incomplete` is folded into the same list as `violations` — see decision 1 above.
 * @returns {Promise<Array<{rule: string, impact: string, kind: string, html: string, message: string}>>}
 */
export async function auditA11y(container, { rules } = {}) {
  const target = container || document.body
  const opts = rules ? { ...AXE_OPTS, runOnly: { type: 'rule', values: rules } } : AXE_OPTS
  const res = await axe.run(target, opts)
  const out = []
  for (const kind of ['violations', 'incomplete']) {
    for (const r of res[kind]) {
      for (const n of r.nodes) {
        const detail = [...(n.any || []), ...(n.none || []), ...(n.all || [])]
          .map((c) => c.message).filter(Boolean).join(' ')
        out.push({
          rule: r.id,
          impact: r.impact || n.impact || 'unknown',
          kind: kind === 'violations' ? 'violation' : 'incomplete',
          html: (n.html || '').slice(0, 200),
          message: detail || r.help,
        })
      }
    }
  }
  return out
}

export function formatFindings(findings) {
  return findings
    .map((f) => `  [${f.kind}] ${f.rule} (${f.impact})\n    ${f.message}\n    ${f.html}`)
    .join('\n')
}

/**
 * Assert a rendered container is clean under the gate's rule set.
 * Throws with the axe rule id in the message, so a red suite names the rule that broke.
 */
export async function expectNoA11yViolations(container, { rules, label = 'container' } = {}) {
  const findings = await auditA11y(container, { rules })
  if (findings.length) {
    throw new Error(
      `a11y gate: ${findings.length} finding(s) in ${label} ` +
      `[${[...new Set(findings.map((f) => f.rule))].join(', ')}]\n${formatFindings(findings)}`
    )
  }
}
