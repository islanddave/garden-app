// BUG-PLANTRESTORESTRAND-001 — when restoring a planting brought its deleted seed packet back, the
// Recently deleted message says so (words: Dave 2026-10-12); every other restore reads as before.
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { DeletedEntitySection } from '../pages/RecentlyDeleted.jsx'
import { DELETED_ENTITY_KINDS } from '../lib/deletedEntities.js'

vi.mock('../lib/dataCache.js', async (orig) => ({ ...(await orig()), invalidatePrefix: vi.fn() }))

const kindOf = (path) => DELETED_ENTITY_KINDS.find((k) => k.listPath === path)
const PLANTS = kindOf('/api/plants/deleted')

function mount(kind, reply) {
  const row = { id: 'p1', name: 'Shishito', deleted_at: '2026-10-10T12:00:00Z' }
  const apiFetch = vi.fn((path, opts) =>
    Promise.resolve(opts?.method === 'POST' ? reply : { [kind.responseKey]: [row] }))
  const toast = { show: vi.fn() }
  render(<DeletedEntitySection kind={kind} apiFetch={apiFetch} toast={toast} />)
  return { apiFetch, toast }
}

describe('Recently deleted — a restored planting that brought its packet back', () => {
  it('says the packet came back when the answer carries restored_packet_id', async () => {
    const { toast } = mount(PLANTS, { id: 'p1', restored_packet_id: 'k1' })
    fireEvent.click(await screen.findByRole('button', { name: /^Restore/ }))
    await waitFor(() => expect(toast.show).toHaveBeenCalledWith({
      message: 'Planting restored. Its seed packet was brought back too.',
    }))
  })

  it('reads "Planting restored" when no packet came back', async () => {
    const { toast } = mount(PLANTS, { id: 'p1' })
    fireEvent.click(await screen.findByRole('button', { name: /^Restore/ }))
    await waitFor(() => expect(toast.show).toHaveBeenCalledWith({ message: 'Planting restored' }))
  })

  it('leaves every other kind on its own fixed words, whatever the answer carries', async () => {
    const other = DELETED_ENTITY_KINDS.find((k) => k !== PLANTS)
    const { toast } = mount(other, { id: 'p1', restored_packet_id: 'k1' })
    fireEvent.click(await screen.findByRole('button', { name: /^Restore/ }))
    await waitFor(() => expect(toast.show).toHaveBeenCalledWith({ message: other.toast }))
  })
})
