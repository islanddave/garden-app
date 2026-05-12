// Haptic feedback util (V1.2a-1 §C-V1.2a-1-D)
// All wrappers feature-detect navigator.vibrate (undefined on desktop / unsupported browsers).
// Patterns per V002: short = log save, double = streak increment, triple = achievement earned.

export function hapticShort() {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    navigator.vibrate(50);
  }
}

export function hapticDouble() {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    navigator.vibrate([50, 30, 50]);
  }
}

export function hapticTriple() {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    navigator.vibrate([50, 30, 50, 30, 50]);
  }
}
