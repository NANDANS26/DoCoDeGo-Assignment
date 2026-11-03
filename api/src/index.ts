import { type Context, Hono } from 'hono'

interface HomeRow {
  id: string
  name: string
  created_at: string
}

interface MemberRow {
  id: string
  home_id: string
  name: string
  created_at: string
}

interface ShareRow {
  id: string
  bill_id: string
  member_id: string
  amount_cents: number
  paid_at: string | null
  idempotency_key: string | null
}

const app = new Hono<{ Bindings: Env }>()

// Standardized Not-Found and Error Handlers
app.notFound((c) => c.json({ error: 'Route not found' }, 404))

app.onError((err, c) => {
  const status = 'status' in err && typeof err.status === 'number' ? err.status : 500
  return c.json({ error: err.message || 'Internal Server Error' }, status as 500)
})

// Health check
app.get('/api/health', (c) => c.json({ status: 'ok' }))

// Helper: Safely parse JSON body
async function parseJsonBody<T>(c: Context): Promise<T | null> {
  try {
    return (await c.req.json()) as T
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// PHASE 2: HOMES & MEMBERS
// ---------------------------------------------------------------------------

// GET /api/homes - List all homes (For frontend selector)
app.get('/api/homes', async (c) => {
  const homes = await c.env.DB.prepare(
    'SELECT id, name, created_at FROM homes ORDER BY created_at ASC',
  ).all<HomeRow>()

  return c.json({ homes: homes.results || [] }, 200)
})

// GET /api/homes/:homeId - Get a single home
app.get('/api/homes/:homeId', async (c) => {
  const homeId = c.req.param('homeId')
  const home = await c.env.DB.prepare('SELECT id, name, created_at FROM homes WHERE id = ?')
    .bind(homeId)
    .first<HomeRow>()

  if (!home) {
    return c.json({ error: 'Home not found' }, 404)
  }

  return c.json({ id: home.id, name: home.name }, 200)
})

// POST /api/homes - Create a new home
app.post('/api/homes', async (c) => {
  const body = await parseJsonBody<{ name?: unknown }>(c)
  if (!body || typeof body.name !== 'string' || body.name.trim().length === 0) {
    return c.json({ error: 'Invalid name: must be a non-empty string' }, 400)
  }

  const id = crypto.randomUUID()
  const name = body.name.trim()

  await c.env.DB.prepare('INSERT INTO homes (id, name) VALUES (?, ?)').bind(id, name).run()

  return c.json({ id, name }, 201)
})

// POST /api/homes/:homeId/members - Add a member to a home
app.post('/api/homes/:homeId/members', async (c) => {
  const homeId = c.req.param('homeId')

  // Verify home existence
  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?')
    .bind(homeId)
    .first<HomeRow>()

  if (!home) {
    return c.json({ error: 'Home not found' }, 404)
  }

  const body = await parseJsonBody<{ name?: unknown }>(c)
  if (!body || typeof body.name !== 'string' || body.name.trim().length === 0) {
    return c.json({ error: 'Invalid name: must be a non-empty string' }, 400)
  }

  const id = crypto.randomUUID()
  const name = body.name.trim()

  await c.env.DB.prepare(
    'INSERT INTO members (id, home_id, name, sort_order) VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM members WHERE home_id = ?))',
  )
    .bind(id, homeId, name, homeId)
    .run()

  return c.json({ id, homeId, name }, 201)
})

// ---------------------------------------------------------------------------
// PHASE 3: BILL CREATION & DETERMINISTIC SPLITTING ENGINE
// ---------------------------------------------------------------------------

// POST /api/homes/:homeId/bills - Create and split a bill among home members
app.post('/api/homes/:homeId/bills', async (c) => {
  const homeId = c.req.param('homeId')

  // Verify home existence
  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?')
    .bind(homeId)
    .first<HomeRow>()

  if (!home) {
    return c.json({ error: 'Home not found' }, 404)
  }

  const body = await parseJsonBody<{ title?: unknown; totalCents?: unknown }>(c)
  if (!body) {
    return c.json({ error: 'Malformed JSON body' }, 400)
  }

  // Validate totalCents: positive integer
  if (
    typeof body.totalCents !== 'number' ||
    !Number.isInteger(body.totalCents) ||
    body.totalCents <= 0
  ) {
    return c.json({ error: 'Invalid totalCents: must be a positive integer' }, 422)
  }

  // Validate title
  if (typeof body.title !== 'string' || body.title.trim().length === 0) {
    return c.json({ error: 'Invalid title: must be a non-empty string' }, 422)
  }

  const totalCents = body.totalCents
  const title = body.title.trim()

  // Retrieve members in deterministic insertion order (by explicit sort_order ASC)
  const membersResult = await c.env.DB.prepare(
    'SELECT id, name FROM members WHERE home_id = ? ORDER BY sort_order ASC',
  )
    .bind(homeId)
    .all<MemberRow>()

  const members = membersResult.results
  if (!members || members.length === 0) {
    return c.json({ error: 'Home has no members' }, 422)
  }

  const n = members.length
  const baseShare = Math.floor(totalCents / n)
  const remainder = totalCents % n

  const billId = crypto.randomUUID()
  const shares: Array<{
    id: string
    memberId: string
    amountCents: number
    paidAt: null
  }> = []

  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      'INSERT INTO bills (id, home_id, title, total_cents) VALUES (?, ?, ?, ?)',
    ).bind(billId, homeId, title, totalCents),
  ]

  for (let i = 0; i < n; i++) {
    const member = members[i]
    if (!member) continue

    const shareId = crypto.randomUUID()
    const amountCents = i < remainder ? baseShare + 1 : baseShare

    shares.push({
      id: shareId,
      memberId: member.id,
      amountCents,
      paidAt: null,
    })

    statements.push(
      c.env.DB.prepare(
        'INSERT INTO shares (id, bill_id, member_id, amount_cents) VALUES (?, ?, ?, ?)',
      ).bind(shareId, billId, member.id, amountCents),
    )
  }

  // Execute atomically in a single D1 batch transaction
  await c.env.DB.batch(statements)

  return c.json(
    {
      id: billId,
      homeId,
      title,
      totalCents,
      shares,
    },
    201,
  )
})

