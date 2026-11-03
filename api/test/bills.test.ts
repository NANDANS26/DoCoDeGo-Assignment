import { describe, expect, it } from 'vitest'
import { call, createBill, createHome } from './helpers'

describe('create a bill', () => {
  it('splits an even amount equally', async () => {
    const { homeId } = await createHome(['Asha', 'Ben', 'Chitra'])

    const bill = await createBill(homeId, 3000)

    expect(bill.status).toBe(201)
    expect(bill.body.shares.map((share) => share.amountCents)).toEqual([1000, 1000, 1000])
  })

  it('gives the extra cents to the first members, in the order they were added', async () => {
    const { homeId, members } = await createHome(['Asha', 'Ben', 'Chitra'])

    const bill = await createBill(homeId, 1000)

    expect(bill.status).toBe(201)
    expect(bill.body.shares.map((share) => share.memberId)).toEqual(members.map((m) => m.id))
    expect(bill.body.shares.map((share) => share.amountCents)).toEqual([334, 333, 333])
  })

  it('always makes the shares add up to the total', async () => {
    const { homeId } = await createHome(['Asha', 'Ben', 'Chitra', 'Dev', 'Esha', 'Farid', 'Gita'])

    const bill = await createBill(homeId, 100001)

    const sum = bill.body.shares.reduce((total, share) => total + share.amountCents, 0)
    expect(sum).toBe(100001)
  })

  it('gives the whole amount to a home with one member', async () => {
    const { homeId } = await createHome(['Asha'])

    const bill = await createBill(homeId, 4999)

    expect(bill.body.shares.map((share) => share.amountCents)).toEqual([4999])
  })

  it('starts every share as unpaid', async () => {
    const { homeId } = await createHome(['Asha', 'Ben'])

    const bill = await createBill(homeId, 500)

    expect(bill.body.shares.every((share) => share.paidAt === null)).toBe(true)
  })

  it('rejects a home with no members', async () => {
    const { homeId } = await createHome([])

    const bill = await createBill(homeId, 1000)

    expect(bill.status).toBe(422)
  })

  it.each([0, -100, 10.5, '1000', null])('rejects the amount %j', async (totalCents) => {
    const { homeId } = await createHome(['Asha', 'Ben'])

    const bill = await call('POST', `/api/homes/${homeId}/bills`, {
      body: { title: 'Rent', totalCents },
    })

    expect(bill.status).toBe(422)
  })

  it('returns 404 when the home does not exist', async () => {
    const bill = await createBill('does-not-exist', 1000)

    expect(bill.status).toBe(404)
  })

  it('handles 1-cent bill correctly across 3 members resulting in [1, 0, 0]', async () => {
    const { homeId } = await createHome(['Asha', 'Ben', 'Chitra'])

    const bill = await createBill(homeId, 1)

    expect(bill.status).toBe(201)
    expect(bill.body.shares.map((s) => s.amountCents)).toEqual([1, 0, 0])
    const sum = bill.body.shares.reduce((acc, s) => acc + s.amountCents, 0)
    expect(sum).toBe(1)
  })

  it('handles more participants than cents (e.g. 2 cents among 4 members -> [1, 1, 0, 0])', async () => {
    const { homeId } = await createHome(['Asha', 'Ben', 'Chitra', 'Dev'])

    const bill = await createBill(homeId, 2)

    expect(bill.status).toBe(201)
    expect(bill.body.shares.map((s) => s.amountCents)).toEqual([1, 1, 0, 0])
    const sum = bill.body.shares.reduce((acc, s) => acc + s.amountCents, 0)
    expect(sum).toBe(2)
  })

  it('rejects invalid or empty bill title with 422', async () => {
    const { homeId } = await createHome(['Asha'])

    const missingTitle = await call('POST', `/api/homes/${homeId}/bills`, {
      body: { totalCents: 500 },
    })
    expect(missingTitle.status).toBe(422)

    const emptyTitle = await call('POST', `/api/homes/${homeId}/bills`, {
      body: { title: '   ', totalCents: 500 },
    })
    expect(emptyTitle.status).toBe(422)
  })

  it('supports multiple bills created in the same home with independent shares', async () => {
    const { homeId } = await createHome(['Asha', 'Ben'])

    const bill1 = await createBill(homeId, 500)
    const bill2 = await createBill(homeId, 700)

    expect(bill1.status).toBe(201)
    expect(bill2.status).toBe(201)
    expect(bill1.body.id).not.toBe(bill2.body.id)
    expect(bill1.body.shares.map((s) => s.amountCents)).toEqual([250, 250])
    expect(bill2.body.shares.map((s) => s.amountCents)).toEqual([350, 350])
  })
})

