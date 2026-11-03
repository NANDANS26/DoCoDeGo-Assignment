import { describe, expect, it } from 'vitest'
import { call, type Member } from './helpers'

describe('homes and members', () => {
  it('creates a home', async () => {
    const created = await call<{ id: string; name: string }>('POST', '/api/homes', {
      body: { name: 'Flat 4B' },
    })

    expect(created.status).toBe(201)
    expect(created.body.name).toBe('Flat 4B')
    expect(created.body.id).toEqual(expect.any(String))
  })

  it('adds a member to a home', async () => {
    const home = await call<{ id: string }>('POST', '/api/homes', { body: { name: 'Flat 4B' } })
    const member = await call<Member>('POST', `/api/homes/${home.body.id}/members`, {
      body: { name: 'Asha' },
    })

    expect(member.status).toBe(201)
    expect(member.body).toMatchObject({ homeId: home.body.id, name: 'Asha' })
  })

  it('returns 404 when the home does not exist', async () => {
    const member = await call('POST', '/api/homes/does-not-exist/members', {
      body: { name: 'Asha' },
    })

    expect(member.status).toBe(404)
  })

  it('rejects missing, empty, or whitespace-only home name with 400', async () => {
    const missing = await call('POST', '/api/homes', { body: {} })
    expect(missing.status).toBe(400)

    const empty = await call('POST', '/api/homes', { body: { name: '' } })
    expect(empty.status).toBe(400)

    const whitespace = await call('POST', '/api/homes', { body: { name: '   ' } })
    expect(whitespace.status).toBe(400)

    const nonString = await call('POST', '/api/homes', { body: { name: 12345 } })
    expect(nonString.status).toBe(400)
  })

  it('rejects missing or invalid member name with 400', async () => {
    const home = await call<{ id: string }>('POST', '/api/homes', { body: { name: 'Flat 4B' } })

    const missing = await call('POST', `/api/homes/${home.body.id}/members`, { body: {} })
    expect(missing.status).toBe(400)

    const whitespace = await call('POST', `/api/homes/${home.body.id}/members`, {
      body: { name: '   ' },
    })
    expect(whitespace.status).toBe(400)
  })

  it('preserves member insertion order across multiple members', async () => {
    const home = await call<{ id: string }>('POST', '/api/homes', { body: { name: 'Order Home' } })
    const names = ['Asha', 'Ben', 'Chitra', 'Dev', 'Esha']
    const createdMembers: Member[] = []

    for (const name of names) {
      const res = await call<Member>('POST', `/api/homes/${home.body.id}/members`, {
        body: { name },
      })
      expect(res.status).toBe(201)
      createdMembers.push(res.body)
    }

    expect(createdMembers.map((m) => m.name)).toEqual(names)
  })
})
