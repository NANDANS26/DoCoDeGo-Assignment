import { describe, expect, it } from 'vitest'
import { calculateSplitPreview, formatCents, parseToCents } from '../src/lib/money'

describe('money utilities', () => {
  describe('formatCents', () => {
    it('formats positive cents correctly', () => {
      expect(formatCents(1050)).toBe('$10.50')
      expect(formatCents(100)).toBe('$1.00')
      expect(formatCents(5)).toBe('$0.05')
      expect(formatCents(333)).toBe('$3.33')
      expect(formatCents(334)).toBe('$3.34')
    })

    it('formats zero cents correctly', () => {
      expect(formatCents(0)).toBe('$0.00')
    })

    it('formats negative cents with minus sign', () => {
      expect(formatCents(-500)).toBe('-$5.00')
      expect(formatCents(-5)).toBe('-$0.05')
    })

    it('handles non-integer or NaN safely', () => {
      expect(formatCents(NaN)).toBe('$0.00')
      expect(formatCents(12.34)).toBe('$0.00')
    })
  })

  describe('parseToCents', () => {
    it('parses valid dollar amounts to integer cents', () => {
      expect(parseToCents('10.50')).toBe(1050)
      expect(parseToCents('$10.50')).toBe(1050)
      expect(parseToCents('10')).toBe(1000)
      expect(parseToCents('$10')).toBe(1000)
      expect(parseToCents('0.99')).toBe(99)
      expect(parseToCents('0.05')).toBe(5)
      expect(parseToCents('  25.5  ')).toBe(2550)
    })

    it('rejects zero or empty inputs', () => {
      expect(parseToCents('0')).toBeNull()
      expect(parseToCents('0.00')).toBeNull()
      expect(parseToCents('')).toBeNull()
      expect(parseToCents('   ')).toBeNull()
    })

    it('rejects negative amounts', () => {
      expect(parseToCents('-10')).toBeNull()
      expect(parseToCents('-$5.00')).toBeNull()
    })

    it('rejects more than 2 decimal places (fractional cents)', () => {
      expect(parseToCents('10.555')).toBeNull()
      expect(parseToCents('1.234')).toBeNull()
    })

    it('rejects malformed non-numeric strings', () => {
      expect(parseToCents('abc')).toBeNull()
      expect(parseToCents('10.5.5')).toBeNull()
      expect(parseToCents('$$10')).toBeNull()
    })
  })

  describe('calculateSplitPreview', () => {
    it('splits evenly when divisible', () => {
      expect(calculateSplitPreview(300, 3)).toEqual([100, 100, 100])
      expect(calculateSplitPreview(1000, 2)).toEqual([500, 500])
    })

    it('distributes remainder cents in order when not evenly divisible', () => {
      // 1000 cents across 3 members -> 334, 333, 333
      expect(calculateSplitPreview(1000, 3)).toEqual([334, 333, 333])
      // 100 cents across 3 members -> 34, 33, 33
      expect(calculateSplitPreview(100, 3)).toEqual([34, 33, 33])
      // 102 cents across 4 members -> 26, 26, 25, 25
      expect(calculateSplitPreview(102, 4)).toEqual([26, 26, 25, 25])
    })

    it('returns empty array for invalid inputs', () => {
      expect(calculateSplitPreview(0, 3)).toEqual([])
      expect(calculateSplitPreview(100, 0)).toEqual([])
      expect(calculateSplitPreview(-100, 2)).toEqual([])
    })
  })
})
