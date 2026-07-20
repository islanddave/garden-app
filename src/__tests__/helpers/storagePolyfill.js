// Test helper — install localStorage/sessionStorage on globalThis when the jsdom build in use does
// not provide them (local node-26 jsdom drops them; CI's pinned node-20 jsdom has them). Call once at
// the top of a test file so Slice 2 storage-backed logic (draft stash, sticky prefs) can be exercised
// locally. A no-op where the Storage APIs already exist. NOT loaded by the shared setup — opt-in per
// file so it never changes behavior for the existing suite.
function makeStorage() {
  let m = new Map()
  return {
    get length() { return m.size },
    key(i) { return Array.from(m.keys())[i] ?? null },
    getItem(k) { return m.has(String(k)) ? m.get(String(k)) : null },
    setItem(k, v) { m.set(String(k), String(v)) },
    removeItem(k) { m.delete(String(k)) },
    clear() { m = new Map() },
  }
}

export function installStoragePolyfill() {
  for (const name of ['localStorage', 'sessionStorage']) {
    if (typeof globalThis[name] === 'undefined') {
      Object.defineProperty(globalThis, name, { value: makeStorage(), configurable: true, writable: true })
    }
  }
}