// ---------------------------------------------------------------------------
// PAYMENTS & BALANCES (Required for complete suite verification)
// ---------------------------------------------------------------------------

// POST /api/bills/:billId/shares/:shareId/pay
app.post('/api/bills/:billId/shares/:shareId/pay', async (c) => {
  const billId = c.req.param('billId')
  const shareId = c.req.param('shareId')
  const idempotencyKey = c.req.header('Idempotency-Key')

  if (!idempotencyKey || idempotencyKey.trim().length === 0) {
    return c.json({ error: 'Missing Idempotency-Key header' }, 400)
  }

  const trimmedKey = idempotencyKey.trim()
  if (trimmedKey.length > 256) {
    return c.json({ error: 'Idempotency-Key exceeds maximum length of 256 characters' }, 400)
  }

  // Look up share and verify it belongs to this bill
  const share = await c.env.DB.prepare(
    'SELECT s.id, s.bill_id, s.member_id, s.amount_cents, s.paid_at, s.idempotency_key ' +
      'FROM shares s JOIN bills b ON b.id = s.bill_id ' +
      'WHERE b.id = ? AND s.id = ?',
  )
    .bind(billId, shareId)
    .first<ShareRow>()

  if (!share) {
    return c.json({ error: 'Bill or share not found' }, 404)
  }

  // If already paid
  if (share.paid_at !== null) {
    if (share.idempotency_key === trimmedKey) {
      // Idempotent replay: return identical result
      return c.json(
        {
          id: share.id,
          memberId: share.member_id,
          amountCents: share.amount_cents,
          paidAt: share.paid_at,
        },
        200,
      )
    }
    // Conflict: paid with a different idempotency key
    return c.json({ error: 'Share already paid with a different key' }, 409)
  }

  // Unpaid: atomically update share
  const now = new Date().toISOString()
  const updateResult = await c.env.DB.prepare(
    'UPDATE shares SET paid_at = ?, idempotency_key = ? WHERE id = ? AND paid_at IS NULL',
  )
    .bind(now, trimmedKey, shareId)
    .run()

  if (updateResult.meta.changes === 0) {
    // Concurrent request race: re-check state
    const current = await c.env.DB.prepare(
      'SELECT id, member_id, amount_cents, paid_at, idempotency_key FROM shares WHERE id = ?',
    )
      .bind(shareId)
      .first<ShareRow>()

    if (current && current.idempotency_key === trimmedKey) {
      return c.json(
        {
          id: current.id,
          memberId: current.member_id,
          amountCents: current.amount_cents,
          paidAt: current.paid_at,
        },
        200,
      )
    }
    return c.json({ error: 'Share already paid with a different key' }, 409)
  }

  return c.json(
    {
      id: share.id,
      memberId: share.member_id,
      amountCents: share.amount_cents,
      paidAt: now,
    },
    200,
  )
})

