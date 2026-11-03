import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

describe('database schema & constraints verification', () => {
  it('verifies all tables exist', async () => {
    const result = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('homes', 'members', 'bills', 'shares')",
    ).all<{ name: string }>()

    const tableNames = result.results.map((r) => r.name).sort()
    expect(tableNames).toEqual(['bills', 'homes', 'members', 'shares'])
  })

  it('rejects empty or whitespace-only home name via constraint', async () => {
    await expect(
      env.DB.prepare('INSERT INTO homes (id, name) VALUES (?, ?)').bind('h1', '   ').run(),
    ).rejects.toThrow()
  })

  it('enforces foreign key constraint on members(home_id)', async () => {
    await expect(
      env.DB.prepare('INSERT INTO members (id, home_id, name, sort_order) VALUES (?, ?, ?, ?)')
        .bind('m1', 'nonexistent-home', 'Asha', 1)
        .run(),
    ).rejects.toThrow()
  })

  it('enforces foreign key constraint on bills(home_id)', async () => {
    await expect(
      env.DB.prepare('INSERT INTO bills (id, home_id, title, total_cents) VALUES (?, ?, ?, ?)')
        .bind('b1', 'nonexistent-home', 'Electricity', 1000)
        .run(),
    ).rejects.toThrow()
  })

  it('rejects non-positive or float bill total_cents via constraint', async () => {
    // Zero cents rejected
    await expect(
      env.DB.prepare('INSERT INTO homes (id, name) VALUES (?, ?)')
        .bind('h-test', 'Valid Home')
        .run(),
    )
    await expect(
      env.DB.prepare('INSERT INTO bills (id, home_id, title, total_cents) VALUES (?, ?, ?, ?)')
        .bind('b-zero', 'h-test', 'Zero Bill', 0)
        .run(),
    ).rejects.toThrow()

    // Negative cents rejected
    await expect(
      env.DB.prepare('INSERT INTO bills (id, home_id, title, total_cents) VALUES (?, ?, ?, ?)')
        .bind('b-neg', 'h-test', 'Neg Bill', -100)
        .run(),
    ).rejects.toThrow()

    // Float cents rejected
    await expect(
      env.DB.prepare('INSERT INTO bills (id, home_id, title, total_cents) VALUES (?, ?, ?, ?)')
        .bind('b-float', 'h-test', 'Float Bill', 10.5)
        .run(),
    ).rejects.toThrow()
  })

  it('accepts zero-cent shares as required for 1-cent split among multiple members', async () => {
    await env.DB.prepare('INSERT OR IGNORE INTO homes (id, name) VALUES (?, ?)')
      .bind('h-share', 'Home 1')
      .run()
    await env.DB.prepare('INSERT INTO members (id, home_id, name, sort_order) VALUES (?, ?, ?, ?)')
      .bind('m-share-1', 'h-share', 'Asha', 1)
      .run()
    await env.DB.prepare('INSERT INTO bills (id, home_id, title, total_cents) VALUES (?, ?, ?, ?)')
      .bind('b-share-1', 'h-share', 'One Cent Bill', 1)
      .run()

    // Zero-cent share must succeed
    const res = await env.DB.prepare(
      'INSERT INTO shares (id, bill_id, member_id, amount_cents) VALUES (?, ?, ?, ?)',
    )
      .bind('s-zero', 'b-share-1', 'm-share-1', 0)
      .run()

    expect(res.success).toBe(true)

    // Negative share must be rejected
    await expect(
      env.DB.prepare(
        'INSERT INTO shares (id, bill_id, member_id, amount_cents) VALUES (?, ?, ?, ?)',
      )
        .bind('s-neg', 'b-share-1', 'm-share-1', -1)
        .run(),
    ).rejects.toThrow()
  })

  it('enforces paid consistency constraint on shares', async () => {
    await env.DB.prepare('INSERT OR IGNORE INTO homes (id, name) VALUES (?, ?)')
      .bind('h-pc', 'Home PC')
      .run()
    await env.DB.prepare('INSERT INTO members (id, home_id, name, sort_order) VALUES (?, ?, ?, ?)')
      .bind('m-pc', 'h-pc', 'Asha', 1)
      .run()
    await env.DB.prepare('INSERT INTO bills (id, home_id, title, total_cents) VALUES (?, ?, ?, ?)')
      .bind('b-pc', 'h-pc', 'Bill PC', 100)
      .run()

    // paid_at without idempotency_key must fail
    await expect(
      env.DB.prepare(
        'INSERT INTO shares (id, bill_id, member_id, amount_cents, paid_at, idempotency_key) VALUES (?, ?, ?, ?, ?, ?)',
      )
        .bind('s-inval-1', 'b-pc', 'm-pc', 100, '2026-11-03T00:00:00.000Z', null)
        .run(),
    ).rejects.toThrow()

    // idempotency_key without paid_at must fail
    await expect(
      env.DB.prepare(
        'INSERT INTO shares (id, bill_id, member_id, amount_cents, paid_at, idempotency_key) VALUES (?, ?, ?, ?, ?, ?)',
      )
        .bind('s-inval-2', 'b-pc', 'm-pc', 100, null, 'key-123')
        .run(),
    ).rejects.toThrow()

    // both present must succeed
    const validPaid = await env.DB.prepare(
      'INSERT INTO shares (id, bill_id, member_id, amount_cents, paid_at, idempotency_key) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind('s-valid-paid', 'b-pc', 'm-pc', 100, '2026-11-03T00:00:00.000Z', 'key-123')
      .run()

    expect(validPaid.success).toBe(true)
  })

  it('FINDING 1: rejects cross-home shares at the database level via trigger', async () => {
    // Setup Home A and Home B
    await env.DB.prepare('INSERT INTO homes (id, name) VALUES (?, ?)')
      .bind('home-a', 'Home A')
      .run()
    await env.DB.prepare('INSERT INTO homes (id, name) VALUES (?, ?)')
      .bind('home-b', 'Home B')
      .run()

    // Member in Home A, Member in Home B
    await env.DB.prepare('INSERT INTO members (id, home_id, name, sort_order) VALUES (?, ?, ?, ?)')
      .bind('mem-a', 'home-a', 'Alice', 1)
      .run()
    await env.DB.prepare('INSERT INTO members (id, home_id, name, sort_order) VALUES (?, ?, ?, ?)')
      .bind('mem-b', 'home-b', 'Bob', 1)
      .run()

    // Bill belonging to Home A
    await env.DB.prepare('INSERT INTO bills (id, home_id, title, total_cents) VALUES (?, ?, ?, ?)')
      .bind('bill-a', 'home-a', 'Internet', 5000)
      .run()

    // Same-home share: bill-a (Home A) + mem-a (Home A) -> MUST SUCCEED
    const validShare = await env.DB.prepare(
      'INSERT INTO shares (id, bill_id, member_id, amount_cents) VALUES (?, ?, ?, ?)',
    )
      .bind('share-valid', 'bill-a', 'mem-a', 5000)
      .run()
    expect(validShare.success).toBe(true)

    // Cross-home share: bill-a (Home A) + mem-b (Home B) -> MUST BE REJECTED BY DATABASE TRIGGER
    await expect(
      env.DB.prepare(
        'INSERT INTO shares (id, bill_id, member_id, amount_cents) VALUES (?, ?, ?, ?)',
      )
        .bind('share-cross', 'bill-a', 'mem-b', 5000)
        .run(),
    ).rejects.toThrow(/Cross-home share rejected/)
  })

  it('FINDING 2: rejects duplicate shares for same bill and member via uq_shares_bill_member', async () => {
    await env.DB.prepare('INSERT OR IGNORE INTO homes (id, name) VALUES (?, ?)')
      .bind('h-dup', 'Dup Home')
      .run()
    await env.DB.prepare('INSERT INTO members (id, home_id, name, sort_order) VALUES (?, ?, ?, ?)')
      .bind('m-dup', 'h-dup', 'Dan', 1)
      .run()
    await env.DB.prepare('INSERT INTO bills (id, home_id, title, total_cents) VALUES (?, ?, ?, ?)')
      .bind('b-dup', 'h-dup', 'Dup Bill', 2000)
      .run()

    // First share
    const first = await env.DB.prepare(
      'INSERT INTO shares (id, bill_id, member_id, amount_cents) VALUES (?, ?, ?, ?)',
    )
      .bind('s-dup-1', 'b-dup', 'm-dup', 1000)
      .run()
    expect(first.success).toBe(true)

    // Second share for same (bill_id, member_id) -> MUST BE REJECTED
    await expect(
      env.DB.prepare(
        'INSERT INTO shares (id, bill_id, member_id, amount_cents) VALUES (?, ?, ?, ?)',
      )
        .bind('s-dup-2', 'b-dup', 'm-dup', 1000)
        .run(),
    ).rejects.toThrow()
  })

  it('FINDING 3: enforces deterministic sort_order and unique sequence per home, surviving deletion and maintenance', async () => {
    await env.DB.prepare('INSERT INTO homes (id, name) VALUES (?, ?)')
      .bind('h-order', 'Order Home')
      .run()

    // Insert 3 members with explicit sort_order
    await env.DB.prepare('INSERT INTO members (id, home_id, name, sort_order) VALUES (?, ?, ?, ?)')
      .bind('mo-1', 'h-order', 'Member 1', 1)
      .run()
    await env.DB.prepare('INSERT INTO members (id, home_id, name, sort_order) VALUES (?, ?, ?, ?)')
      .bind('mo-2', 'h-order', 'Member 2', 2)
      .run()
    await env.DB.prepare('INSERT INTO members (id, home_id, name, sort_order) VALUES (?, ?, ?, ?)')
      .bind('mo-3', 'h-order', 'Member 3', 3)
      .run()

    // Duplicate sort_order in same home rejected
    await expect(
      env.DB.prepare('INSERT INTO members (id, home_id, name, sort_order) VALUES (?, ?, ?, ?)')
        .bind('mo-dup', 'h-order', 'Member Dup', 2)
        .run(),
    ).rejects.toThrow()

    // Delete middle member (mo-2)
    await env.DB.prepare('DELETE FROM members WHERE id = ?').bind('mo-2').run()

    // Check query order after deletion: Member 1 then Member 3
    const afterDelete = await env.DB.prepare(
      'SELECT id, name, sort_order FROM members WHERE home_id = ? ORDER BY sort_order ASC',
    )
      .bind('h-order')
      .all<{ id: string; name: string; sort_order: number }>()

    expect(afterDelete.results.map((m) => m.name)).toEqual(['Member 1', 'Member 3'])
    expect(afterDelete.results.map((m) => m.sort_order)).toEqual([1, 3])

    // Append new member using MAX(sort_order) + 1 subquery
    await env.DB.prepare(
      'INSERT INTO members (id, home_id, name, sort_order) VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM members WHERE home_id = ?))',
    )
      .bind('mo-4', 'h-order', 'Member 4', 'h-order')
      .run()

    const finalOrder = await env.DB.prepare(
      'SELECT id, name, sort_order FROM members WHERE home_id = ? ORDER BY sort_order ASC',
    )
      .bind('h-order')
      .all<{ id: string; name: string; sort_order: number }>()

    expect(finalOrder.results.map((m) => m.name)).toEqual(['Member 1', 'Member 3', 'Member 4'])
    expect(finalOrder.results.map((m) => m.sort_order)).toEqual([1, 3, 4])
  })

  it('PARENT REASSIGNMENT: prevents bill home_id reassignment when shares exist', async () => {
    await env.DB.prepare('INSERT INTO homes (id, name) VALUES (?, ?)')
      .bind('h-reassign-1', 'Home 1')
      .run()
    await env.DB.prepare('INSERT INTO homes (id, name) VALUES (?, ?)')
      .bind('h-reassign-2', 'Home 2')
      .run()

    await env.DB.prepare('INSERT INTO members (id, home_id, name, sort_order) VALUES (?, ?, ?, ?)')
      .bind('m-reassign-1', 'h-reassign-1', 'Member 1', 1)
      .run()

    await env.DB.prepare('INSERT INTO bills (id, home_id, title, total_cents) VALUES (?, ?, ?, ?)')
      .bind('b-reassign-1', 'h-reassign-1', 'Bill 1', 1000)
      .run()

    await env.DB.prepare(
      'INSERT INTO shares (id, bill_id, member_id, amount_cents) VALUES (?, ?, ?, ?)',
    )
      .bind('s-reassign-1', 'b-reassign-1', 'm-reassign-1', 1000)
      .run()

    // Updating title on bill with shares -> SUCCEEDS
    const titleUpdate = await env.DB.prepare('UPDATE bills SET title = ? WHERE id = ?')
      .bind('Updated Bill Title', 'b-reassign-1')
      .run()
    expect(titleUpdate.success).toBe(true)

    // Updating home_id on bill with shares -> MUST BE REJECTED BY TRIGGER
    await expect(
      env.DB.prepare('UPDATE bills SET home_id = ? WHERE id = ?')
        .bind('h-reassign-2', 'b-reassign-1')
        .run(),
    ).rejects.toThrow(/Cannot reassign bill home_id when shares exist/)

    // Bill with NO shares -> updating home_id SUCCEEDS
    await env.DB.prepare('INSERT INTO bills (id, home_id, title, total_cents) VALUES (?, ?, ?, ?)')
      .bind('b-reassign-empty', 'h-reassign-1', 'Empty Bill', 500)
      .run()

    const emptyBillUpdate = await env.DB.prepare('UPDATE bills SET home_id = ? WHERE id = ?')
      .bind('h-reassign-2', 'b-reassign-empty')
      .run()
    expect(emptyBillUpdate.success).toBe(true)
  })

  it('PARENT REASSIGNMENT: prevents member home_id reassignment when shares exist', async () => {
    await env.DB.prepare('INSERT INTO homes (id, name) VALUES (?, ?)')
      .bind('hm-reassign-1', 'Home 1')
      .run()
    await env.DB.prepare('INSERT INTO homes (id, name) VALUES (?, ?)')
      .bind('hm-reassign-2', 'Home 2')
      .run()

    await env.DB.prepare('INSERT INTO members (id, home_id, name, sort_order) VALUES (?, ?, ?, ?)')
      .bind('mem-reassign-1', 'hm-reassign-1', 'Member 1', 1)
      .run()

    await env.DB.prepare('INSERT INTO bills (id, home_id, title, total_cents) VALUES (?, ?, ?, ?)')
      .bind('bill-reassign-1', 'hm-reassign-1', 'Bill 1', 1000)
      .run()

    await env.DB.prepare(
      'INSERT INTO shares (id, bill_id, member_id, amount_cents) VALUES (?, ?, ?, ?)',
    )
      .bind('sh-reassign-1', 'bill-reassign-1', 'mem-reassign-1', 1000)
      .run()

    // Updating name on member with shares -> SUCCEEDS
    const nameUpdate = await env.DB.prepare('UPDATE members SET name = ? WHERE id = ?')
      .bind('Renamed Member', 'mem-reassign-1')
      .run()
    expect(nameUpdate.success).toBe(true)

    // Updating home_id on member with shares -> MUST BE REJECTED BY TRIGGER
    await expect(
      env.DB.prepare('UPDATE members SET home_id = ? WHERE id = ?')
        .bind('hm-reassign-2', 'mem-reassign-1')
        .run(),
    ).rejects.toThrow(/Cannot reassign member home_id when shares exist/)
  })

  it('MEMBER ORDERING: verifies sequence behavior when highest-order member is deleted', async () => {
    await env.DB.prepare('INSERT INTO homes (id, name) VALUES (?, ?)')
      .bind('h-high', 'High-Water Home')
      .run()

    await env.DB.prepare('INSERT INTO members (id, home_id, name, sort_order) VALUES (?, ?, ?, ?)')
      .bind('mh-1', 'h-high', 'A', 1)
      .run()
    await env.DB.prepare('INSERT INTO members (id, home_id, name, sort_order) VALUES (?, ?, ?, ?)')
      .bind('mh-2', 'h-high', 'B', 2)
      .run()
    await env.DB.prepare('INSERT INTO members (id, home_id, name, sort_order) VALUES (?, ?, ?, ?)')
      .bind('mh-3', 'h-high', 'C', 3)
      .run()

    // Delete highest member (C with sort_order 3)
    await env.DB.prepare('DELETE FROM members WHERE id = ?').bind('mh-3').run()

    // Insert new member using MAX(sort_order) + 1 -> position 3 is reused because max surviving is 2
    await env.DB.prepare(
      'INSERT INTO members (id, home_id, name, sort_order) VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM members WHERE home_id = ?))',
    )
      .bind('mh-new', 'h-high', 'D', 'h-high')
      .run()

    const roster = await env.DB.prepare(
      'SELECT name, sort_order FROM members WHERE home_id = ? ORDER BY sort_order ASC',
    )
      .bind('h-high')
      .all<{ name: string; sort_order: number }>()

    expect(roster.results.map((m) => m.name)).toEqual(['A', 'B', 'D'])
    expect(roster.results.map((m) => m.sort_order)).toEqual([1, 2, 3])
  })
})
