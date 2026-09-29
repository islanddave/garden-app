// householdView.js — the household view ("the rest of the household's care", V4-ASSIGNLENS-001) as ONE switch
// and ONE naming rule, shared by both Today pages.
//
// ONE KEY, ONE READER. localStorage 'garden.today.showOthers' = '1' is the per-device switch V1 Today's pill
// sets. The redesigned Today (V5-TODAYREDESIGN-001) reads the same switch and has no pill of its own: SF6 keeps
// the household view opt-in per person exactly as V1 has it, so Jen's page never gains "Dave's care" unless she
// turned it on. Moved here verbatim from Today.jsx (its useState initialiser and its toggle) so the two pages
// cannot read the switch two ways. Best-effort storage, as it always was: unreadable means off.
export const SHOW_OTHERS_KEY = 'garden.today.showOthers'

export function readShowOthers() {
  try { return localStorage.getItem(SHOW_OTHERS_KEY) === '1' } catch { return false }
}

export function writeShowOthers(on) {
  try { localStorage.setItem(SHOW_OTHERS_KEY, on ? '1' : '0') } catch { /* ignore */ }
}

// Another member's name as Today prints it ("Jen's care today", "(Jen)"): the first word of their roster
// display_name, else 'Someone else'. `members` = the roster (useMembers), `sub` = their user id.
export function memberFirstName(members, sub) {
  const m = (members || []).find(o => o && o.id === sub)
  const n = (m?.display_name || '').trim()
  return n ? n.split(/\s+/)[0] : 'Someone else'
}
