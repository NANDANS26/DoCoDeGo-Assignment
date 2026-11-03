import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ApiClientError, api } from '../lib/api'
import { calculateSplitPreview, formatCents, parseToCents } from '../lib/money'
import type { Balance, Bill, Home, SharePaymentState } from '../types/api'

export const Route = createFileRoute('/')({
  component: Dashboard,
})

export function Dashboard() {
  // Home state
  const [homes, setHomes] = useState<Home[]>([])
  const [selectedHomeId, setSelectedHomeId] = useState<string>('')
  const [newHomeName, setNewHomeName] = useState('')
  const [isCreatingHome, setIsCreatingHome] = useState(false)
  const [isHomesLoading, setIsHomesLoading] = useState(true)

  // Data state
  const [members, setMembers] = useState<Balance[]>([])
  const [bills, setBills] = useState<Bill[]>([])
  const [isLoadingData, setIsLoadingData] = useState(false)

  // Member form state
  const [newMemberName, setNewMemberName] = useState('')
  const [isAddingMember, setIsAddingMember] = useState(false)

  // Bill form state
  const [billTitle, setBillTitle] = useState('')
  const [billAmount, setBillAmount] = useState('')
  const [isCreatingBill, setIsCreatingBill] = useState(false)
  const [billFormError, setBillFormError] = useState<string | null>(null)

  // Per-share payment states: shareId -> SharePaymentState
  const [paymentStates, setPaymentStates] = useState<Record<string, SharePaymentState>>({})

  // Global error notification
  const [globalError, setGlobalError] = useState<string | null>(null)

  // Load homes on initial render
  const loadHomes = useCallback(async () => {
    setIsHomesLoading(true)
    try {
      const homeList = await api.listHomes()
      setHomes(homeList)
      if (homeList.length > 0) {
        // Recover previous selection or default to first home
        const savedId = localStorage.getItem('bill_splitter_home_id')
        const matching = homeList.find((h) => h.id === savedId)
        const initialId = matching ? matching.id : (homeList[0]?.id ?? '')
        setSelectedHomeId(initialId)
      }
    } catch (err) {
      setGlobalError(err instanceof ApiClientError ? err.message : 'Failed to load homes from API.')
    } finally {
      setIsHomesLoading(false)
    }
  }, [])

  useEffect(() => {
    loadHomes()
  }, [loadHomes])

  // Save selected home to localStorage
  useEffect(() => {
    if (selectedHomeId) {
      localStorage.setItem('bill_splitter_home_id', selectedHomeId)
    }
  }, [selectedHomeId])

  // Load home data (members/balances and bills)
  const loadHomeData = useCallback(async (homeId: string) => {
    if (!homeId) {
      setMembers([])
      setBills([])
      return
    }

    setIsLoadingData(true)
    setGlobalError(null)

    try {
      const [balancesRes, billsRes] = await Promise.all([
        api.getBalances(homeId),
        api.getBills(homeId),
      ])
      setMembers(balancesRes)
      setBills(billsRes)
    } catch (err) {
      setGlobalError(err instanceof ApiClientError ? err.message : 'Failed to fetch home details.')
    } finally {
      setIsLoadingData(false)
    }
  }, [])

  useEffect(() => {
    if (selectedHomeId) {
      loadHomeData(selectedHomeId)
    }
  }, [selectedHomeId, loadHomeData])

  // Lookup map for member names
  const memberNameMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const m of members) {
      map.set(m.memberId, m.name)
    }
    return map
  }, [members])

  // Split preview computation
  const splitPreview = useMemo(() => {
    if (!billAmount.trim() || members.length === 0) return null
    const cents = parseToCents(billAmount)
    if (!cents) return null

    const splits = calculateSplitPreview(cents, members.length)
    return members.map((m, idx) => ({
      name: m.name,
      cents: splits[idx] ?? 0,
    }))
  }, [billAmount, members])

  // Handler: Create new home
  const handleCreateHome = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = newHomeName.trim()
    if (!trimmed) return

    setIsCreatingHome(true)
    setGlobalError(null)

    try {
      const created = await api.createHome(trimmed)
      setHomes((prev) => [...prev, created])
      setSelectedHomeId(created.id)
      setNewHomeName('')
    } catch (err) {
      setGlobalError(err instanceof ApiClientError ? err.message : 'Failed to create home.')
    } finally {
      setIsCreatingHome(false)
    }
  }

  // Handler: Add member
  const handleAddMember = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = newMemberName.trim()
    if (!trimmed || !selectedHomeId) return

    setIsAddingMember(true)
    setGlobalError(null)

    try {
      await api.addMember(selectedHomeId, trimmed)
      setNewMemberName('')
      // Refresh balances to show new member in insertion order
      await loadHomeData(selectedHomeId)
    } catch (err) {
      setGlobalError(err instanceof ApiClientError ? err.message : 'Failed to add member.')
    } finally {
      setIsAddingMember(false)
    }
  }

  // Handler: Create bill
  const handleCreateBill = async (e: React.FormEvent) => {
    e.preventDefault()
    setBillFormError(null)

    const trimmedTitle = billTitle.trim()
    if (!trimmedTitle) {
      setBillFormError('Please enter a bill description.')
      return
    }

    const cents = parseToCents(billAmount)
    if (cents === null) {
      setBillFormError(
        'Please enter a valid positive dollar amount (e.g. 25.50). Whole cents only.',
      )
      return
    }

    if (members.length === 0) {
      setBillFormError('Cannot split a bill for a home with no members. Add a member first.')
      return
    }

    setIsCreatingBill(true)
    setGlobalError(null)

    try {
      await api.createBill(selectedHomeId, trimmedTitle, cents)
      setBillTitle('')
      setBillAmount('')
      // Refresh bills and balances
      await loadHomeData(selectedHomeId)
    } catch (err) {
      const msg = err instanceof ApiClientError ? err.message : 'Failed to create bill.'
      setBillFormError(msg)
    } finally {
      setIsCreatingBill(false)
    }
  }

  // Handler: Pay share with Idempotency Key retention
  const handlePayShare = async (billId: string, shareId: string) => {
    const currentState = paymentStates[shareId]

    // Determine or reuse idempotency key
    const idempotencyKey = currentState?.idempotencyKey || crypto.randomUUID()

    // Mark as paying and save key
    setPaymentStates((prev) => ({
      ...prev,
      [shareId]: {
        status: 'paying',
        idempotencyKey,
      },
    }))

    try {
      const updatedShare = await api.payShare(billId, shareId, idempotencyKey)

      // Update bill share in local state
      setBills((prevBills) =>
        prevBills.map((b) => {
          if (b.id !== billId) return b
          return {
            ...b,
            shares: b.shares.map((s) =>
              s.id === shareId ? { ...s, paidAt: updatedShare.paidAt } : s,
            ),
          }
        }),
      )

      // Mark share as paid
      setPaymentStates((prev) => ({
        ...prev,
        [shareId]: {
          status: 'paid',
          idempotencyKey,
        },
      }))

      // Sync member balances ledger
      if (selectedHomeId) {
        const freshBalances = await api.getBalances(selectedHomeId)
        setMembers(freshBalances)
      }
    } catch (err) {
      const is409 = err instanceof ApiClientError && err.status === 409

      if (is409) {
        // 409 means share is already paid on the server with another key
        // Immediately update local share state to paid
        setBills((prevBills) =>
          prevBills.map((b) => {
            if (b.id !== billId) return b
            return {
              ...b,
              shares: b.shares.map((s) =>
                s.id === shareId ? { ...s, paidAt: s.paidAt || new Date().toISOString() } : s,
              ),
            }
          }),
        )

        setPaymentStates((prev) => ({
          ...prev,
          [shareId]: {
            status: 'paid',
            idempotencyKey,
            errorMessage: undefined,
          },
        }))

        // Synchronize with fresh server state
        if (selectedHomeId) {
          await loadHomeData(selectedHomeId)
        }
      } else {
        const errorMessage =
          err instanceof ApiClientError
            ? err.message
            : 'Payment failed due to a network or server error.'

        setPaymentStates((prev) => ({
          ...prev,
          [shareId]: {
            status: 'error',
            idempotencyKey, // preserve key for same-key retry
            errorMessage,
          },
        }))
      }
    }
  }

  return (
    <div>
      {/* Top Navigation & Home Selector */}
      <header className="app-header">
        <div className="header-container">
          <div className="brand">
            <span className="brand-icon">🏠</span>
            <div>
              <h1 className="brand-title">Bill Splitter</h1>
              <p className="brand-subtitle">Shared living expense division & payments</p>
            </div>
          </div>

          <div className="home-selector-bar">
            {isHomesLoading ? (
              <span className="loading-indicator">Loading homes...</span>
            ) : (
              <>
                <select
                  aria-label="Select Home"
                  className="select-input"
                  value={selectedHomeId}
                  onChange={(e) => setSelectedHomeId(e.target.value)}
                  disabled={homes.length === 0}
                >
                  {homes.length === 0 && <option value="">No homes created yet</option>}
                  {homes.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name}
                    </option>
                  ))}
                </select>

                <form onSubmit={handleCreateHome} style={{ display: 'flex', gap: '0.375rem' }}>
                  <input
                    type="text"
                    aria-label="New Home Name"
                    className="text-input"
                    placeholder="New home name (e.g. Flat 4B)"
                    value={newHomeName}
                    onChange={(e) => setNewHomeName(e.target.value)}
                  />
                  <button
                    type="submit"
                    className="btn btn-secondary btn-sm"
                    disabled={isCreatingHome || !newHomeName.trim()}
                  >
                    {isCreatingHome ? 'Creating...' : '+ Create Home'}
                  </button>
                </form>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="main-container">
        {/* Global Error Banner */}
        {globalError && (
          <div className="alert alert-danger" role="alert">
            <span>⚠️ {globalError}</span>
            <button
              type="button"
              className="alert-dismiss"
              onClick={() => setGlobalError(null)}
              aria-label="Dismiss alert"
            >
              ×
            </button>
          </div>
        )}

        {!selectedHomeId ? (
          <div className="empty-state">
            <div className="empty-state-icon">🏡</div>
            <h2 className="empty-state-title">Welcome to Bill Splitter</h2>
            <p className="empty-state-desc">
              Create a new home or select an existing one from the top bar to manage members, split
              bills, and record payments.
            </p>
          </div>
        ) : (
          <div className="grid-layout">
            {/* Left Column: Members, Ledger & Bill Form */}
            <aside>
              {/* Member Balances & Management Card */}
              <section className="card">
                <div className="card-header">
                  <h2 className="card-title">Home Members & Ledger</h2>
                  <span className="badge badge-unpaid">{members.length} members</span>
                </div>
                <p className="card-subtitle">
                  Deterministic split order: extra cents flow sequentially from top to bottom.
                </p>

                {/* Add Member Form */}
                <form
                  onSubmit={handleAddMember}
                  style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.25rem' }}
                >
                  <input
                    type="text"
                    aria-label="Member name"
                    className="text-input"
                    style={{ flex: 1 }}
                    placeholder="Add member (e.g. Asha)"
                    value={newMemberName}
                    onChange={(e) => setNewMemberName(e.target.value)}
                  />
                  <button
                    type="submit"
                    className="btn btn-secondary btn-sm"
                    disabled={isAddingMember || !newMemberName.trim()}
                  >
                    {isAddingMember ? 'Adding...' : '+ Add'}
                  </button>
                </form>

                {/* Members Ledger */}
                {isLoadingData ? (
                  <div className="loading-indicator">
                    <div className="spinner" /> Loading ledger...
                  </div>
                ) : members.length === 0 ? (
                  <div className="empty-state" style={{ padding: '1.5rem 1rem' }}>
                    <p className="empty-state-desc">
                      No members added to this home yet. Add at least one member to split expenses.
                    </p>
                  </div>
                ) : (
                  <div className="member-list">
                    {members.map((member, index) => {
                      const isSettled = member.outstandingCents === 0
                      return (
                        <div key={member.memberId} className="member-item">
                          <div className="member-info">
                            <div className="member-avatar">
                              {member.name.charAt(0).toUpperCase()}
                            </div>
                            <div>
                              <div className="member-name">{member.name}</div>
                              <div className="member-order">Order #{index + 1}</div>
                            </div>
                          </div>
                          <div
                            className={`member-balance ${
                              isSettled ? 'balance-settled' : 'balance-due'
                            }`}
                          >
                            {isSettled
                              ? 'All settled ✓'
                              : `${formatCents(member.outstandingCents)} due`}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </section>

              {/* Create Bill Form Card */}
              <section className="card">
                <h2 className="card-title">Split New Bill</h2>
                <p className="card-subtitle">
                  Amounts are converted into integer cents. Any remainder cents are assigned to
                  members in insertion order.
                </p>

                {billFormError && (
                  <div
                    className="alert alert-danger"
                    style={{ padding: '0.5rem 0.75rem', marginBottom: '0.75rem' }}
                  >
                    {billFormError}
                  </div>
                )}

                <form onSubmit={handleCreateBill}>
                  <div className="form-group">
                    <label htmlFor="bill-title" className="form-label">
                      Bill Description
                    </label>
                    <input
                      id="bill-title"
                      type="text"
                      className="text-input"
                      style={{ width: '100%' }}
                      placeholder="e.g. WiFi Bill, Groceries, Electricity"
                      value={billTitle}
                      onChange={(e) => setBillTitle(e.target.value)}
                    />
                  </div>

                  <div className="form-group">
                    <label htmlFor="bill-amount" className="form-label">
                      Total Amount ($)
                    </label>
                    <div className="input-with-prefix">
                      <span className="input-prefix">$</span>
                      <input
                        id="bill-amount"
                        type="text"
                        inputMode="decimal"
                        className="text-input"
                        placeholder="0.00"
                        value={billAmount}
                        onChange={(e) => setBillAmount(e.target.value)}
                      />
                    </div>
                    <p className="form-help">Enter standard dollar amount (e.g. 10.00 or 25.50).</p>
                  </div>

                  {/* Split Preview */}
                  {splitPreview && (
                    <div className="split-preview">
                      <div className="split-preview-title">Split Preview (Deterministic)</div>
                      {splitPreview.map((item) => (
                        <div key={item.name} className="split-preview-item">
                          <span>{item.name}:</span>
                          <strong>{formatCents(item.cents)}</strong>
                        </div>
                      ))}
                    </div>
                  )}

                  <button
                    type="submit"
                    className="btn btn-primary"
                    style={{ width: '100%', marginTop: '1rem' }}
                    disabled={isCreatingBill || members.length === 0}
                  >
                    {isCreatingBill ? 'Splitting...' : 'Create & Split Bill'}
                  </button>
                </form>
              </section>
            </aside>

            {/* Right Column: Bills & Shares Ledger */}
            <section>
              <div className="card-header" style={{ marginBottom: '1rem' }}>
                <h2 className="card-title">Bills & Payments</h2>
                <span className="badge badge-unpaid">{bills.length} bills</span>
              </div>

              {isLoadingData ? (
                <div className="loading-indicator">
                  <div className="spinner" /> Loading bills...
                </div>
              ) : bills.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-state-icon">🧾</div>
                  <h3 className="empty-state-title">No Bills Yet</h3>
                  <p className="empty-state-desc">
                    {members.length === 0
                      ? 'Add members to this home first, then create a bill to split costs.'
                      : 'Create your first bill using the form on the left to start splitting.'}
                  </p>
                </div>
              ) : (
                <div className="bills-container">
                  {bills.map((bill) => {
                    const allPaid = bill.shares.every((s) => s.paidAt !== null)
                    return (
                      <article key={bill.id} className="bill-card">
                        <div className="bill-header">
                          <div className="bill-title-group">
                            <h3 className="bill-title">{bill.title}</h3>
                            <span className={`badge ${allPaid ? 'badge-paid' : 'badge-unpaid'}`}>
                              {allPaid ? 'Fully Paid ✓' : 'Pending Shares'}
                            </span>
                          </div>
                          <div className="bill-total">{formatCents(bill.totalCents)}</div>
                        </div>

                        <table className="shares-table">
                          <thead>
                            <tr>
                              <th>Member</th>
                              <th>Share Amount</th>
                              <th>Status</th>
                              <th style={{ textAlign: 'right' }}>Action</th>
                            </tr>
                          </thead>
                          <tbody>
                            {bill.shares.map((share) => {
                              const memberName =
                                memberNameMap.get(share.memberId) ||
                                `Member ${share.memberId.slice(0, 6)}`
                              const state = paymentStates[share.id]
                              const isPaid = share.paidAt !== null || state?.status === 'paid'
                              const isPaying = state?.status === 'paying'
                              const hasError = state?.status === 'error'

                              return (
                                <tr key={share.id}>
                                  <td>
                                    <strong>{memberName}</strong>
                                  </td>
                                  <td>
                                    <strong>{formatCents(share.amountCents)}</strong>
                                  </td>
                                  <td>
                                    {isPaid ? (
                                      <span className="badge badge-paid">Paid</span>
                                    ) : (
                                      <span className="badge badge-unpaid">Unpaid</span>
                                    )}
                                    {hasError && !isPaid && (
                                      <span className="share-error-msg">{state.errorMessage}</span>
                                    )}
                                  </td>
                                  <td style={{ textAlign: 'right' }}>
                                    {isPaid ? (
                                      <button
                                        type="button"
                                        disabled
                                        className="btn btn-paid btn-sm"
                                      >
                                        Paid ✓
                                      </button>
                                    ) : (
                                      <div
                                        style={{
                                          display: 'inline-flex',
                                          gap: '0.375rem',
                                          justifyContent: 'flex-end',
                                        }}
                                      >
                                        <button
                                          type="button"
                                          className={`btn btn-sm ${
                                            hasError ? 'btn-secondary' : 'btn-pay'
                                          }`}
                                          disabled={isPaying}
                                          onClick={() => handlePayShare(bill.id, share.id)}
                                        >
                                          {isPaying
                                            ? 'Paying...'
                                            : hasError
                                              ? 'Retry Payment'
                                              : 'Pay Share'}
                                        </button>
                                        {hasError && (
                                          <button
                                            type="button"
                                            className="btn btn-sm btn-secondary"
                                            disabled={isPaying}
                                            onClick={() => loadHomeData(selectedHomeId)}
                                            title="Check current status from server"
                                          >
                                            Reconcile
                                          </button>
                                        )}
                                      </div>
                                    )}
                                  </td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </article>
                    )
                  })}
                </div>
              )}
            </section>
          </div>
        )}
      </main>
    </div>
  )
}
