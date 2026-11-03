import { describe, expect, it } from 'vitest'
import { type Balance, call, createBill, createHome, type Share } from './helpers'

async function setup() {
  const { homeId, members } = await createHome(['Asha', 'Ben'])
  const bill = await createBill(homeId, 1000)
  const firstShare = bill.body.shares[0]
  if (!firstShare) throw new Error('bill has no shares')
  return { homeId, members, billId: bill.body.id, firstShare }
}

function pay(billId: string, shareId: string, key?: string) {
  return call<Share>('POST', `/api/bills/${billId}/shares/${shareId}/pay`, {
    headers: key ? { 'Idempotency-Key': key } : {},
  })
}

function balances(homeId: string) {
  return call<{ balances: Balance[] }>('GET', `/api/homes/${homeId}/balances`)
}

describe('pay a share', () => {
  it('marks the share as paid', async () => {
    const { billId, firstShare } = await setup()

    const paid = await pay(billId, firstShare.id, crypto.randomUUID())

    expect(paid.status).toBe(200)
    expect(paid.body.id).toBe(firstShare.id)
    expect(paid.body.paidAt).toEqual(expect.any(String))
  })

  it('rejects a request with no Idempotency-Key header', async () => {
    const { billId, firstShare } = await setup()

    const paid = await pay(billId, firstShare.id)

    expect(paid.status).toBe(400)
  })

  it('returns the same answer when the same key is sent twice, and pays once', async () => {
    const { homeId, billId, firstShare } = await setup()
    const key = crypto.randomUUID()

    const first = await pay(billId, firstShare.id, key)
    const second = await pay(billId, firstShare.id, key)

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(second.body.paidAt).toBe(first.body.paidAt)
    const outstanding = await balances(homeId)
    expect(outstanding.body.balances.map((balance) => balance.outstandingCents)).toEqual([0, 500])
  })

  it('rejects a second payment of an already paid share with a different key', async () => {
    const { billId, firstShare } = await setup()
    await pay(billId, firstShare.id, crypto.randomUUID())

    const again = await pay(billId, firstShare.id, crypto.randomUUID())

    expect(again.status).toBe(409)
  })

  it('returns 404 when the share does not exist', async () => {
    const { billId } = await setup()

    const paid = await pay(billId, 'does-not-exist', crypto.randomUUID())

    expect(paid.status).toBe(404)
  })

  it('returns 404 when the bill does not exist', async () => {
    const { firstShare } = await setup()

    const paid = await pay('does-not-exist', firstShare.id, crypto.randomUUID())

    expect(paid.status).toBe(404)
  })

  // -------------------------------------------------------------------------
  // SPRINT 2: MANDATORY CONCURRENCY & IDEMPOTENCY TEST GROUPS
  // -------------------------------------------------------------------------

  it('CONCURRENCY GROUP A: simultaneous requests with DIFFERENT keys -> exactly one 200 and one 409', async () => {
    const { billId, firstShare } = await setup()
    const keyA = crypto.randomUUID()
    const keyB = crypto.randomUUID()

    const [res1, res2] = await Promise.all([
      pay(billId, firstShare.id, keyA),
      pay(billId, firstShare.id, keyB),
    ])

    const statuses = [res1.status, res2.status].sort()
    expect(statuses).toEqual([200, 409])

    const winner = res1.status === 200 ? res1 : res2
    const loser = res1.status === 409 ? res1 : res2

    expect(winner.body.id).toBe(firstShare.id)
    expect(winner.body.paidAt).toEqual(expect.any(String))
    expect(loser.body).toEqual({ error: 'Share already paid with a different key' })
  })

  it('CONCURRENCY GROUP B: simultaneous requests with IDENTICAL keys -> both return 200 with same paidAt', async () => {
    const { billId, firstShare } = await setup()
    const key = crypto.randomUUID()

    const [res1, res2] = await Promise.all([
      pay(billId, firstShare.id, key),
      pay(billId, firstShare.id, key),
    ])

    expect(res1.status).toBe(200)
    expect(res2.status).toBe(200)
    expect(res1.body.paidAt).toBe(res2.body.paidAt)
    expect(res1.body.id).toBe(firstShare.id)
  })

  it('IDEMPOTENCY GROUP C: replay after successful payment preserves original key and timestamp', async () => {
    const { billId, firstShare } = await setup()
    const keyA = crypto.randomUUID()
    const keyB = crypto.randomUUID()

    const initial = await pay(billId, firstShare.id, keyA)
    expect(initial.status).toBe(200)

    const replay = await pay(billId, firstShare.id, keyA)
    expect(replay.status).toBe(200)
    expect(replay.body.paidAt).toBe(initial.body.paidAt)

    const conflict = await pay(billId, firstShare.id, keyB)
    expect(conflict.status).toBe(409)

    // Replay with keyA again to ensure keyA remains active and untouched
    const secondReplay = await pay(billId, firstShare.id, keyA)
    expect(secondReplay.status).toBe(200)
    expect(secondReplay.body.paidAt).toBe(initial.body.paidAt)
  })

  it('ISOLATION GROUP D: idempotency keys are scoped per-share, allowing same key across different shares', async () => {
    const { homeId } = await createHome(['Asha', 'Ben'])
    const bill = await createBill(homeId, 1000)
    const [share1, share2] = bill.body.shares
    if (!share1 || !share2) throw new Error('shares missing')

    const sharedKey = crypto.randomUUID()

    const pay1 = await pay(bill.body.id, share1.id, sharedKey)
    expect(pay1.status).toBe(200)

    const pay2 = await pay(bill.body.id, share2.id, sharedKey)
    expect(pay2.status).toBe(200)
    expect(pay2.body.id).toBe(share2.id)
  })

  it('VALIDATION GROUP E: rejects empty, whitespace-only, or excessively long Idempotency-Key headers', async () => {
    const { billId, firstShare } = await setup()

    const empty = await call('POST', `/api/bills/${billId}/shares/${firstShare.id}/pay`, {
      headers: { 'Idempotency-Key': '' },
    })
    expect(empty.status).toBe(400)

    const whitespace = await call('POST', `/api/bills/${billId}/shares/${firstShare.id}/pay`, {
      headers: { 'Idempotency-Key': '    ' },
    })
    expect(whitespace.status).toBe(400)

    const tooLong = await call('POST', `/api/bills/${billId}/shares/${firstShare.id}/pay`, {
      headers: { 'Idempotency-Key': 'k'.repeat(257) },
    })
    expect(tooLong.status).toBe(400)
  })

  it('VALIDATION GROUP E: returns 404 when share belongs to a different bill', async () => {
    const { homeId } = await createHome(['Asha', 'Ben'])
    const bill1 = await createBill(homeId, 500)
    const bill2 = await createBill(homeId, 800)

    const share1 = bill1.body.shares[0]
    if (!share1) throw new Error('share1 missing')

    // Attempting to pay share1 using bill2's URL path
    const mismatch = await pay(bill2.body.id, share1.id, crypto.randomUUID())
    expect(mismatch.status).toBe(404)
  })
})

