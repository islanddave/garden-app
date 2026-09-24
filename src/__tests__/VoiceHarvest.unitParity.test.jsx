// V5-VOICEVOCAB-001 (lane D4, review BLOCKING-1) — one-breath UNIT sentences for the digit-named
// plantings save exactly what prod saves.
//
// THE REGRESSION THIS PINS. Lane D4's bare-amount reader was asked before the unit reader, and its
// refusals pre-empted it: "cherry rescue 1 3 count", "danvers one twenty six three count", "1884 3 count
// 231 grams next" with another crop selected — saved on prod, REFUSED on the lane build. The pre-promote
// regression-impact review measured 58 of 200 real-name sentences like that (review-regression-impact.md
// §3); the lane's own tests had checked the unit form only on the pure function, never on the page. Dave
// has voice-logged Cherry Rescue 1 six times.
//
// THE EXPECTATIONS ARE PROD'S, AND THEY ARE LITERALS. Each row's POST was recorded by driving a replica of
// prod's page (garden-app 3eeccecadb148a02177a6d5cdf32427412aa5f62: page + grammar, same debouncer, same
// fake recogniser and mocks) through the same lines, on 2026-09-24, then written here as data. Nothing
// here derives from the code under test. 13 census plantings (every alias with a digit or number word)
// plus Big Boy as a control, digit and word forms, the review's five unit tails, with and without another
// crop selected first: 230 sentences, 210 save, 20 save nothing on prod (the Super Sweet 100 forms — two
// plantings share that name — and three shapes with no count).
//
// Each script: [selection?], the sentence, then "next" — 700 ms between finals, the review's gap.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { installFakeSpeechRecognition } from './helpers/fakeSpeechRecognition.js'

const { apiFetchSpy } = vi.hoisted(() => ({ apiFetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy, getToken: vi.fn() }) }))
vi.mock('../lib/haptics.js', () => ({
  hapticSaveCommitted: vi.fn(), hapticSaveFailed: vi.fn(),
  hapticDigitAccepted: vi.fn(), hapticDigitRejected: vi.fn(), hapticUndoApplied: vi.fn(),
  hapticMatchUncertain: vi.fn(),
}))

import VoiceHarvest from '../pages/VoiceHarvest.jsx'
import { VOCAB } from './voiceHarvest.vocabulary.fixture.js'

let mic
beforeEach(() => {
  mic = installFakeSpeechRecognition(vi)
  apiFetchSpy.mockReset()
  apiFetchSpy.mockImplementation((url) => (String(url).startsWith('/api/plants')
    ? Promise.resolve({ plants: VOCAB }) : Promise.resolve({ id: 'evt-1' })))
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })

async function say(lines) {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  render(<VoiceHarvest />)
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalled())
  await act(async () => { fireEvent.click(screen.getByTestId('voice-harvest-toggle')) })
  const rec = mic.latest()
  for (const line of lines) {
    await act(async () => { rec.deliverFinal(line) })
    await act(async () => { rec.endSession() })
    await act(async () => { await vi.advanceTimersByTimeAsync(700) })
  }
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
}
const saved = () => apiFetchSpy.mock.calls
  .filter(([url, opts]) => url === '/api/events' && opts?.method === 'POST')
  .map(([, opts]) => JSON.parse(opts.body))
const nameOf = (id) => VOCAB.find((p) => p.id === id)?.name

