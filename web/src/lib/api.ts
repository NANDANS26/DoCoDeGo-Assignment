import type { Balance, Bill, Home, Member, Share } from '../types/api'

export class ApiClientError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiClientError'
    this.status = status
  }
}

async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers || {})
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  let res: Response
  try {
    res = await fetch(endpoint, {
      ...options,
      headers,
    })
  } catch (err) {
    throw new ApiClientError(
      err instanceof Error ? err.message : 'Network request failed. Is the server running?',
      0,
    )
  }

  let data: unknown = null
  const contentType = res.headers.get('content-type')
  if (contentType?.includes('application/json')) {
    try {
      data = await res.json()
    } catch {
      data = null
    }
  }

  if (!res.ok) {
    const errorMsg =
      data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
        ? data.error
        : `Request failed with status ${res.status}`
    throw new ApiClientError(errorMsg, res.status)
  }

  return data as T
}

export const api = {
  async listHomes(): Promise<Home[]> {
    const data = await request<{ homes: Home[] }>('/api/homes')
    return data.homes
  },

  async getHome(homeId: string): Promise<Home> {
    return request<Home>(`/api/homes/${encodeURIComponent(homeId)}`)
  },

  async createHome(name: string): Promise<Home> {
    return request<Home>('/api/homes', {
      method: 'POST',
      body: JSON.stringify({ name }),
    })
  },

  async addMember(homeId: string, name: string): Promise<Member> {
    return request<Member>(`/api/homes/${encodeURIComponent(homeId)}/members`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    })
  },

  async createBill(homeId: string, title: string, totalCents: number): Promise<Bill> {
    return request<Bill>(`/api/homes/${encodeURIComponent(homeId)}/bills`, {
      method: 'POST',
      body: JSON.stringify({ title, totalCents }),
    })
  },

  async getBills(homeId: string): Promise<Bill[]> {
    const data = await request<{ bills: Bill[] }>(`/api/homes/${encodeURIComponent(homeId)}/bills`)
    return data.bills
  },

  async getBalances(homeId: string): Promise<Balance[]> {
    const data = await request<{ balances: Balance[] }>(
      `/api/homes/${encodeURIComponent(homeId)}/balances`,
    )
    return data.balances
  },

  async payShare(billId: string, shareId: string, idempotencyKey: string): Promise<Share> {
    return request<Share>(
      `/api/bills/${encodeURIComponent(billId)}/shares/${encodeURIComponent(shareId)}/pay`,
      {
        method: 'POST',
        headers: {
          'Idempotency-Key': idempotencyKey,
        },
      },
    )
  },
}
