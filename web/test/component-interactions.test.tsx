import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError, api } from '../src/lib/api'
import { Dashboard } from '../src/routes/index'
import type { Balance, Bill, Home, Share } from '../types/api'

describe('Dashboard Component - Genuine React DOM Interactions', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    localStorage.clear()
  })

  // -------------------------------------------------------------------------
  // 1. Initial Empty Home State
  // -------------------------------------------------------------------------
  it('1. Renders empty home welcome state when no homes exist', async () => {
    vi.spyOn(api, 'listHomes').mockResolvedValue([])

    render(<Dashboard />)

    // Wait for async homes load
    await waitFor(() => {
      expect(screen.getByText('Welcome to Bill Splitter')).toBeInTheDocument()
    })
    expect(screen.getByText(/Create a new home or select an existing one/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /\+ Create Home/i })).toBeDisabled()
  })

  // -------------------------------------------------------------------------
  // 2. Home Creation through the actual form
  // -------------------------------------------------------------------------
  it('2. Creates a home using the header form and renders home view', async () => {
    vi.spyOn(api, 'listHomes').mockResolvedValue([])
    const newHome: Home = { id: 'home-101', name: 'Oak Residency' }
    const createSpy = vi.spyOn(api, 'createHome').mockResolvedValue(newHome)
    vi.spyOn(api, 'getBalances').mockResolvedValue([])
    vi.spyOn(api, 'getBills').mockResolvedValue([])

    render(<Dashboard />)

    await waitFor(() => {
      expect(screen.getByText('Welcome to Bill Splitter')).toBeInTheDocument()
    })

    const homeInput = screen.getByPlaceholderText(/New home name/i)
    const createBtn = screen.getByRole('button', { name: /\+ Create Home/i })

    // Type home name
    fireEvent.change(homeInput, { target: { value: 'Oak Residency' } })
    expect(createBtn).not.toBeDisabled()

    // Submit form
    fireEvent.click(createBtn)

    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledWith('Oak Residency')
      expect(screen.getByText('Home Members & Ledger')).toBeInTheDocument()
    })

    expect(screen.getByText('0 members')).toBeInTheDocument()
    expect(screen.getByText('Split New Bill')).toBeInTheDocument()
  })

  // -------------------------------------------------------------------------
  // 3. Selecting an Existing Home
  // -------------------------------------------------------------------------
  it('3. Selects an existing home from dropdown and loads data', async () => {
    const existingHomes: Home[] = [
      { id: 'h1', name: 'Flat 1A' },
      { id: 'h2', name: 'Flat 2B' },
    ]
    vi.spyOn(api, 'listHomes').mockResolvedValue(existingHomes)
    const balancesSpy = vi
      .spyOn(api, 'getBalances')
      .mockResolvedValue([{ memberId: 'm1', name: 'Asha', outstandingCents: 0 }])
    const billsSpy = vi.spyOn(api, 'getBills').mockResolvedValue([])

    render(<Dashboard />)

    await waitFor(() => {
      expect(screen.getByText('Home Members & Ledger')).toBeInTheDocument()
      expect(screen.getByText('Flat 1A')).toBeInTheDocument()
    })

    expect(balancesSpy).toHaveBeenCalledWith('h1')
    expect(billsSpy).toHaveBeenCalledWith('h1')

    // Switch to Flat 2B
    const select = screen.getByRole('combobox', { name: /Select Home/i })
    fireEvent.change(select, { target: { value: 'h2' } })

    await waitFor(() => {
      expect(balancesSpy).toHaveBeenCalledWith('h2')
      expect(billsSpy).toHaveBeenCalledWith('h2')
    })
  })

  // -------------------------------------------------------------------------
  // 4. Adding a Member through the actual form
  // -------------------------------------------------------------------------
  it('4. Adds a member using the member form and updates ledger', async () => {
    vi.spyOn(api, 'listHomes').mockResolvedValue([{ id: 'h1', name: 'Flat 1A' }])
    vi.spyOn(api, 'getBalances')
      .mockResolvedValueOnce([]) // Initial: 0 members
      .mockResolvedValueOnce([{ memberId: 'm1', name: 'Asha', outstandingCents: 0 }]) // After add
    vi.spyOn(api, 'getBills').mockResolvedValue([])
    const addMemberSpy = vi.spyOn(api, 'addMember').mockResolvedValue({
      id: 'm1',
      homeId: 'h1',
      name: 'Asha',
    })

    render(<Dashboard />)

    await waitFor(() => {
      expect(screen.getByText(/No members added to this home yet/i)).toBeInTheDocument()
    })

    const memberInput = screen.getByPlaceholderText(/Add member/i)
    const addBtn = screen.getByRole('button', { name: /\+ Add/i })

    fireEvent.change(memberInput, { target: { value: 'Asha' } })
    fireEvent.click(addBtn)

    await waitFor(() => {
      expect(addMemberSpy).toHaveBeenCalledWith('h1', 'Asha')
      expect(screen.getByText('Asha')).toBeInTheDocument()
      expect(screen.getByText('All settled ✓')).toBeInTheDocument()
    })
  })

  // -------------------------------------------------------------------------
  // 5. Bill Creation and Split Preview
  // -------------------------------------------------------------------------
  it('5. Computes live deterministic split preview and submits bill', async () => {
    vi.spyOn(api, 'listHomes').mockResolvedValue([{ id: 'h1', name: 'Flat 1A' }])
    const members: Balance[] = [
      { memberId: 'm1', name: 'Asha', outstandingCents: 0 },
      { memberId: 'm2', name: 'Ben', outstandingCents: 0 },
      { memberId: 'm3', name: 'Chitra', outstandingCents: 0 },
    ]
    vi.spyOn(api, 'getBalances').mockResolvedValue(members)
    vi.spyOn(api, 'getBills').mockResolvedValue([])

    const createdBill: Bill = {
      id: 'bill-1',
      homeId: 'h1',
      title: 'WiFi',
      totalCents: 1000,
      shares: [
        { id: 's1', memberId: 'm1', amountCents: 334, paidAt: null },
        { id: 's2', memberId: 'm2', amountCents: 333, paidAt: null },
        { id: 's3', memberId: 'm3', amountCents: 333, paidAt: null },
      ],
    }
    const createBillSpy = vi.spyOn(api, 'createBill').mockResolvedValue(createdBill)

    render(<Dashboard />)

    await waitFor(() => {
      expect(screen.getByText('Asha')).toBeInTheDocument()
    })

    const titleInput = screen.getByLabelText(/Bill Description/i)
    const amountInput = screen.getByLabelText(/Total Amount/i)
    const submitBtn = screen.getByRole('button', { name: /Create & Split Bill/i })

    // Enter title and amount $10.00
    fireEvent.change(titleInput, { target: { value: 'WiFi' } })
    fireEvent.change(amountInput, { target: { value: '10.00' } })

    // Assert live split preview box rendered with deterministic remainder allocation
    expect(screen.getByText('Split Preview (Deterministic)')).toBeInTheDocument()
    expect(screen.getByText('$3.34')).toBeInTheDocument() // Asha gets 334

    // Submit bill
    fireEvent.click(submitBtn)

    await waitFor(() => {
      expect(createBillSpy).toHaveBeenCalledWith('h1', 'WiFi', 1000)
    })
  })

  // -------------------------------------------------------------------------
  // 6. Validation when No Members Exist
  // -------------------------------------------------------------------------
  it('6. Blocks bill creation when home has no members and disables button', async () => {
    vi.spyOn(api, 'listHomes').mockResolvedValue([{ id: 'h1', name: 'Empty Flat' }])
    vi.spyOn(api, 'getBalances').mockResolvedValue([])
    vi.spyOn(api, 'getBills').mockResolvedValue([])

    render(<Dashboard />)

    await waitFor(() => {
      expect(screen.getByText('Split New Bill')).toBeInTheDocument()
    })

    const submitBtn = screen.getByRole('button', { name: /Create & Split Bill/i })
    expect(submitBtn).toBeDisabled()
  })

  // -------------------------------------------------------------------------
  // 7 & 8. Payment Loading State, Button Lockout, and Paid State
  // -------------------------------------------------------------------------
  it('7 & 8. Shows paying spinner, disables button, and transitions to Paid on 200', async () => {
    vi.spyOn(api, 'listHomes').mockResolvedValue([{ id: 'h1', name: 'Flat 1' }])
    vi.spyOn(api, 'getBalances').mockResolvedValue([
      { memberId: 'm1', name: 'Asha', outstandingCents: 1000 },
    ])
    const initialBill: Bill = {
      id: 'b1',
      homeId: 'h1',
      title: 'Groceries',
      totalCents: 1000,
      shares: [{ id: 's1', memberId: 'm1', amountCents: 1000, paidAt: null }],
    }
    vi.spyOn(api, 'getBills').mockResolvedValue([initialBill])

    let resolvePayment: (val: Share) => void
    const paymentPromise = new Promise<Share>((resolve) => {
      resolvePayment = resolve
    })
    const paySpy = vi.spyOn(api, 'payShare').mockImplementation(() => paymentPromise)

    render(<Dashboard />)

    await waitFor(() => {
      expect(screen.getByText('Groceries')).toBeInTheDocument()
    })

    const payBtn = screen.getByRole('button', { name: /Pay Share/i })
    expect(payBtn).toBeEnabled()

    // Click pay
    fireEvent.click(payBtn)

    // Verify loading and disabled button
    expect(screen.getByRole('button', { name: /Paying\.\.\./i })).toBeDisabled()
    expect(paySpy).toHaveBeenCalledWith('b1', 's1', expect.any(String))

    // Resolve server payment with 200 OK
    await act(async () => {
      resolvePayment?.({
        id: 's1',
        memberId: 'm1',
        amountCents: 1000,
        paidAt: '2026-11-03T12:00:00.000Z',
      })
    })

    // Assert Paid status and button permanently locked
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Paid ✓/i })).toBeDisabled()
    })
  })

  // -------------------------------------------------------------------------
  // 9. HTTP 409 Reconciliation & Immediate Button Lockout
  // -------------------------------------------------------------------------
  it('9. Immediately transitions to Paid and locks button on HTTP 409 Conflict', async () => {
    vi.spyOn(api, 'listHomes').mockResolvedValue([{ id: 'h1', name: 'Flat 1' }])
    vi.spyOn(api, 'getBalances').mockResolvedValue([
      { memberId: 'm1', name: 'Asha', outstandingCents: 1000 },
    ])
    const initialBill: Bill = {
      id: 'b1',
      homeId: 'h1',
      title: 'Power',
      totalCents: 1000,
      shares: [{ id: 's1', memberId: 'm1', amountCents: 1000, paidAt: null }],
    }
    const serverPaidBill: Bill = {
      ...initialBill,
      shares: [
        {
          id: 's1',
          memberId: 'm1',
          amountCents: 1000,
          paidAt: '2026-11-03T12:00:00.000Z',
        },
      ],
    }
    vi.spyOn(api, 'getBills')
      .mockResolvedValueOnce([initialBill])
      .mockResolvedValueOnce([serverPaidBill])

    // Mock 409 conflict: share was paid with a different key
    vi.spyOn(api, 'payShare').mockRejectedValue(
      new ApiClientError('Share already paid with a different key', 409),
    )

    render(<Dashboard />)

    await waitFor(() => {
      expect(screen.getByText('Power')).toBeInTheDocument()
    })

    const payBtn = screen.getByRole('button', { name: /Pay Share/i })
    fireEvent.click(payBtn)

    // Hardened behavior: immediately locks button as Paid ✓ without leaving clickable window
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Paid ✓/i })).toBeDisabled()
    })
  })

  // -------------------------------------------------------------------------
  // 10. HTTP 500 without Falsely Showing Paid
  // -------------------------------------------------------------------------
  it('10. Renders Retry Payment on HTTP 500 and keeps share unpaid', async () => {
    vi.spyOn(api, 'listHomes').mockResolvedValue([{ id: 'h1', name: 'Flat 1' }])
    vi.spyOn(api, 'getBalances').mockResolvedValue([
      { memberId: 'm1', name: 'Asha', outstandingCents: 1000 },
    ])
    const initialBill: Bill = {
      id: 'b1',
      homeId: 'h1',
      title: 'Water',
      totalCents: 1000,
      shares: [{ id: 's1', memberId: 'm1', amountCents: 1000, paidAt: null }],
    }
    vi.spyOn(api, 'getBills').mockResolvedValue([initialBill])

    vi.spyOn(api, 'payShare').mockRejectedValue(new ApiClientError('Internal Server Error', 500))

    render(<Dashboard />)

    await waitFor(() => {
      expect(screen.getByText('Water')).toBeInTheDocument()
    })

    const payBtn = screen.getByRole('button', { name: /Pay Share/i })
    fireEvent.click(payBtn)

    await waitFor(() => {
      // Must NOT show Paid ✓
      expect(screen.queryByRole('button', { name: /Paid ✓/i })).not.toBeInTheDocument()
      // Must show Retry Payment and error message
      expect(screen.getByRole('button', { name: /Retry Payment/i })).toBeInTheDocument()
      expect(screen.getByText('Internal Server Error')).toBeInTheDocument()
      // Must still be marked Unpaid
      expect(screen.getByText('Unpaid')).toBeInTheDocument()
    })
  })

  // -------------------------------------------------------------------------
  // 11. Network Failure and Same-Key Retry
  // -------------------------------------------------------------------------
  it('11. Reuses identical idempotency key on network failure retry', async () => {
    vi.spyOn(api, 'listHomes').mockResolvedValue([{ id: 'h1', name: 'Flat 1' }])
    vi.spyOn(api, 'getBalances').mockResolvedValue([
      { memberId: 'm1', name: 'Asha', outstandingCents: 1000 },
    ])
    const initialBill: Bill = {
      id: 'b1',
      homeId: 'h1',
      title: 'Gas',
      totalCents: 1000,
      shares: [{ id: 's1', memberId: 'm1', amountCents: 1000, paidAt: null }],
    }
    vi.spyOn(api, 'getBills').mockResolvedValue([initialBill])

    const capturedKeys: string[] = []
    vi.spyOn(api, 'payShare').mockImplementation(async (_billId, _shareId, key) => {
      capturedKeys.push(key)
      if (capturedKeys.length === 1) {
        throw new ApiClientError('Network request failed. Is the server running?', 0)
      }
      return {
        id: 's1',
        memberId: 'm1',
        amountCents: 1000,
        paidAt: '2026-11-03T12:00:00Z',
      }
    })

    render(<Dashboard />)

    await waitFor(() => {
      expect(screen.getByText('Gas')).toBeInTheDocument()
    })

    // Click pay first time -> fails
    const payBtn = screen.getByRole('button', { name: /Pay Share/i })
    fireEvent.click(payBtn)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Retry Payment/i })).toBeInTheDocument()
    })

    // Click retry
    const retryBtn = screen.getByRole('button', { name: /Retry Payment/i })
    fireEvent.click(retryBtn)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Paid ✓/i })).toBeInTheDocument()
    })

    // Assert exact same key was sent across both calls
    expect(capturedKeys).toHaveLength(2)
    expect(capturedKeys[0]).toBeDefined()
    expect(capturedKeys[0]).toBe(capturedKeys[1])
  })

  // -------------------------------------------------------------------------
  // 12. Reconcile Action Refreshing State Without Issuing Payment
  // -------------------------------------------------------------------------
  it('12. Reconcile action queries server state without dispatching payment request', async () => {
    vi.spyOn(api, 'listHomes').mockResolvedValue([{ id: 'h1', name: 'Flat 1' }])
    const getBalancesSpy = vi
      .spyOn(api, 'getBalances')
      .mockResolvedValue([{ memberId: 'm1', name: 'Asha', outstandingCents: 1000 }])
    const initialBill: Bill = {
      id: 'b1',
      homeId: 'h1',
      title: 'Repairs',
      totalCents: 1000,
      shares: [{ id: 's1', memberId: 'm1', amountCents: 1000, paidAt: null }],
    }
    const getBillsSpy = vi.spyOn(api, 'getBills').mockResolvedValue([initialBill])

    const paySpy = vi
      .spyOn(api, 'payShare')
      .mockRejectedValue(new ApiClientError('Server timeout', 500))

    render(<Dashboard />)

    await waitFor(() => {
      expect(screen.getByText('Repairs')).toBeInTheDocument()
    })

    // Initial click produces 500
    fireEvent.click(screen.getByRole('button', { name: /Pay Share/i }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Reconcile/i })).toBeInTheDocument()
    })

    expect(paySpy).toHaveBeenCalledTimes(1)

    // Reset spy counters to test Reconcile button in isolation
    getBalancesSpy.mockClear()
    getBillsSpy.mockClear()
    paySpy.mockClear()

    // Click Reconcile
    const reconcileBtn = screen.getByRole('button', { name: /Reconcile/i })
    fireEvent.click(reconcileBtn)

    await waitFor(() => {
      expect(getBillsSpy).toHaveBeenCalledWith('h1')
      expect(getBalancesSpy).toHaveBeenCalledWith('h1')
    })

    // CRITICAL ASSERTION: Reconcile NEVER dispatches another payment request!
    expect(paySpy).not.toHaveBeenCalled()
  })
})
