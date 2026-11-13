import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const artifactRoot = fileURLToPath(new URL('../../../', import.meta.url))
describe('pinned native Node runtime contract', () => {
  it('imports the actual adapter under Node24 strip-only mode without a TypeScript transform', () => {
    const result = spawnSync(
      process.execPath,
      ['scripts/check-ephemeral-job-native.mjs'],
      {
        cwd: artifactRoot,
        encoding: 'utf8',
        timeout: 5000,
      }
    )
    expect(result.error, result.stderr).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe(
      'Node24.18.1 strip-only native import PASS'
    )
  })
  it('passes the standard TeX symlink search path into an actual child environment', () => {
    const moduleUrl = new URL('../../../app/js/JobRequest.ts', import.meta.url)
      .href
    const script = `import { compileEnvironment } from ${JSON.stringify(moduleUrl)};
      import { execFileSync } from 'node:child_process';
      const env = Object.fromEntries(compileEnvironment({environment: {SOURCE_DATE_EPOCH:'0'}}).map(entry => {const at=entry.indexOf('=');return [entry.slice(0,at),entry.slice(at+1)];}));
      process.stdout.write(execFileSync(process.execPath, ['-e', 'process.stdout.write(process.env.PATH)'], {env}));`
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', script],
      { cwd: artifactRoot, encoding: 'utf8', timeout: 5000 }
    )
    expect(result.error, result.stderr).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('/usr/local/bin:/usr/bin:/bin')
  })
})
