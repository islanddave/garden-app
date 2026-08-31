// V4-SEARCHCROPTYPE-001, THE VOICE LEG — saying the crop type reaches the planting.
//
// Dave's reason, quoted in VoiceHarvest.jsx itself: "I don't always remember spelling — is it
// charentais? charantais? — but I know it is a cantaloupe." Speaking makes that worse rather than
// better, because a recogniser has no prior for a rare cultivar name and every prior for "cucumber".
// The three TYPED client filters got crop type as a first-class term; this surface is the fourth.
//
// WHAT THIS FILE ESTABLISHED, and it is not what the residual assumed. Voice was described as
// "slug-only" and therefore behind the other three. Measured: the slug IS the whole term it needs.
// A crop type's display_name is the Title Case of its slug for every type in the vocabulary and
// looseKey lowercases both, so a display_name term matches nothing the slug does not — a version of
// this page that fetched the crop-type vocabulary to add it was written, measured, and reverted.
// The two normalisation fixes (looseKey treating '_' as a separator, and voiceFuzzyMatch's tokeniser
// agreeing) are what actually close the leg, and they cost no network.
//
// The one word that would genuinely add reach is a search_alias, and NO client can see that column.
// That gap is PINNED below rather than left implied, so it surfaces as a red test the day someone
// widens the projection.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { installFakeSpeechRecognition } from './helpers/fakeSpeechRecognition.js'

const { apiFetchSpy } = vi.hoisted(() => ({ apiFetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy, getToken: vi.fn() }) }))
vi.mock('../lib/haptics.js', () => ({
  hapticSaveCommitted: vi.fn(() => true), hapticSaveFailed: vi.fn(() => true),
  hapticDigitAccepted: vi.fn(() => true), hapticDigitRejected: vi.fn(() => true),
  hapticUndoApplied: vi.fn(() => true), hapticMatchUncertain: vi.fn(() => true),
}))

import VoiceHarvest from '../pages/VoiceHarvest.jsx'

// Real slugs, real shape. `bunching_onion` is one of the ten underscore crop types the
// BUG-LOOSEKEYREPEAT-001 row counted on prod (12 live plantings across them); `melon` is the type
// Charentais actually sits under, which is what makes the cantaloupe pin below a real case rather
// than an invented one. Tokyo Long White is the cultivar the sibling lane used for the same crop
// type in the variety picker — same fixture, so the two surfaces are demonstrably answering the
// same words rather than each passing against its own invention.
const PLANTS = [
  { id: 'p1', name: 'Tokyo Long White', archived_at: null,
    variety_ref: { id: 'v1', name: 'Tokyo Long White cultivar', crop_type_slug: 'bunching_onion', default_unit: null } },
  { id: 'p2', name: 'Suyo Long', archived_at: null,
    variety_ref: { id: 'v2', name: 'Suyo Long cultivar', crop_type_slug: 'cucumber', default_unit: null } },
  { id: 'p3', name: 'Charentais', archived_at: null,
    variety_ref: { id: 'v3', name: 'Charentais cultivar', crop_type_slug: 'melon', default_unit: null } },
]

let mic

beforeEach(() => {
  mic = installFakeSpeechRecognition(vi)
  apiFetchSpy.mockReset()
  apiFetchSpy.mockImplementation((url) => (String(url).startsWith('/api/plants')
    ? Promise.resolve({ plants: PLANTS })
    : Promise.resolve({ id: 'evt-1' })))
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function startListening() {
  render(<VoiceHarvest />)
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalled())
  await act(async () => { fireEvent.click(screen.getByTestId('voice-harvest-toggle')) })
  return mic.latest()
}
async function speak(rec, text) {
  await act(async () => { rec.deliverFinal(text) })
  await act(async () => { rec.endSession() })
}
const record = () => screen.getByTestId('voice-harvest-record').textContent
const statusText = () => screen.getByTestId('voice-harvest-status').textContent

describe('saying the crop type reaches the planting', () => {
  it('reaches a MULTI-WORD crop type from its spoken form — "bunching onion"', async () => {
    // The case that was dead: the planting is named Tokyo Long White and carries neither word, so
    // the crop-type term is the only route to it. Before the tokeniser agreed with looseKey about
    // '_', 'bunching_onion' was a single token and this utterance reached nothing.
    //
    // ASSERTS THE SELECTION, NOT THE SENTENCE, and that is deliberate. WHICH LAYER answers changes
    // with the looseKey fix landing beside this one: while looseKey still keeps '_' the strict
    // matcher misses and the fuzzy rescue answers, so the banner reads 'Heard "bunching onion" —
    // matched Tokyo Long White'; once '_' is a separator the strict matcher answers first and it
    // reads 'now say the count or the weight'. Both are correct and the record is identical, so
    // pinning the wording would make this test a report on merge order rather than on behaviour.
    const rec = await startListening()
    await speak(rec, 'bunching onion')
    expect(record()).toContain('Tokyo Long White')
    expect(record()).not.toContain('Suyo Long')
  })

  it('reaches it with the words REVERSED, which is what the token half is for', async () => {
    // The measured decision flip: 'none' before, the right planting after, for all ten underscore
    // crop types. The whole-string floor cannot do this — only tokenising the alias into two words
    // lets the consumption rule match them in any order.
    const rec = await startListening()
    await speak(rec, 'onion bunching')
    expect(record()).toContain('Tokyo Long White')
  })

  it('reaches a SINGLE-WORD crop type, the route that already worked', async () => {
    const rec = await startListening()
    await speak(rec, 'cucumber')
    expect(record()).toContain('Suyo Long')
  })

  it('does NOT match an unrelated crop word — the widening still has a floor', async () => {
    // Non-vacuity for the three above. A matcher that had become permissive enough to satisfy them
    // by accident would also satisfy this, and it must not.
    const rec = await startListening()
    await speak(rec, 'rhubarb')
    expect(statusText()).toContain('Nothing matched')
    expect(record()).not.toContain('Tokyo Long White')
  })

  it('KNOWN GAP — "cantaloupe" does NOT reach Charentais on any client, voice included', async () => {
    // This pins a gap, not a requirement, and it is deliberately written to FAIL when the gap closes.
    //
    // Charentais sits under crop type 'melon', display 'Melon'. No crop type is NAMED cantaloupe;
    // the word lives only in crop_types.search_aliases ('melon' -> 'cantaloupe, muskmelon, honeydew',
    // migrations/v4-croptypealias-001/0a-data.sql). Whole-garden search matches that column
    // server-side (lambda/dashboard/handlers.js:1117); no client can, because
    // /api/varieties/crop-types does not select it (lambda/varieties/index.js:135). So Dave's own
    // acceptance sentence holds on the server leg and on none of the four client filters.
    //
    // TO WHOEVER WIDENS THAT PROJECTION: this test is SUPPOSED to go red. Invert it — assert
    // Charentais IS selected — rather than deleting it, so the pin reports the fix.
    const rec = await startListening()
    await speak(rec, 'cantaloupe')
    expect(record()).not.toContain('Charentais')
    expect(statusText()).toContain('Nothing matched')
    // And the planting IS otherwise reachable, so this is a gap in the crop-type vocabulary rather
    // than a broken fixture.
    await speak(rec, 'melon')
    expect(record()).toContain('Charentais')
  })
})
