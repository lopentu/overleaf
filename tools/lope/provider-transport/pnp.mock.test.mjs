// @ts-check
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { launchProbe } from './entry.mjs'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const workdir = resolve(root, 'services/web')
const probe = new URL('./probe.mjs', import.meta.url).href
const result = launchProbe(
  {
    argv: [process.execPath, '/overleaf/services/web/entry.mjs', 'outage'],
    execArgv: [],
    execPath: process.execPath,
    cwd: '/overleaf/services/web',
    env: {},
  },
  (execPath, args, options) => {
    const actual = [...args]
    actual[1] = resolve(root, '.pnp.cjs')
    actual[3] = resolve(root, '.pnp.register.mjs')
    actual[6] = `
    import net from 'node:net';
    const { endpoint } = await import(${JSON.stringify(probe)});
    console.log('/private/startup-stdout');
    console.error('/private/startup-stderr');
    net.Socket.prototype.connect = function (...args) {
      const target = endpoint(args);
      const proxy = Array.isArray(args[0]) && target?.host === '192.168.224.5' && target.port === 3128;
      // Nothing in this test may invoke the original socket operation.
      throw Object.assign(new Error('offline connect double'), {
        code: proxy ? 'ECONNREFUSED' : 'ERR_INVALID_ARG_TYPE'
      });
    };
    ${actual[6].replace("import('./probe.mjs')", 'import(' + JSON.stringify(probe) + ')')}
  `
    return spawnSync(execPath, actual, { ...options, cwd: workdir })
  }
)
assert.equal(result.passed, true)
assert.ok('cases' in result)
assert.equal(result.cases.length, 5)
assert.ok(
  result.cases.every(
    row =>
      row.proxy_connection_attempts === 1 &&
      row.code === 'proxy-unavailable' &&
      row.sockets_closed
  )
)
console.log(
  'Actual Web PnP and exact proxy agent passed with offline native-connect doubles'
)
