import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

for (const mode of ['snapshot', 'adapter']) {
  for (const failure of ['', 'close-error']) {
    it(`${mode} joins held real input I/O and preserves ${failure || 'abort'} before releasing ownership`, () => {
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(
            new URL('./InputProducerLifetime.native.ts', import.meta.url)
          ),
          mode,
          failure,
        ],
        { encoding: 'utf8', timeout: 10000 }
      )
      expect(result.error, result.stderr).toBeUndefined()
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout.trim()).toBe(
        `${mode}${failure ? ' close-error' : ''} producer lifetime PASS`
      )
    })
  }
}
