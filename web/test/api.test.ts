import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError, api } from '../src/lib/api'

describe('api client', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  describe('error handling', () => {
    it('throws ApiClientError with server error message on 400/404/409/422', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ error: 'Home not found' }),
      } as Response)

      await expect(api.getHome('invalid-id')).rejects.toThrow(ApiClientError)
      await expect(api.getHome('invalid-id')).rejects.toThrow('Home not found')
    })

    it('handles 409 conflict on duplicate payment with different key', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ error: 'Share already paid with a different key' }),
      } as Response)

      try {
        await api.payShare('bill-1', 'share-1', 'new-key')
        expect.unreachable('Should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(ApiClientError)
        expect((err as ApiClientError).status).toBe(409)
        expect((err as ApiClientError).message).toBe('Share already paid with a different key')
      }
    })

    it('handles network failure gracefully without crashing', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Failed to fetch'))

      try {
        await api.listHomes()
        expect.unreachable('Should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(ApiClientError)
        expect((err as ApiClientError).status).toBe(0)
        expect((err as ApiClientError).message).toBe('Failed to fetch')
      }
    })

    it('handles 500 internal server error with non-JSON response', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        headers: new Headers({ 'content-type': 'text/html' }),
        json: async () => {
          throw new Error('Not JSON')
        },
      } as unknown as Response)

      try {
        await api.listHomes()
        expect.unreachable('Should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(ApiClientError)
        expect((err as ApiClientError).status).toBe(500)
        expect((err as ApiClientError).message).toBe('Request failed with status 500')
      }
    })
  })

  describe('idempotency key propagation', () => {
    it('sends Idempotency-Key in headers during payShare', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          id: 'share-1',
          memberId: 'mem-1',
          amountCents: 500,
          paidAt: '2026-11-03T10:00:00.000Z',
        }),
      } as Response)

      globalThis.fetch = fetchMock

      const key = 'test-uuid-1234'
      const result = await api.payShare('bill-1', 'share-1', key)

      expect(fetchMock).toHaveBeenCalledTimes(1)
      const callArgs = fetchMock.mock.calls[0]
      expect(callArgs).toBeDefined()
      if (!callArgs) return

      const [url, options] = callArgs
      expect(url).toBe('/api/bills/bill-1/shares/share-1/pay')
      expect(options?.method).toBe('POST')

      const sentHeaders = new Headers(options?.headers)
      expect(sentHeaders.get('Idempotency-Key')).toBe(key)
      expect(result.paidAt).toBe('2026-11-03T10:00:00.000Z')
    })
  })

  describe('bill creation payload', () => {
    it('sends correct JSON structure and receives created bill', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          id: 'bill-1',
          homeId: 'home-1',
          title: 'Electricity',
          totalCents: 6000,
          shares: [
            { id: 's1', memberId: 'm1', amountCents: 3000, paidAt: null },
            { id: 's2', memberId: 'm2', amountCents: 3000, paidAt: null },
          ],
        }),
      } as Response)

      globalThis.fetch = fetchMock

      const bill = await api.createBill('home-1', 'Electricity', 6000)

      expect(fetchMock).toHaveBeenCalledTimes(1)
      const callArgs = fetchMock.mock.calls[0]
      expect(callArgs).toBeDefined()
      if (!callArgs) return

      const [url, options] = callArgs
      expect(url).toBe('/api/homes/home-1/bills')
      expect(options?.method).toBe('POST')
      expect(JSON.parse(options?.body as string)).toEqual({
        title: 'Electricity',
        totalCents: 6000,
      })
      expect(bill.shares.length).toBe(2)
      expect(bill.totalCents).toBe(6000)
    })
  })
})