// [sentence, crop selected first, [planting, quantity, unit, weight grams | null] | null = prod saved nothing]
const PROD = [
  ["1884 3 count", null, ["1884", 3, "count", null]],
  ["1884 3 count", "Suyo Long", ["1884", 3, "count", null]],
  ["1884 three count", null, ["1884", 3, "count", null]],
  ["1884 three count", "Suyo Long", ["1884", 3, "count", null]],
  ["1884 three count 231 grams next", null, ["1884", 3, "count", 231]],
  ["1884 three count 231 grams next", "Suyo Long", ["1884", 3, "count", 231]],
  ["1884 3 count 231 grams next", null, ["1884", 3, "count", 231]],
  ["1884 3 count 231 grams next", "Suyo Long", ["1884", 3, "count", 231]],
  ["1884 231 grams 3 count", null, ["1884", 3, "count", 231]],
  ["1884 231 grams 3 count", "Suyo Long", ["1884", 3, "count", 231]],
  ["eighteen eighty four 3 count", null, ["1884", 3, "count", null]],
  ["eighteen eighty four 3 count", "Suyo Long", ["1884", 3, "count", null]],
  ["eighteen eighty four three count", null, ["1884", 3, "count", null]],
  ["eighteen eighty four three count", "Suyo Long", ["1884", 3, "count", null]],
  ["eighteen eighty four three count 231 grams next", null, ["1884", 3, "count", 231]],
  ["eighteen eighty four three count 231 grams next", "Suyo Long", ["1884", 3, "count", 231]],
  ["eighteen eighty four 3 count 231 grams next", null, ["1884", 3, "count", 231]],
  ["eighteen eighty four 3 count 231 grams next", "Suyo Long", ["1884", 3, "count", 231]],
  ["eighteen eighty four 231 grams 3 count", null, ["1884", 3, "count", 231]],
  ["eighteen eighty four 231 grams 3 count", "Suyo Long", ["1884", 3, "count", 231]],
  ["danvers 126 3 count", null, ["Danvers 126 Carrot", 3, "count", null]],
  ["danvers 126 3 count", "Suyo Long", ["Danvers 126 Carrot", 3, "count", null]],
  ["danvers 126 three count", null, ["Danvers 126 Carrot", 3, "count", null]],
  ["danvers 126 three count", "Suyo Long", ["Danvers 126 Carrot", 3, "count", null]],
  ["danvers 126 three count 231 grams next", null, ["Danvers 126 Carrot", 3, "count", 231]],
  ["danvers 126 three count 231 grams next", "Suyo Long", ["Danvers 126 Carrot", 3, "count", 231]],
  ["danvers 126 3 count 231 grams next", null, ["Danvers 126 Carrot", 3, "count", 231]],
  ["danvers 126 3 count 231 grams next", "Suyo Long", ["Danvers 126 Carrot", 3, "count", 231]],
  ["danvers 126 231 grams 3 count", null, ["Danvers 126 Carrot", 3, "count", 231]],
  ["danvers 126 231 grams 3 count", "Suyo Long", ["Danvers 126 Carrot", 3, "count", 231]],
  ["danvers one twenty six 3 count", null, ["Danvers 126 Carrot", 3, "count", null]],
  ["danvers one twenty six 3 count", "Suyo Long", ["Danvers 126 Carrot", 3, "count", null]],
  ["danvers one twenty six three count", null, ["Danvers 126 Carrot", 3, "count", null]],
  ["danvers one twenty six three count", "Suyo Long", ["Danvers 126 Carrot", 3, "count", null]],
  ["danvers one twenty six three count 231 grams next", null, ["Danvers 126 Carrot", 3, "count", 231]],
  ["danvers one twenty six three count 231 grams next", "Suyo Long", ["Danvers 126 Carrot", 3, "count", 231]],
  ["danvers one twenty six 3 count 231 grams next", null, ["Danvers 126 Carrot", 3, "count", 231]],
  ["danvers one twenty six 3 count 231 grams next", "Suyo Long", ["Danvers 126 Carrot", 3, "count", 231]],
  ["danvers one twenty six 231 grams 3 count", null, ["Danvers 126 Carrot", 3, "count", 231]],
  ["danvers one twenty six 231 grams 3 count", "Suyo Long", ["Danvers 126 Carrot", 3, "count", 231]],
  ["cherry rescue 1 3 count", null, ["Cherry Rescue 1", 3, "count", null]],
  ["cherry rescue 1 3 count", "Suyo Long", ["Cherry Rescue 1", 3, "count", null]],
  ["cherry rescue 1 three count", null, ["Cherry Rescue 1", 3, "count", null]],
  ["cherry rescue 1 three count", "Suyo Long", ["Cherry Rescue 1", 3, "count", null]],
  ["cherry rescue 1 three count 231 grams next", null, ["Cherry Rescue 1", 3, "count", 231]],
  ["cherry rescue 1 three count 231 grams next", "Suyo Long", ["Cherry Rescue 1", 3, "count", 231]],
  ["cherry rescue 1 3 count 231 grams next", null, ["Cherry Rescue 1", 3, "count", 231]],
  ["cherry rescue 1 3 count 231 grams next", "Suyo Long", ["Cherry Rescue 1", 3, "count", 231]],
  ["cherry rescue 1 231 grams 3 count", null, ["Cherry Rescue 1", 3, "count", 231]],
  ["cherry rescue 1 231 grams 3 count", "Suyo Long", ["Cherry Rescue 1", 3, "count", 231]],
  ["cherry rescue one 3 count", null, ["Cherry Rescue 1", 3, "count", null]],
  ["cherry rescue one 3 count", "Suyo Long", ["Cherry Rescue 1", 3, "count", null]],
  ["cherry rescue one three count", null, ["Cherry Rescue 1", 3, "count", null]],
  ["cherry rescue one three count", "Suyo Long", ["Cherry Rescue 1", 3, "count", null]],
  ["cherry rescue one three count 231 grams next", null, ["Cherry Rescue 1", 3, "count", 231]],
  ["cherry rescue one three count 231 grams next", "Suyo Long", ["Cherry Rescue 1", 3, "count", 231]],
  ["cherry rescue one 3 count 231 grams next", null, ["Cherry Rescue 1", 3, "count", 231]],
  ["cherry rescue one 3 count 231 grams next", "Suyo Long", ["Cherry Rescue 1", 3, "count", 231]],
  ["cherry rescue one 231 grams 3 count", null, ["Cherry Rescue 1", 3, "count", 231]],
  ["cherry rescue one 231 grams 3 count", "Suyo Long", ["Cherry Rescue 1", 3, "count", 231]],
  ["clemson spineless 80 3 count", null, ["Clemson Spineless 80", 3, "count", null]],
  ["clemson spineless 80 3 count", "Suyo Long", ["Clemson Spineless 80", 3, "count", null]],
  ["clemson spineless 80 three count", null, ["Clemson Spineless 80", 3, "count", null]],
  ["clemson spineless 80 three count", "Suyo Long", ["Clemson Spineless 80", 3, "count", null]],
  ["clemson spineless 80 three count 231 grams next", null, ["Clemson Spineless 80", 3, "count", 231]],
  ["clemson spineless 80 three count 231 grams next", "Suyo Long", ["Clemson Spineless 80", 3, "count", 231]],
  ["clemson spineless 80 3 count 231 grams next", null, ["Clemson Spineless 80", 3, "count", 231]],
  ["clemson spineless 80 3 count 231 grams next", "Suyo Long", ["Clemson Spineless 80", 3, "count", 231]],
  ["clemson spineless 80 231 grams 3 count", null, ["Clemson Spineless 80", 3, "count", 231]],
  ["clemson spineless 80 231 grams 3 count", "Suyo Long", ["Clemson Spineless 80", 3, "count", 231]],
  ["clemson spineless eighty 3 count", null, ["Clemson Spineless 80", 3, "count", null]],
  ["clemson spineless eighty 3 count", "Suyo Long", ["Clemson Spineless 80", 3, "count", null]],
  ["clemson spineless eighty three count", null, ["Clemson Spineless 80", 3, "count", null]],
  ["clemson spineless eighty three count", "Suyo Long", ["Clemson Spineless 80", 3, "count", null]],
  ["clemson spineless eighty three count 231 grams next", null, ["Clemson Spineless 80", 3, "count", 231]],
  ["clemson spineless eighty three count 231 grams next", "Suyo Long", ["Clemson Spineless 80", 3, "count", 231]],
  ["clemson spineless eighty 3 count 231 grams next", null, ["Clemson Spineless 80", 3, "count", 231]],
  ["clemson spineless eighty 3 count 231 grams next", "Suyo Long", ["Clemson Spineless 80", 3, "count", 231]],
  ["clemson spineless eighty 231 grams 3 count", null, ["Clemson Spineless 80", 3, "count", 231]],
  ["clemson spineless eighty 231 grams 3 count", "Suyo Long", ["Clemson Spineless 80", 3, "count", 231]],
  ["alaska mix nasturtium 1 3 count", null, ["Alaska Mix Nasturtium 1", 3, "count", null]],
  ["alaska mix nasturtium 1 3 count", "Suyo Long", ["Alaska Mix Nasturtium 1", 3, "count", null]],
  ["alaska mix nasturtium 1 three count", null, ["Alaska Mix Nasturtium 1", 3, "count", null]],
  ["alaska mix nasturtium 1 three count", "Suyo Long", ["Alaska Mix Nasturtium 1", 3, "count", null]],
  ["alaska mix nasturtium 1 three count 231 grams next", null, ["Alaska Mix Nasturtium 1", 3, "count", 231]],
  ["alaska mix nasturtium 1 three count 231 grams next", "Suyo Long", ["Alaska Mix Nasturtium 1", 3, "count", 231]],
  ["alaska mix nasturtium 1 3 count 231 grams next", null, ["Alaska Mix Nasturtium 1", 3, "count", 231]],
  ["alaska mix nasturtium 1 3 count 231 grams next", "Suyo Long", ["Alaska Mix Nasturtium 1", 3, "count", 231]],
  ["alaska mix nasturtium 1 231 grams 3 count", null, ["Alaska Mix Nasturtium 1", 3, "count", 231]],
  ["alaska mix nasturtium 1 231 grams 3 count", "Suyo Long", ["Alaska Mix Nasturtium 1", 3, "count", 231]],
  ["alaska mix nasturtium one 3 count", null, ["Alaska Mix Nasturtium 1", 3, "count", null]],
  ["alaska mix nasturtium one 3 count", "Suyo Long", ["Alaska Mix Nasturtium 1", 3, "count", null]],
  ["alaska mix nasturtium one three count", null, ["Alaska Mix Nasturtium 1", 3, "count", null]],
  ["alaska mix nasturtium one three count", "Suyo Long", ["Alaska Mix Nasturtium 1", 3, "count", null]],
  ["alaska mix nasturtium one three count 231 grams next", null, ["Alaska Mix Nasturtium 1", 3, "count", 231]],
  ["alaska mix nasturtium one three count 231 grams next", "Suyo Long", ["Alaska Mix Nasturtium 1", 3, "count", 231]],
  ["alaska mix nasturtium one 3 count 231 grams next", null, ["Alaska Mix Nasturtium 1", 3, "count", 231]],
  ["alaska mix nasturtium one 3 count 231 grams next", "Suyo Long", ["Alaska Mix Nasturtium 1", 3, "count", 231]],
  ["alaska mix nasturtium one 231 grams 3 count", null, ["Alaska Mix Nasturtium 1", 3, "count", 231]],
  ["alaska mix nasturtium one 231 grams 3 count", "Suyo Long", ["Alaska Mix Nasturtium 1", 3, "count", 231]],
  ["fairway orange coleus clone 1 3 count", null, ["Fairway Orange Coleus Clone 1", 3, "count", null]],
  ["fairway orange coleus clone 1 3 count", "Suyo Long", ["Fairway Orange Coleus Clone 1", 3, "count", null]],
  ["fairway orange coleus clone 1 three count", null, ["Fairway Orange Coleus Clone 1", 3, "count", null]],
  ["fairway orange coleus clone 1 three count", "Suyo Long", ["Fairway Orange Coleus Clone 1", 3, "count", null]],
  ["fairway orange coleus clone 1 three count 231 grams next", null, ["Fairway Orange Coleus Clone 1", 3, "count", 231]],
  ["fairway orange coleus clone 1 three count 231 grams next", "Suyo Long", ["Fairway Orange Coleus Clone 1", 3, "count", 231]],
  ["fairway orange coleus clone 1 3 count 231 grams next", null, ["Fairway Orange Coleus Clone 1", 3, "count", 231]],
  ["fairway orange coleus clone 1 3 count 231 grams next", "Suyo Long", ["Fairway Orange Coleus Clone 1", 3, "count", 231]],
  ["fairway orange coleus clone 1 231 grams 3 count", null, ["Fairway Orange Coleus Clone 1", 3, "count", 231]],
  ["fairway orange coleus clone 1 231 grams 3 count", "Suyo Long", ["Fairway Orange Coleus Clone 1", 3, "count", 231]],
  ["fairway orange coleus clone one 3 count", null, ["Fairway Orange Coleus Clone 1", 3, "count", null]],
  ["fairway orange coleus clone one 3 count", "Suyo Long", ["Fairway Orange Coleus Clone 1", 3, "count", null]],
  ["fairway orange coleus clone one three count", null, ["Fairway Orange Coleus Clone 1", 3, "count", null]],
  ["fairway orange coleus clone one three count", "Suyo Long", ["Fairway Orange Coleus Clone 1", 3, "count", null]],
  ["fairway orange coleus clone one three count 231 grams next", null, ["Fairway Orange Coleus Clone 1", 3, "count", 231]],
  ["fairway orange coleus clone one three count 231 grams next", "Suyo Long", ["Fairway Orange Coleus Clone 1", 3, "count", 231]],
  ["fairway orange coleus clone one 3 count 231 grams next", null, ["Fairway Orange Coleus Clone 1", 3, "count", 231]],
  ["fairway orange coleus clone one 3 count 231 grams next", "Suyo Long", ["Fairway Orange Coleus Clone 1", 3, "count", 231]],
  ["fairway orange coleus clone one 231 grams 3 count", null, ["Fairway Orange Coleus Clone 1", 3, "count", 231]],
  ["fairway orange coleus clone one 231 grams 3 count", "Suyo Long", ["Fairway Orange Coleus Clone 1", 3, "count", 231]],
  ["super sweet 100 rescue 3 count", null, ["Super Sweet 100 Rescue", 3, "count", null]],
  ["super sweet 100 rescue 3 count", "Suyo Long", ["Super Sweet 100 Rescue", 3, "count", null]],
  ["super sweet 100 rescue three count", null, ["Super Sweet 100 Rescue", 3, "count", null]],
  ["super sweet 100 rescue three count", "Suyo Long", ["Super Sweet 100 Rescue", 3, "count", null]],
  ["super sweet 100 rescue three count 231 grams next", null, ["Super Sweet 100 Rescue", 3, "count", 231]],
  ["super sweet 100 rescue three count 231 grams next", "Suyo Long", ["Super Sweet 100 Rescue", 3, "count", 231]],
  ["super sweet 100 rescue 3 count 231 grams next", null, ["Super Sweet 100 Rescue", 3, "count", 231]],
  ["super sweet 100 rescue 3 count 231 grams next", "Suyo Long", ["Super Sweet 100 Rescue", 3, "count", 231]],
  ["super sweet 100 rescue 231 grams 3 count", null, ["Super Sweet 100 Rescue", 3, "count", 231]],
  ["super sweet 100 rescue 231 grams 3 count", "Suyo Long", ["Super Sweet 100 Rescue", 3, "count", 231]],
  ["super sweet one hundred rescue 3 count", null, ["Super Sweet 100 Rescue", 3, "count", null]],
  ["super sweet one hundred rescue 3 count", "Suyo Long", ["Super Sweet 100 Rescue", 3, "count", null]],
  ["super sweet one hundred rescue three count", null, ["Super Sweet 100 Rescue", 3, "count", null]],
  ["super sweet one hundred rescue three count", "Suyo Long", ["Super Sweet 100 Rescue", 3, "count", null]],
  ["super sweet one hundred rescue three count 231 grams next", null, ["Super Sweet 100 Rescue", 3, "count", 231]],
  ["super sweet one hundred rescue three count 231 grams next", "Suyo Long", ["Super Sweet 100 Rescue", 3, "count", 231]],
  ["super sweet one hundred rescue 3 count 231 grams next", null, ["Super Sweet 100 Rescue", 3, "count", 231]],
  ["super sweet one hundred rescue 3 count 231 grams next", "Suyo Long", ["Super Sweet 100 Rescue", 3, "count", 231]],
  ["super sweet one hundred rescue 231 grams 3 count", null, ["Super Sweet 100 Rescue", 3, "count", 231]],
  ["super sweet one hundred rescue 231 grams 3 count", "Suyo Long", ["Super Sweet 100 Rescue", 3, "count", 231]],
  ["chinese 5 color 3 count", null, ["Chinese 5-Color", 3, "count", null]],
  ["chinese 5 color 3 count", "Suyo Long", ["Chinese 5-Color", 3, "count", null]],
  ["chinese 5 color three count", null, ["Chinese 5-Color", 3, "count", null]],
  ["chinese 5 color three count", "Suyo Long", ["Chinese 5-Color", 3, "count", null]],
  ["chinese 5 color three count 231 grams next", null, ["Chinese 5-Color", 3, "count", 231]],
  ["chinese 5 color three count 231 grams next", "Suyo Long", ["Chinese 5-Color", 3, "count", 231]],
  ["chinese 5 color 3 count 231 grams next", null, ["Chinese 5-Color", 3, "count", 231]],
  ["chinese 5 color 3 count 231 grams next", "Suyo Long", ["Chinese 5-Color", 3, "count", 231]],
  ["chinese 5 color 231 grams 3 count", null, ["Chinese 5-Color", 3, "count", 231]],
  ["chinese 5 color 231 grams 3 count", "Suyo Long", ["Chinese 5-Color", 3, "count", 231]],
  ["chinese five color 3 count", null, ["Chinese 5-Color", 3, "count", null]],
  ["chinese five color 3 count", "Suyo Long", ["Chinese 5-Color", 3, "count", null]],
  ["chinese five color three count", null, ["Chinese 5-Color", 3, "count", null]],
  ["chinese five color three count", "Suyo Long", ["Chinese 5-Color", 3, "count", null]],
  ["chinese five color three count 231 grams next", null, ["Chinese 5-Color", 3, "count", 231]],
  ["chinese five color three count 231 grams next", "Suyo Long", ["Chinese 5-Color", 3, "count", 231]],
  ["chinese five color 3 count 231 grams next", null, ["Chinese 5-Color", 3, "count", 231]],
  ["chinese five color 3 count 231 grams next", "Suyo Long", ["Chinese 5-Color", 3, "count", 231]],
  ["chinese five color 231 grams 3 count", null, ["Chinese 5-Color", 3, "count", 231]],
  ["chinese five color 231 grams 3 count", "Suyo Long", ["Chinese 5-Color", 3, "count", 231]],
  ["marvel of four seasons 3 count", null, ["Marvel of Four Seasons Butterhead Lettuce", 3, "count", null]],
  ["marvel of four seasons 3 count", "Suyo Long", ["Marvel of Four Seasons Butterhead Lettuce", 3, "count", null]],
  ["marvel of four seasons three count", null, ["Marvel of Four Seasons Butterhead Lettuce", 3, "count", null]],
  ["marvel of four seasons three count", "Suyo Long", ["Marvel of Four Seasons Butterhead Lettuce", 3, "count", null]],
  ["marvel of four seasons three count 231 grams next", null, ["Marvel of Four Seasons Butterhead Lettuce", 3, "count", 231]],
  ["marvel of four seasons three count 231 grams next", "Suyo Long", ["Marvel of Four Seasons Butterhead Lettuce", 3, "count", 231]],
  ["marvel of four seasons 3 count 231 grams next", null, ["Marvel of Four Seasons Butterhead Lettuce", 3, "count", 231]],
  ["marvel of four seasons 3 count 231 grams next", "Suyo Long", ["Marvel of Four Seasons Butterhead Lettuce", 3, "count", 231]],
  ["marvel of four seasons 231 grams 3 count", null, ["Marvel of Four Seasons Butterhead Lettuce", 3, "count", 231]],
  ["marvel of four seasons 231 grams 3 count", "Suyo Long", ["Marvel of Four Seasons Butterhead Lettuce", 3, "count", 231]],
  ["peach tree 3 count", null, ["Peach tree", 3, "count", null]],
  ["peach tree 3 count", "Suyo Long", ["Peach tree", 3, "count", null]],
  ["peach tree three count", null, ["Peach tree", 3, "count", null]],
  ["peach tree three count", "Suyo Long", ["Peach tree", 3, "count", null]],
  ["peach tree three count 231 grams next", null, ["Peach tree", 3, "count", 231]],
  ["peach tree three count 231 grams next", "Suyo Long", ["Peach tree", 3, "count", 231]],
  ["peach tree 3 count 231 grams next", null, ["Peach tree", 3, "count", 231]],
  ["peach tree 3 count 231 grams next", "Suyo Long", ["Peach tree", 3, "count", 231]],
  ["peach tree 231 grams 3 count", null, ["Peach tree", 3, "count", 231]],
  ["peach tree 231 grams 3 count", "Suyo Long", ["Peach tree", 3, "count", 231]],
  ["armageddon f1 3 count", null, ["Armageddon", 3, "count", null]],
  ["armageddon f1 3 count", "Suyo Long", ["Armageddon", 3, "count", null]],
  ["armageddon f1 three count", null, ["Armageddon", 3, "count", null]],
  ["armageddon f1 three count", "Suyo Long", ["Armageddon", 3, "count", null]],
  ["armageddon f1 three count 231 grams next", null, ["Armageddon", 3, "count", 231]],
  ["armageddon f1 three count 231 grams next", "Suyo Long", ["Armageddon", 3, "count", 231]],
  ["armageddon f1 3 count 231 grams next", null, ["Armageddon", 3, "count", 231]],
  ["armageddon f1 3 count 231 grams next", "Suyo Long", ["Armageddon", 3, "count", 231]],
  ["armageddon f1 231 grams 3 count", null, ["Armageddon", 3, "count", 231]],
  ["armageddon f1 231 grams 3 count", "Suyo Long", ["Armageddon", 3, "count", 231]],
  ["big boy 3 count", null, ["Big Boy", 3, "count", null]],
  ["big boy 3 count", "Suyo Long", ["Big Boy", 3, "count", null]],
  ["big boy three count", null, ["Big Boy", 3, "count", null]],
  ["big boy three count", "Suyo Long", ["Big Boy", 3, "count", null]],
  ["big boy three count 231 grams next", null, ["Big Boy", 3, "count", 231]],
  ["big boy three count 231 grams next", "Suyo Long", ["Big Boy", 3, "count", 231]],
  ["big boy 3 count 231 grams next", null, ["Big Boy", 3, "count", 231]],
  ["big boy 3 count 231 grams next", "Suyo Long", ["Big Boy", 3, "count", 231]],
  ["big boy 231 grams 3 count", null, ["Big Boy", 3, "count", 231]],
  ["big boy 231 grams 3 count", "Suyo Long", ["Big Boy", 3, "count", 231]],
  ["megatron f1 3 count", null, ["Megatron Jalapeños", 3, "count", null]],
  ["megatron f1 3 count", "Suyo Long", ["Megatron Jalapeños", 3, "count", null]],
  ["megatron f1 three count", null, ["Megatron Jalapeños", 3, "count", null]],
  ["megatron f1 three count", "Suyo Long", ["Megatron Jalapeños", 3, "count", null]],
  ["megatron f1 three count 231 grams next", null, ["Megatron Jalapeños", 3, "count", 231]],
  ["megatron f1 three count 231 grams next", "Suyo Long", ["Megatron Jalapeños", 3, "count", 231]],
  ["megatron f1 3 count 231 grams next", null, ["Megatron Jalapeños", 3, "count", 231]],
  ["megatron f1 3 count 231 grams next", "Suyo Long", ["Megatron Jalapeños", 3, "count", 231]],
  ["megatron f1 231 grams 3 count", null, ["Megatron Jalapeños", 3, "count", 231]],
  ["megatron f1 231 grams 3 count", "Suyo Long", ["Megatron Jalapeños", 3, "count", 231]],
  ["super sweet 100 3 count", null, null],
  ["super sweet 100 3 count", "Suyo Long", null],
  ["super sweet 100 three count", null, null],
  ["super sweet 100 three count", "Suyo Long", null],
  ["super sweet 100 three count 231 grams next", null, null],
  ["super sweet 100 three count 231 grams next", "Suyo Long", null],
  ["super sweet 100 3 count 231 grams next", null, null],
  ["super sweet 100 3 count 231 grams next", "Suyo Long", null],
  ["super sweet 100 231 grams 3 count", null, null],
  ["super sweet 100 231 grams 3 count", "Suyo Long", null],
  ["super sweet one hundred 3 count", null, null],
  ["super sweet one hundred 3 count", "Suyo Long", null],
  ["super sweet one hundred three count", null, null],
  ["super sweet one hundred three count", "Suyo Long", null],
  ["super sweet one hundred three count 231 grams next", null, null],
  ["super sweet one hundred three count 231 grams next", "Suyo Long", null],
  ["super sweet one hundred 3 count 231 grams next", null, null],
  ["super sweet one hundred 3 count 231 grams next", "Suyo Long", null],
  ["super sweet one hundred 231 grams 3 count", null, null],
  ["super sweet one hundred 231 grams 3 count", "Suyo Long", null]
]

