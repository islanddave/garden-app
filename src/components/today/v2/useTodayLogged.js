import { useMemo, useRef, useSyncExternalStore } from 'react'
import { subscribeLogged, loggedVersion, readLogged, claimedKeys, claimKeys, confirmKeys, releaseKeys } from './needsCareStore.js'

// useTodayLogged — one list's view of the today-logged guard (needsCareStore), shared by useNeedsCare and useProtect.
//
// `held`: the row keys this list leaves out — logged today in this tab (the store), or claimed by a write whose POST
// has not answered (the claims) — MINUS the keys this mount claimed itself. A mount's own rows stay where they are:
// the hook's fades hide them as they land and their done lines are drawn from them. What is left out is everyone
// else's: what an earlier mount logged, and a run an earlier mount started that is still posting (keepalive).
// Subscribed, so a claim released by a failed POST, or a log un-written by an Undo, puts its row back on the list
// that is on screen now. The set keeps its identity while its contents are the same, so a mount's own run — a store
// change per POST — never rebuilds its rows.
//
// `claim`: what a write tells the guard, in the shape useCareActions' V2 run calls it — onClaim(keys) before the
// first POST, then exactly one of onLogged / onRelease per key.
export function useTodayLogged(logKey) {
  useSyncExternalStore(subscribeLogged, loggedVersion)
  const own = useRef(null)
  if (!own.current || own.current.key !== logKey) own.current = { key: logKey, keys: new Set() }
  const mine = own.current.keys
  const sig = [...new Set([...readLogged(logKey), ...claimedKeys(logKey)])].filter((k) => !mine.has(k)).sort().join('\n')
  const held = useMemo(() => new Set(sig ? sig.split('\n') : []), [sig])
  const claim = useMemo(() => ({
    onClaim: (ks) => { for (const k of ks) mine.add(k); claimKeys(logKey, ks) },
    onLogged: (ks) => confirmKeys(logKey, ks),
    onRelease: (ks) => releaseKeys(logKey, ks),
  }), [logKey, mine])
  return { held, claim }
}
