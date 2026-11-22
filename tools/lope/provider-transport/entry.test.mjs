// @ts-check
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

import { launchProbe } from './entry.mjs'

const invocation = {
  argv: ['/usr/bin/node', '/overleaf/services/web/entry.mjs', 'outage'],
  execArgv: [],
  execPath: '/usr/bin/node',
  cwd: '/overleaf/services/web',
  env: {},
}

const receipt = {
  schema: 3,
  scope: 'credential-free-provider-CONNECT-TLS-only',
  mode: 'outage',
  passed: true,
  provider_feature_qualified: false,
  production_changed: false,
  cases: [
    'github-root',
    'github-api',
    'github-code',
    'zotero-root',
    'zotero-api',
  ].map(name => ({
    case: name,
    expectation: 'outage',
    passed: true,
    code: 'proxy-unavailable',
    http_status: 0,
    tls_authorized: false,
    tls_expected_host: false,
    tls_protocol: '',
    proxy_connection_attempts: 1,
    direct_connection_attempts: 0,
    unknown_connection_attempts: 0,
    sockets_closed: true,
    duration_ms: 50,
  })),
}

/** @param {string} text */
function child(text, status = 0) {
  return {
    status,
    signal: null,
    output: [null, null, null, Buffer.from(text + '\n')],
  }
}

test('invalid variants and any inherited environment are refused before a worker starts', () => {
  for (const state of [
    { argv: [...invocation.argv, '/tmp/should-not-escape'] },
    { argv: [...invocation.argv.slice(0, 2), 'untrusted'] },
    { cwd: '/tmp' },
    { execArgv: ['--require', '/tmp/preload.js'] },
    ...[
      'DEBUG',
      'NODE_DEBUG',
      'NODE_DEBUG_NATIVE',
      'NODE_OPTIONS',
      'NODE_EXTRA_CA_CERTS',
      'SSL_CERT_FILE',
    ].map(name => ({
      env: { [name]: 'marker' },
    })),
  ]) {
    assert.deepEqual(
      launchProbe({ ...invocation, ...state }, () => {
        assert.fail('unsealed worker invoked')
      }),
      { passed: false, code: 'probe-launch-refused' }
    )
  }
})

test('worker diagnostics cannot reach stdout, child environment is empty, and only fd3 is admitted', () => {
  const actual = launchProbe(invocation, (binary, args, options) => {
    assert.equal(binary, invocation.execPath)
    assert.deepEqual(args.slice(0, 5), [
      '--require',
      '/overleaf/.pnp.cjs',
      '--import',
      '/overleaf/.pnp.register.mjs',
      '--input-type=module',
    ])
    assert.equal(args.at(-1), 'outage')
    assert.deepEqual(options.env, {})
    assert.deepEqual(options.stdio, ['ignore', 'ignore', 'ignore', 'pipe'])
    assert.equal(options.cwd, invocation.cwd)
    assert.equal(options.timeout, 65_000)
    const fixture = spawnSync(
      process.execPath,
      [
        '-e',
        `
      process.stdout.write('/private/standard-out\u005cn')
      process.stderr.write('/private/startup-diagnostic\u005cn')
      require('node:fs').writeSync(3, ${JSON.stringify(JSON.stringify(receipt) + '\n')})
    `,
      ],
      { ...options, cwd: process.cwd() }
    )
    assert.equal(fixture.output[1], null)
    assert.equal(fixture.output[2], null)
    return fixture
  })
  assert.deepEqual(actual, receipt)
})

test('extra JSON, oversized or path-bearing values, and inconsistent process status are discarded', () => {
  const invalid = [
    child(JSON.stringify(receipt) + '\n' + JSON.stringify(receipt)),
    child('x'.repeat(8200)),
    child(JSON.stringify({ ...receipt, private: '/private/startup' })),
    child(
      JSON.stringify({
        ...receipt,
        cases: [{ ...receipt.cases[0], code: '/private/socket' }],
      })
    ),
    child(JSON.stringify(receipt), 1),
    child(
      JSON.stringify({
        ...receipt,
        cases: [
          { ...receipt.cases[0], tls_authorized: true },
          ...receipt.cases.slice(1),
        ],
      })
    ),
  ]
  for (const output of invalid) {
    const result = launchProbe(invocation, () => output)
    assert.equal(result.passed, false)
    assert.ok('code' in result)
    assert.equal(result.code, 'probe-worker-receipt-refused')
    assert.doesNotMatch(JSON.stringify(result), /\/private\//)
  }
})
