import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const settings = { compileConcurrencyLimit: 5 }
vi.mock('@overleaf/settings', () => ({ default: settings }))
vi.mock('@overleaf/logger', () => ({ default: { warn() {}, error() {} } }))
vi.mock('@overleaf/metrics', () => ({ default: { inc() {}, gauge() {} } }))
vi.mock('../../../app/js/RequestParser.js', () => ({
  default: { MAX_TIMEOUT: 600 },
}))

describe('LockManager ownership', () => {
  let errors: typeof import('../../../app/js/Errors.js')
  let manager: typeof import('../../../app/js/LockManager.js').default
  beforeEach(async () => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(0)
    settings.compileConcurrencyLimit = 5
    errors = await import('../../../app/js/Errors.js')
    manager = (await import('../../../app/js/LockManager.js')).default
  })
  afterEach(() => vi.useRealTimers())

  it('an expired owner finishing cannot remove its replacement or admit a third compile', () => {
    const old = manager.acquire('/project')
    vi.setSystemTime(720_000)
    const replacement = manager.acquire('/project')
    old.release()
    expect(manager.getExistingLock('/project')).toBe(replacement)
    expect(() => manager.acquire('/project')).toThrow(
      errors.AlreadyCompilingError
    )
    replacement.release()
    expect(manager.getExistingLock('/project')).toBeUndefined()
  })

  it('double release after ordinary handoff cannot remove a new owner', () => {
    const old = manager.acquire('/project')
    old.release()
    const replacement = manager.acquire('/project')
    old.release()
    expect(manager.getExistingLock('/project')).toBe(replacement)
    expect(() => manager.acquire('/project')).toThrow(
      errors.AlreadyCompilingError
    )
    replacement.release()
  })

  it('stale release cannot resolve the replacement waiter', async () => {
    const old = manager.acquire('/project')
    vi.setSystemTime(720_000)
    const replacement = manager.acquire('/project')
    let resolved = false
    const waiting = replacement.waitForRelease().then(() => {
      resolved = true
    })
    old.release()
    await Promise.resolve()
    expect(resolved).toBe(false)
    replacement.release()
    await waiting
    expect(resolved).toBe(true)
  })

  it('expiry takeover retains legacy timing and wakes the old waiter without ending old work', async () => {
    const old = manager.acquire('/project')
    const oldWaiter = old.waitForRelease()
    vi.setSystemTime(719_999)
    expect(() => manager.acquire('/project')).toThrow(
      errors.AlreadyCompilingError
    )
    vi.setSystemTime(720_000)
    const replacement = manager.acquire('/project')
    await oldWaiter
    expect(manager.getExistingLock('/project')).toBe(replacement)
    replacement.release()
  })

  it('release and duplicate release preserve another key', () => {
    const first = manager.acquire('/first')
    const second = manager.acquire('/second')
    first.release()
    first.release()
    expect(manager.getExistingLock('/first')).toBeUndefined()
    expect(manager.getExistingLock('/second')).toBe(second)
    second.release()
  })

  it('legacy concurrency boundary is unchanged, including its existing inclusive admission', () => {
    const locks = Array.from({ length: 6 }, (_, i) =>
      manager.acquire(`/project-${i}`)
    )
    expect(() => manager.acquire('/seventh')).toThrow(
      errors.TooManyCompileRequestsError
    )
    locks[0]?.release()
    const next = manager.acquire('/seventh')
    next.release()
    for (const lock of locks.slice(1)) lock.release()
  })
})
