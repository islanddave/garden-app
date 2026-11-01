// src/components/putup/batchCloseWhen.js
// "A make with nothing kept" (V4 §2.2): Start a batch → lines → What happened to it? → No → Ate it /
// Gave it away (the close already offers the endings with no jars). Such a make needs the close
// sheet's When (V4 Appendix A), or it would be dated the moment it was logged. This turns the shared
// start chips' answer into the close body's optional `when`:
//   Today → nothing (the server keeps the shipped now()) · any other answer → { date, precision }
//   (Not sure → { date: null, precision: 'unknown' }) · a half-answer → { error }.
// PURE.
export function closeWhenBody(resolved, chip) {
  if (chip === 'today') return null
  if (!resolved || resolved.error) return { error: resolved?.error ?? 'Pick when it finished — or tap Today.' }
  const { started_at: at, start_precision: precision } = resolved.start
  return precision === 'unknown' ? { date: null, precision } : { date: at, precision }
}