describe('BLOCKING-1 — a one-breath unit sentence for a digit-named planting saves what prod saves', () => {
  it('the table is the census, not a sample: 13 digit/number-word plantings plus the control', () => {
    expect(PROD).toHaveLength(230)
    // Every census planting saves on prod except Super Sweet 100, whose name its Rescue shares.
    expect([...new Set(PROD.filter((r) => r[2]).map((r) => r[2][0]))].sort()).toEqual([
      '1884', 'Alaska Mix Nasturtium 1', 'Armageddon', 'Big Boy', 'Cherry Rescue 1', 'Chinese 5-Color',
      'Clemson Spineless 80', 'Danvers 126 Carrot', 'Fairway Orange Coleus Clone 1',
      'Marvel of Four Seasons Butterhead Lettuce', 'Megatron Jalapeños', 'Peach tree', 'Super Sweet 100 Rescue',
    ])
    expect(PROD.filter((r) => !r[2])).toHaveLength(20)
  })

  it.each(PROD)('%j after %j', async (sentence, selected, expected) => {
    await say([...(selected ? [selected] : []), sentence, 'next'])
    const rows = saved().map((b) => [nameOf(b.plant_id), b.harvest.quantity, b.harvest.unit, b.harvest.weight ?? null])
    expect(rows).toEqual(expected ? [expected] : [])
    // Every one of these was said with its units, so nothing on a saved row was assumed.
    for (const b of saved()) expect(b.metadata.assumed_units).toEqual([])
  })
})
