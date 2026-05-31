/**
 * src/lib/sendCapture.js
 *
 * Bite 7 of Post-V2 UX overhaul Increment 2: shared "Send to Claude" delivery.
 *
 * Extracted from TranscriptReview.handleSendToClaude (Bite 6) so the new
 * tile-level Send-to-Claude button in FieldCapture and TranscriptReview's
 * in-review button share ONE copy of the navigator.share -> clipboard ->
 * manual-copy fallback chain. No behavior change vs Bite 6 — same chain,
 * same precedence, same markHandedOff-on-success contract.
 *
 * Pure client-side: navigator.share / navigator.clipboard + a single
 * captureQueue.markHandedOff write on success. No Lambda, no network IO
 * beyond the platform share sheet.
 */

import { assembleFromEntry } from './helperPrompt.js'
import { markHandedOff } from './captureQueue.js'

/**
 * Run the share -> clipboard fallback chain for a prepared prompt string.
 * Returns { delivered: boolean, deliveredAs: 'shared' | 'copied' | null }.
 * Never throws — every channel is best-effort; a false `delivered` means the
 * caller should surface the manual-copy path.
 */
export async function deliverPrompt(prompt) {
  let delivered   = false
  let deliveredAs = null

  // 1. navigator.share — mobile share-sheet → user picks Claude.
  if (!delivered
      && typeof navigator !== 'undefined'
      && typeof navigator.share === 'function') {
    try {
      await navigator.share({ text: prompt })
      delivered = true
      deliveredAs = 'shared'
    } catch {
      // AbortError (user dismissed) or failure → fall through to clipboard.
    }
  }

  // 2. navigator.clipboard.writeText — desktop / share-unsupported.
  if (!delivered
      && typeof navigator !== 'undefined'
      && navigator.clipboard
      && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(prompt)
      delivered = true
      deliveredAs = 'copied'
    } catch {
      // Continue to manual fallback (caller renders it).
    }
  }

  return { delivered, deliveredAs }
}

/**
 * Assemble a Helper Prompt from a capture entry, deliver it, and mark the entry
 * handed_off on success. Returns a result object the caller renders:
 *   { status: 'error',  reason: 'empty' }            -- nothing to send
 *   { status: 'manual', prompt }                     -- couldn't auto-deliver
 *   { status: 'shared' | 'copied' }                  -- delivered + queue updated
 *   { status: 'shared' | 'copied', queueError: code} -- delivered, queue write failed
 */
export async function sendCaptureToClaude(entry, { onHandedOff, onError } = {}) {
  const prompt = assembleFromEntry(entry)
  if (!prompt) return { status: 'error', reason: 'empty' }

  const { delivered, deliveredAs } = await deliverPrompt(prompt)
  if (!delivered) return { status: 'manual', prompt }

  try {
    await markHandedOff(entry.id)
    if (typeof onHandedOff === 'function') onHandedOff(entry.id)
    return { status: deliveredAs }
  } catch (e) {
    // Delivery succeeded; only the queue write failed. Advisory, never undo.
    const code = typeof e === 'string' ? e : 'failed'
    if (typeof onError === 'function') onError(code)
    return { status: deliveredAs, queueError: code }
  }
}
