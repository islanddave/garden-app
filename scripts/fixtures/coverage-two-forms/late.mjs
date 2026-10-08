// A module one worker finishes loading and another leaves in flight (pending.case.mjs).
import { gate } from './gate.mjs'

export function early() {
  return 'early'
}

export function late() {
  return 'late'
}

export const loaded = [early(), gate]
