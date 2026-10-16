import { describe, expect, it, vi } from 'vitest'
import { hashVisitorIp } from '../../server/utils/access-log'

vi.mock('#shared/utils/flag', () => ({ getFlag: vi.fn() }))

describe('hashVisitorIp', () => {
  it('returns a stable keyed hash that hides the raw address', () => {
    const hash = hashVisitorIp('203.0.113.7', 'site-token')
    expect(hash).toMatch(/^[0-9a-f]{32}$/)
    expect(hash).not.toContain('203.0.113.7')
    expect(hashVisitorIp('203.0.113.7', 'site-token')).toBe(hash)
  })

  it('separates visitors and keys', () => {
    const hash = hashVisitorIp('203.0.113.7', 'site-token')
    expect(hashVisitorIp('203.0.113.8', 'site-token')).not.toBe(hash)
    expect(hashVisitorIp('203.0.113.7', 'other-token')).not.toBe(hash)
  })

  it('keeps a missing address missing', () => {
    expect(hashVisitorIp(undefined, 'site-token')).toBeUndefined()
    expect(hashVisitorIp('', 'site-token')).toBe('')
  })
})
