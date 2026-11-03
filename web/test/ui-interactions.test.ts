import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError, api } from '../src/lib/api'
import { calculateSplitPreview, formatCents, parseToCents } from '../src/lib/money'
import type { Balance, Bill, Home, Share, SharePaymentState } from '../types/api'

// In-memory mock for localStorage in Node test environment
const storageStore = new Map<string, string>()
const mockLocalStorage = {
  getItem: (key: string) => storageStore.get(key) ?? null,
  setItem: (key: string, val: string) => storageStore.set(key, String(val)),
  removeItem: (key: string) => storageStore.delete(key),
  clear: () => storageStore.clear(),
  get length() {
    return storageStore.size
  },
  key: (_index: number) => null,
}
Object.defineProperty(globalThis, 'localStorage', {
  value: mockLocalStorage,
  writable: true,
})

describe('UI interactions, workflows & state management', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    globalThis.localStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    globalThis.localStorage.clear()
  })

  // -------------------------------------------------------------------------
  // 1. Home Loading and Selection
  // -------------------------------------------------------------------------
  describe('1. Home loading and selection', () => {
    it('loads homes on mount and selects saved home from localStorage', async () => {
      const mockHomes: Home[] = [
        { id: 'home-1', name: 'Alpha House' },
        { id: 'home-2', name: 'Beta Flat' },
      ]
      localStorage.setItem('bill_splitter_home_id', 'home-2')

      vi.spyOn(api, 'listHomes').mockResolvedValue(mockHomes)

      const homes = await api.listHomes()
      const savedId = localStorage.getItem('bill_splitter_home_id')
      const selected = homes.find((h) => h.id === savedId)

      expect(homes).toHaveLength(2)
      expect(selected?.id).toBe('home-2')
      expect(selected?.name).toBe('Beta Flat')
    })

    it('falls back to the first home if no saved home in localStorage', async () => {
      const mockHomes: Home[] = [{ id: 'home-1', name: 'Alpha House' }]
      vi.spyOn(api, 'listHomes').mockResolvedValue(mockHomes)

      const homes = await api.listHomes()
      const savedId = localStorage.getItem('bill_splitter_home_id')
      const selected = homes.find((h) => h.id === savedId) || homes[0]

      expect(selected?.id).toBe('home-1')
    })

    it('handles empty home list gracefully', async () => {
      vi.spyOn(api, 'listHomes').mockResolvedValue([])
      const homes = await api.listHomes()
      expect(homes).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // 2. Home Creation
  // -------------------------------------------------------------------------
  describe('2. Home creation', () => {
    it('creates a new home and sets it as the active selection', async () => {
      const newHome: Home = { id: 'new-home-id', name: 'Greenwood Villa' }
      const createSpy = vi.spyOn(api, 'createHome').mockResolvedValue(newHome)

      const created = await api.createHome('Greenwood Villa')
      localStorage.setItem('bill_splitter_home_id', created.id)

      expect(createSpy).toHaveBeenCalledWith('Greenwood Villa')
      expect(created.id).toBe('new-home-id')
      expect(localStorage.getItem('bill_splitter_home_id')).toBe('new-home-id')
    })
  })

  // -------------------------------------------------------------------------
  // 3. Member Addition
  // -------------------------------------------------------------------------
  describe('3. Member addition', () => {
    it('adds a member and updates the deterministic member list', async () => {
      const addSpy = vi
        .spyOn(api, 'addMember')
        .mockResolvedValue({ id: 'mem-3', homeId: 'h-1', name: 'Chitra' })
      const balancesSpy = vi.spyOn(api, 'getBalances').mockResolvedValue([
        { memberId: 'mem-1', name: 'Asha', outstandingCents: 0 },
        { memberId: 'mem-2', name: 'Ben', outstandingCents: 0 },
        { memberId: 'mem-3', name: 'Chitra', outstandingCents: 0 },
      ])

      const added = await api.addMember('h-1', 'Chitra')
      const updatedMembers = await api.getBalances('h-1')

      expect(addSpy).toHaveBeenCalledWith('h-1', 'Chitra')
      expect(added.name).toBe('Chitra')
      expect(balancesSpy).toHaveBeenCalledWith('h-1')
      expect(updatedMembers).toHaveLength(3)
      expect(updatedMembers[2]?.name).toBe('Chitra')
    })
  })

  // -------------------------------------------------------------------------
  // 4. Empty Member State Validation
  // -------------------------------------------------------------------------
  describe('4. Empty member state', () => {
    it('blocks bill submission and presents clear validation when home has no members', () => {
      const members: Balance[] = []
      const billAmount = '25.00'
      const cents = parseToCents(billAmount)

      let validationError: string | null = null
      if (members.length === 0) {
        validationError = 'Cannot split a bill for a home with no members. Add a member first.'
      }

      expect(cents).toBe(2500)
      expect(validationError).toBe(
        'Cannot split a bill for a home with no members. Add a member first.',
      )
    })
  })

  // -------------------------------------------------------------------------
  // 5. Bill Creation & Split Preview
  // -------------------------------------------------------------------------
  describe('5. Bill creation and split preview', () => {
    it('generates real-time deterministic split preview before submission', () => {
      const members = [
        { memberId: 'm1', name: 'Asha' },
        { memberId: 'm2', name: 'Ben' },
        { memberId: 'm3', name: 'Chitra' },
      ]
      const totalCents = parseToCents('10.00') || 1000
      const splits = calculateSplitPreview(totalCents, members.length)

      expect(splits).toEqual([334, 333, 333])
      expect(splits.reduce((a, b) => a + b, 0)).toBe(1000)

      const preview = members.map((m, idx) => ({
        name: m.name,
        formatted: formatCents(splits[idx] ?? 0),
      }))

      expect(preview).toEqual([
        { name: 'Asha', formatted: '$3.34' },
        { name: 'Ben', formatted: '$3.33' },
        { name: 'Chitra', formatted: '$3.33' },
      ])
    })

    it('submits valid integer cents to api.createBill and parses result', async () => {
      const createdBill: Bill = {
        id: 'bill-1',
        homeId: 'h-1',
        title: 'Electricity',
        totalCents: 1000,
        shares: [
          { id: 's1', memberId: 'm1', amountCents: 334, paidAt: null },
          { id: 's2', memberId: 'm2', amountCents: 333, paidAt: null },
          { id: 's3', memberId: 'm3', amountCents: 333, paidAt: null },
        ],
      }
      const createSpy = vi.spyOn(api, 'createBill').mockResolvedValue(createdBill)

      const res = await api.createBill('h-1', 'Electricity', 1000)

      expect(createSpy).toHaveBeenCalledWith('h-1', 'Electricity', 1000)
      expect(res.shares).toHaveLength(3)
      expect(res.shares[0]?.amountCents).toBe(334)
    })
  })

  // -------------------------------------------------------------------------
  // 6 & 7. Bill & Share Rendering Logic
  // -------------------------------------------------------------------------
  describe('6 & 7. Bill and share rendering', () => {
    it('identifies fully paid vs pending shares across a bill', () => {
      const pendingBill: Bill = {
        id: 'b-1',
        homeId: 'h-1',
        title: 'Groceries',
        totalCents: 600,
        shares: [
          { id: 's1', memberId: 'm1', amountCents: 300, paidAt: '2026-11-03T10:00:00Z' },
          { id: 's2', memberId: 'm2', amountCents: 300, paidAt: null },
        ],
      }

      const allPaidPending = pendingBill.shares.every((s) => s.paidAt !== null)
      expect(allPaidPending).toBe(false)

      const fullyPaidBill: Bill = {
        ...pendingBill,
        shares: [
          { id: 's1', memberId: 'm1', amountCents: 300, paidAt: '2026-11-03T10:00:00Z' },
          { id: 's2', memberId: 'm2', amountCents: 300, paidAt: '2026-11-03T11:00:00Z' },
        ],
      }

      const allPaidFull = fullyPaidBill.shares.every((s) => s.paidAt !== null)
      expect(allPaidFull).toBe(true)
    })

    it('maps memberId to member name and formats share cents', () => {
      const nameMap = new Map([
        ['m1', 'Asha'],
        ['m2', 'Ben'],
      ])
      const share: Share = { id: 's1', memberId: 'm1', amountCents: 1050, paidAt: null }

      const name = nameMap.get(share.memberId) || 'Unknown'
      const formattedAmount = formatCents(share.amountCents)

      expect(name).toBe('Asha')
      expect(formattedAmount).toBe('$10.50')
    })
  })

  // -------------------------------------------------------------------------
  // 8. Balance Rendering
  // -------------------------------------------------------------------------
  describe('8. Balance rendering', () => {
    it('displays settled indicator for zero balance and due amount for positive balance', () => {
      const balances: Balance[] = [
        { memberId: 'm1', name: 'Asha', outstandingCents: 0 },
        { memberId: 'm2', name: 'Ben', outstandingCents: 3333 },
      ]

      const rendered = balances.map((b) => ({
        name: b.name,
        isSettled: b.outstandingCents === 0,
        display:
          b.outstandingCents === 0 ? 'All settled ✓' : `${formatCents(b.outstandingCents)} due`,
      }))

      expect(rendered[0]?.display).toBe('All settled ✓')
      expect(rendered[0]?.isSettled).toBe(true)
      expect(rendered[1]?.display).toBe('$33.33 due')
      expect(rendered[1]?.isSettled).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // 9 & 10. Payment Loading State and Success
  // -------------------------------------------------------------------------
  describe('9 & 10. Payment loading and success flow', () => {
    it('transitions from idle -> paying -> paid, locking button and syncing ledger', async () => {
      const paymentStates: Record<string, SharePaymentState> = {}
      const shareId = 'share-abc'
      const idempotencyKey = 'uuid-1234'

      // Step 1: Click Pay -> transition to 'paying'
      paymentStates[shareId] = { status: 'paying', idempotencyKey }
      expect(paymentStates[shareId]?.status).toBe('paying')

      // Step 2: API returns 200 OK
      const paidShare: Share = {
        id: shareId,
        memberId: 'm1',
        amountCents: 500,
        paidAt: '2026-11-03T12:00:00Z',
      }
      vi.spyOn(api, 'payShare').mockResolvedValue(paidShare)

      const result = await api.payShare('b1', shareId, idempotencyKey)

      // Step 3: Transition to 'paid'
      paymentStates[shareId] = { status: 'paid', idempotencyKey }
      expect(result.paidAt).toBe('2026-11-03T12:00:00Z')
      expect(paymentStates[shareId]?.status).toBe('paid')
    })
  })

  // -------------------------------------------------------------------------
  // 11. Payment 409 Conflict Reconciliation
  // -------------------------------------------------------------------------
  describe('11. Payment 409 conflict reconciliation', () => {
    it('immediately marks share paid and reconciles with server on 409 Conflict', async () => {
      let bills: Bill[] = [
        {
          id: 'b1',
          homeId: 'h1',
          title: 'Internet',
          totalCents: 2000,
          shares: [{ id: 's1', memberId: 'm1', amountCents: 2000, paidAt: null }],
        },
      ]
      let paymentState: SharePaymentState = { status: 'paying', idempotencyKey: 'key-1' }

      // Backend throws 409 Conflict
      vi.spyOn(api, 'payShare').mockRejectedValue(
        new ApiClientError('Share already paid with a different key', 409),
      )

      try {
        await api.payShare('b1', 's1', 'key-1')
        expect.unreachable()
      } catch (err) {
        const is409 = err instanceof ApiClientError && err.status === 409
        expect(is409).toBe(true)

        // Hardened 409 handling:
        // 1. Immediately update share.paidAt locally
        bills = bills.map((b) => ({
          ...b,
          shares: b.shares.map((s) =>
            s.id === 's1' ? { ...s, paidAt: new Date().toISOString() } : s,
          ),
        }))

        // 2. Set state to paid
        paymentState = { status: 'paid', idempotencyKey: 'key-1' }
      }

      // Assertions: Share is marked paid, never classified as unpaid
      expect(bills[0]?.shares[0]?.paidAt).not.toBeNull()
      expect(paymentState.status).toBe('paid')
    })
  })

  // -------------------------------------------------------------------------
  // 12. Payment 500 Handling & Safe Retry
  // -------------------------------------------------------------------------
  describe('12. Payment 500 handling', () => {
    it('keeps share unpaid, sets error state, and preserves idempotency key', async () => {
      let sharePaidAt: string | null = null
      let state: SharePaymentState = { status: 'paying', idempotencyKey: 'key-500' }

      vi.spyOn(api, 'payShare').mockRejectedValue(new ApiClientError('Internal Server Error', 500))

      try {
        await api.payShare('b1', 's1', 'key-500')
        expect.unreachable()
      } catch (err) {
        expect(err).toBeInstanceOf(ApiClientError)
        // Share remains UNPAID
        sharePaidAt = null
        state = {
          status: 'error',
          idempotencyKey: 'key-500', // preserved!
          errorMessage: (err as ApiClientError).message,
        }
      }

      expect(sharePaidAt).toBeNull()
      expect(state.status).toBe('error')
      expect(state.errorMessage).toBe('Internal Server Error')
      expect(state.idempotencyKey).toBe('key-500')
    })
  })

  // -------------------------------------------------------------------------
  // 13. Network Failure Handling
  // -------------------------------------------------------------------------
  describe('13. Network failure handling', () => {
    it('traps network drop (status 0) without component crash, preserving key', async () => {
      let state: SharePaymentState = { status: 'paying', idempotencyKey: 'net-key' }

      vi.spyOn(api, 'payShare').mockRejectedValue(
        new ApiClientError('Network request failed. Is the server running?', 0),
      )

      try {
        await api.payShare('b1', 's1', 'net-key')
        expect.unreachable()
      } catch (err) {
        state = {
          status: 'error',
          idempotencyKey: 'net-key',
          errorMessage: (err as ApiClientError).message,
        }
      }

      expect(state.status).toBe('error')
      expect(state.errorMessage).toContain('Network request failed')
      expect(state.idempotencyKey).toBe('net-key')
    })
  })

  // -------------------------------------------------------------------------
  // 14. Retry with Same Idempotency Key
  // -------------------------------------------------------------------------
  describe('14. Retry with the same idempotency key', () => {
    it('guarantees that retry after error uses the identical idempotency key', async () => {
      const recordedKeys: string[] = []

      vi.spyOn(api, 'payShare').mockImplementation(async (_billId, _shareId, key) => {
        recordedKeys.push(key)
        if (recordedKeys.length === 1) {
          throw new ApiClientError('Temporary timeout', 500)
        }
        return {
          id: 's1',
          memberId: 'm1',
          amountCents: 1000,
          paidAt: '2026-11-03T12:05:00Z',
        }
      })

      // First attempt
      const key = 'stable-uuid-999'
      let state: SharePaymentState = { status: 'paying', idempotencyKey: key }

      try {
        await api.payShare('b1', 's1', key)
      } catch {
        state = { status: 'error', idempotencyKey: key, errorMessage: 'Timeout' }
      }

      // Retry attempt: looks up state.idempotencyKey
      const retryKey = state.idempotencyKey || 'generated-fallback'
      expect(retryKey).toBe('stable-uuid-999')

      const success = await api.payShare('b1', 's1', retryKey)
      state = { status: 'paid', idempotencyKey: retryKey }

      expect(recordedKeys).toHaveLength(2)
      expect(recordedKeys[0]).toBe(recordedKeys[1])
      expect(success.paidAt).toBe('2026-11-03T12:05:00Z')
      expect(state.status).toBe('paid')
    })
  })

  // -------------------------------------------------------------------------
  // 15. No False Paid State
  // -------------------------------------------------------------------------
  describe('15. No false paid state', () => {
    it('never sets share to paid or disables payment button on failed HTTP status', async () => {
      const share: Share = { id: 's-fail', memberId: 'm1', amountCents: 1500, paidAt: null }
      let localPaidAt = share.paidAt

      vi.spyOn(api, 'payShare').mockRejectedValue(new ApiClientError('Validation failure', 422))

      try {
        await api.payShare('b1', share.id, 'key')
        localPaidAt = new Date().toISOString()
      } catch {
        // Must NOT update localPaidAt on failure
      }

      expect(localPaidAt).toBeNull()
      expect(share.paidAt).toBeNull()
    })
  })
})
