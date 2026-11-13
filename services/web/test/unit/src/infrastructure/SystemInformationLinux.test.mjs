// @ts-check
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** @type {{version:string}} */
const expectedPackage = createRequire(import.meta.url)(
  'systeminformation/package.json'
)
const fixture = fileURLToPath(
  new URL('./fixtures/systeminformation-linux.cjs', import.meta.url)
)
describe('Linux systeminformation compatibility through the metrics dependency path', () => {
  it('collects finite network counters and extra CPU/memory/load API snapshots', () => {
    const result = spawnSync(
      process.execPath,
      ['--max-old-space-size=128', fixture],
      { env: process.env, encoding: 'utf8', timeout: 10000 }
    )
    expect(result.error, result.stderr).toBeUndefined()
    expect(result.signal, result.stderr).toBeNull()
    expect(result.status, result.stderr).toBe(0)
    /** @type {{passed:boolean,packageVersion:string,directNetworkCount:number,actualMetricsNetworkCount:number,networkCountersFinite:boolean,extraCpuMemLoadSmokePassed:boolean}} */
    const summary = JSON.parse(result.stdout)
    expect(summary.packageVersion).toBe(expectedPackage.version)
    expect(summary.passed).toBe(true)
    expect(summary.networkCountersFinite).toBe(true)
    expect(summary.extraCpuMemLoadSmokePassed).toBe(true)
    expect(summary.directNetworkCount).toBeGreaterThanOrEqual(0)
    expect(summary.actualMetricsNetworkCount).toBeGreaterThanOrEqual(0)
  }, 15000)
})