describe('balances', () => {
  it('lists what each member still owes, in the order members were added', async () => {
    const { homeId, members } = await setup()

    const outstanding = await balances(homeId)

    expect(outstanding.status).toBe(200)
    expect(outstanding.body.balances).toEqual([
      { memberId: members[0]?.id, name: 'Asha', outstandingCents: 500 },
      { memberId: members[1]?.id, name: 'Ben', outstandingCents: 500 },
    ])
  })

  it('adds up the unpaid shares of several bills', async () => {
    const { homeId, billId, firstShare } = await setup()
    await createBill(homeId, 300)
    await pay(billId, firstShare.id, crypto.randomUUID())

    const outstanding = await balances(homeId)

    expect(outstanding.body.balances.map((balance) => balance.outstandingCents)).toEqual([150, 650])
  })

  it('returns 404 when the home does not exist', async () => {
    const outstanding = await balances('does-not-exist')

    expect(outstanding.status).toBe(404)
  })

  it('SCENARIO 1: returns empty balance array for a home with no members', async () => {
    const { homeId } = await createHome([])
    const res = await balances(homeId)

    expect(res.status).toBe(200)
    expect(res.body.balances).toEqual([])
  })

  it('SCENARIO 2: returns outstandingCents: 0 for members in a home with no bills', async () => {
    const { homeId, members } = await createHome(['Asha', 'Ben'])
    const res = await balances(homeId)

    expect(res.status).toBe(200)
    expect(res.body.balances).toEqual([
      { memberId: members[0]?.id, name: 'Asha', outstandingCents: 0 },
      { memberId: members[1]?.id, name: 'Ben', outstandingCents: 0 },
    ])
  })

  it('SCENARIO 4 & 6: returns 0 outstanding balance when all shares are paid', async () => {
    const { homeId, members } = await createHome(['Asha', 'Ben'])
    const bill = await createBill(homeId, 1000)
    const [s1, s2] = bill.body.shares
    if (!s1 || !s2) throw new Error('shares missing')

    await pay(bill.body.id, s1.id, crypto.randomUUID())
    await pay(bill.body.id, s2.id, crypto.randomUUID())

    const res = await balances(homeId)
    expect(res.status).toBe(200)
    expect(res.body.balances).toEqual([
      { memberId: members[0]?.id, name: 'Asha', outstandingCents: 0 },
      { memberId: members[1]?.id, name: 'Ben', outstandingCents: 0 },
    ])
  })

  it('SCENARIO 7: accumulates multiple bills for the same member correctly using integer cents', async () => {
    const { homeId, members } = await createHome(['Asha', 'Ben', 'Chitra'])
    // Bill 1: 3000 -> 1000 each
    const b1 = await createBill(homeId, 3000)
    // Bill 2: 1000 -> 334, 333, 333
    await createBill(homeId, 1000)
    // Bill 3: 500 -> 167, 167, 166
    await createBill(homeId, 500)

    // Asha pays bill 1 share (1000)
    const ashaShareB1 = b1.body.shares[0]
    if (!ashaShareB1) throw new Error('missing share')
    await pay(b1.body.id, ashaShareB1.id, crypto.randomUUID())

    // Expected remaining:
    // Asha: 0 + 334 + 167 = 501
    // Ben: 1000 + 333 + 167 = 1500
    // Chitra: 1000 + 333 + 166 = 1499
    const res = await balances(homeId)
    expect(res.body.balances).toEqual([
      { memberId: members[0]?.id, name: 'Asha', outstandingCents: 501 },
      { memberId: members[1]?.id, name: 'Ben', outstandingCents: 1500 },
      { memberId: members[2]?.id, name: 'Chitra', outstandingCents: 1499 },
    ])
  })

  it('SCENARIO 8: completely isolates balances across different homes', async () => {
    const homeA = await createHome(['Alice'])
    const homeB = await createHome(['Bob'])

    await createBill(homeA.homeId, 4000)
    await createBill(homeB.homeId, 9000)

    const balA = await balances(homeA.homeId)
    const balB = await balances(homeB.homeId)

    expect(balA.body.balances).toEqual([
      { memberId: homeA.members[0]?.id, name: 'Alice', outstandingCents: 4000 },
    ])
    expect(balB.body.balances).toEqual([
      { memberId: homeB.members[0]?.id, name: 'Bob', outstandingCents: 9000 },
    ])
  })
})