describe('get home bills (frontend read endpoint)', () => {
  it('returns 404 when home does not exist', async () => {
    const res = await call('GET', '/api/homes/non-existent-home/bills')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'Home not found' })
  })

  it('returns empty bills list for home with no bills', async () => {
    const { homeId } = await createHome(['Asha'])
    const res = await call<{ bills: unknown[] }>('GET', `/api/homes/${homeId}/bills`)

    expect(res.status).toBe(200)
    expect(res.body.bills).toEqual([])
  })

  it('retrieves all bills and their constituent shares with payment status in deterministic member order', async () => {
    const { homeId, members } = await createHome(['Asha', 'Ben'])
    const b1 = await createBill(homeId, 1000)
    const b2 = await createBill(homeId, 400)

    // Pay Asha's share in b1
    const share1 = b1.body.shares[0]
    if (!share1) throw new Error('missing share')
    await call('POST', `/api/bills/${b1.body.id}/shares/${share1.id}/pay`, {
      headers: { 'Idempotency-Key': crypto.randomUUID() },
    })

    const res = await call<{
      bills: Array<{
        id: string
        homeId: string
        title: string
        totalCents: number
        shares: Array<{ id: string; memberId: string; amountCents: number; paidAt: string | null }>
      }>
    }>('GET', `/api/homes/${homeId}/bills`)

    expect(res.status).toBe(200)
    expect(res.body.bills.length).toBe(2)

    const bill1 = res.body.bills.find((b) => b.id === b1.body.id)
    const bill2 = res.body.bills.find((b) => b.id === b2.body.id)

    expect(bill1).toBeDefined()
    expect(bill2).toBeDefined()

    expect(bill1?.shares[0]?.memberId).toBe(members[0]?.id)
    expect(bill1?.shares[0]?.paidAt).toEqual(expect.any(String))
    expect(bill1?.shares[1]?.memberId).toBe(members[1]?.id)
    expect(bill1?.shares[1]?.paidAt).toBeNull()

    expect(bill2?.shares[0]?.paidAt).toBeNull()
    expect(bill2?.shares[1]?.paidAt).toBeNull()
  })

  it('never leaks bills or shares from another home', async () => {
    const homeA = await createHome(['Alice'])
    const homeB = await createHome(['Bob'])

    await createBill(homeA.homeId, 1200)
    await createBill(homeB.homeId, 3400)

    const resA = await call<{ bills: Array<{ id: string; homeId: string; totalCents: number }> }>(
      'GET',
      `/api/homes/${homeA.homeId}/bills`,
    )
    const resB = await call<{ bills: Array<{ id: string; homeId: string; totalCents: number }> }>(
      'GET',
      `/api/homes/${homeB.homeId}/bills`,
    )

    expect(resA.body.bills.length).toBe(1)
    expect(resA.body.bills[0]?.homeId).toBe(homeA.homeId)
    expect(resA.body.bills[0]?.totalCents).toBe(1200)

    expect(resB.body.bills.length).toBe(1)
    expect(resB.body.bills[0]?.homeId).toBe(homeB.homeId)
    expect(resB.body.bills[0]?.totalCents).toBe(3400)
  })
})
