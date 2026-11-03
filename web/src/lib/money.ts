/**
 * Formats an integer number of cents into a standard currency string ($X.XX).
 * Never uses floating-point division; formats cents with integer arithmetic.
 */
export function formatCents(cents: number): string {
  if (!Number.isFinite(cents) || !Number.isInteger(cents)) {
    return '$0.00'
  }
  const isNegative = cents < 0
  const absCents = Math.abs(cents)
  const dollars = Math.floor(absCents / 100)
  const remainder = absCents % 100
  const centsStr = remainder.toString().padStart(2, '0')
  return `${isNegative ? '-' : ''}$${dollars}.${centsStr}`
}

/**
 * Parses user input (e.g. "10.50", "$10.50", "10", "0.99") into whole integer cents.
 * Disallows:
 * - Negative amounts
 * - Zero amounts
 * - More than 2 decimal places (fractional cents)
 * - Non-numeric characters (aside from optional leading '$' and spaces)
 *
 * Returns null if the input is invalid or <= 0.
 */
export function parseToCents(input: string): number | null {
  if (typeof input !== 'string') return null
  const cleaned = input.trim().replace(/^\$/, '').trim()
  if (cleaned.length === 0) return null

  // Must match valid currency pattern: optional digits, decimal point, 1 or 2 digits; or just digits
  const currencyRegex = /^\d+(\.\d{1,2})?$/
  if (!currencyRegex.test(cleaned)) {
    return null
  }

  const parts = cleaned.split('.')
  const dollars = Number.parseInt(parts[0] || '0', 10)
  if (!Number.isSafeInteger(dollars) || dollars < 0) {
    return null
  }

  let cents = 0
  if (parts.length === 2) {
    const decStr = parts[1] || ''
    if (decStr.length === 1) {
      cents = Number.parseInt(decStr, 10) * 10
    } else if (decStr.length === 2) {
      cents = Number.parseInt(decStr, 10)
    } else {
      return null
    }
  }

  const total = dollars * 100 + cents
  if (!Number.isSafeInteger(total) || total <= 0) {
    return null
  }

  return total
}

/**
 * Computes deterministic split preview across N members.
 * Exactly matches the backend logic in Part 2:
 * base = floor(totalCents / N)
 * remainder = totalCents % N
 * first remainder members get base + 1, remainder get base.
 */
export function calculateSplitPreview(totalCents: number, memberCount: number): number[] {
  if (memberCount <= 0 || totalCents <= 0 || !Number.isInteger(totalCents)) {
    return []
  }

  const base = Math.floor(totalCents / memberCount)
  const remainder = totalCents % memberCount
  const result: number[] = []

  for (let i = 0; i < memberCount; i++) {
    result.push(i < remainder ? base + 1 : base)
  }

  return result
}