// GET /api/homes/:homeId/bills - Read all bills and their shares for a home (Required for Frontend integration)
app.get('/api/homes/:homeId/bills', async (c) => {
  const homeId = c.req.param('homeId')

  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?')
    .bind(homeId)
    .first<HomeRow>()

  if (!home) {
    return c.json({ error: 'Home not found' }, 404)
  }

  const billsResult = await c.env.DB.prepare(
    'SELECT id, home_id, title, total_cents, created_at FROM bills WHERE home_id = ? ORDER BY created_at ASC, id ASC',
  )
    .bind(homeId)
    .all<{ id: string; home_id: string; title: string; total_cents: number; created_at: string }>()

  const billsList = billsResult.results || []
  const billsWithShares = []

  for (const bill of billsList) {
    const sharesResult = await c.env.DB.prepare(
      'SELECT s.id, s.member_id, s.amount_cents, s.paid_at ' +
        'FROM shares s JOIN members m ON m.id = s.member_id ' +
        'WHERE s.bill_id = ? ' +
        'ORDER BY m.sort_order ASC',
    )
      .bind(bill.id)
      .all<{ id: string; member_id: string; amount_cents: number; paid_at: string | null }>()

    billsWithShares.push({
      id: bill.id,
      homeId: bill.home_id,
      title: bill.title,
      totalCents: bill.total_cents,
      shares: (sharesResult.results || []).map((s) => ({
        id: s.id,
        memberId: s.member_id,
        amountCents: s.amount_cents,
        paidAt: s.paid_at,
      })),
    })
  }

  return c.json({ bills: billsWithShares }, 200)
})

// GET /api/homes/:homeId/balances
app.get('/api/homes/:homeId/balances', async (c) => {
  const homeId = c.req.param('homeId')

  // Verify home existence
  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?')
    .bind(homeId)
    .first<HomeRow>()

  if (!home) {
    return c.json({ error: 'Home not found' }, 404)
  }

  // Query each member in deterministic insertion order, calculating unpaid shares
  const balancesResult = await c.env.DB.prepare(
    'SELECT m.id AS memberId, m.name AS name, ' +
      'COALESCE((' +
      '  SELECT SUM(s.amount_cents) FROM shares s ' +
      '  JOIN bills b ON b.id = s.bill_id ' +
      '  WHERE s.member_id = m.id AND b.home_id = ? AND s.paid_at IS NULL' +
      '), 0) AS outstandingCents ' +
      'FROM members m WHERE m.home_id = ? ORDER BY m.sort_order ASC',
  )
    .bind(homeId, homeId)
    .all<{ memberId: string; name: string; outstandingCents: number }>()

  return c.json({ balances: balancesResult.results || [] }, 200)
})

export default app
