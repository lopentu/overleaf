// @ts-check
import assert from 'node:assert/strict'
import { it as test } from 'vitest'
import sanitizeHtml from 'sanitize-html'
import qs from 'qs'

const schemeMarker = 'javascript:__triage_inert_marker__'
const svgInput = `<svg><a id="triage">link</a><animate href="#triage" attributeName="href" values="#safe;${schemeMarker}" /></svg>`
const metaInput = `<meta http-equiv="refresh" content="0;url=${schemeMarker}">`

test('advisory SMIL URI-list policy rejects a later disallowed scheme under explicit nondefault SVG policy', () => {
  /** @type {import('sanitize-html').IOptions} */
  const options = {
    allowedTags: ['svg', 'a', 'animate'],
    allowedAttributes: {
      a: ['id', 'href'],
      animate: ['href', 'attributeName', 'values'],
    },
    parser: { lowerCaseAttributeNames: false },
  }
  assert.doesNotMatch(sanitizeHtml(svgInput, options), /javascript:/i)
})

test('advisory nonTextTags implied close keeps the entire explicitly discarded noscript region inert', () => {
  const output = sanitizeHtml(
    '<div><noscript></div><b>triage-marker</b></noscript>',
    {
      allowedTags: ['div', 'b'],
      nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript'],
    }
  )
  assert.doesNotMatch(output, /triage-marker|<b>/)
})

test('advisory refresh policy rejects disallowed scheme only when meta is explicitly enabled', () => {
  const output = sanitizeHtml(metaInput, {
    allowedTags: ['meta'],
    allowedAttributes: { meta: ['http-equiv', 'content'] },
  })
  assert.doesNotMatch(output, /javascript:/i)
})

test('advisory qs bracket comma arrays enforce a finite limit on four benign values', () => {
  assert.throws(
    () =>
      qs.parse('a[]=1,2,3,4', {
        comma: true,
        arrayLimit: 3,
        throwOnLimitExceeded: true,
      }),
    RangeError
  )
})

test('advisory qs own constructor.isBuffer round trip never invokes a non-callable value', () => {
  const input = qs.parse('a[constructor][isBuffer]=x', {
    allowPrototypes: true,
  })
  assert.doesNotThrow(() => qs.stringify(input))
  assert.equal(qs.stringify(input), 'a%5Bconstructor%5D%5BisBuffer%5D=x')
})

for (const encodeValuesOnly of [false, true]) {
  test(`advisory qs comma serialization handles non-callable own toString, encodeValuesOnly=${encodeValuesOnly}`, () => {
    const input = { a: [{ toString: 'inert-marker' }] }
    /** @type {string | undefined} */
    let output
    assert.doesNotThrow(() => {
      output = qs.stringify(input, { arrayFormat: 'comma', encodeValuesOnly })
    })
    assert.equal(typeof output, 'string')
  })
}

test('qs normal nested/array/Unicode round trip and comma opt-in remain compatible', () => {
  const input = {
    text: '你好',
    items: ['one', 'two'],
    nested: { enabled: 'yes' },
  }
  assert.deepEqual(qs.parse(qs.stringify(input)), input)
  assert.deepEqual(qs.parse('a=one,two'), { a: 'one,two' })
  assert.deepEqual(qs.parse('a=one,two', { comma: true }), {
    a: ['one', 'two'],
  })
  assert.equal(
    qs.stringify({ a: ['one', 'two'] }, { arrayFormat: 'comma' }),
    'a=one%2Ctwo'
  )
})

test('qs default parse drops prototype keys without modifying Object.prototype', () => {
  assert.equal(Object.hasOwn(Object.prototype, 'triageSentinel'), false)
  const output = qs.parse(
    '__proto__[triageSentinel]=x&constructor[prototype][triageSentinel]=x&safe=value'
  )
  assert.deepEqual(output, { safe: 'value' })
  assert.equal(Object.hasOwn(Object.prototype, 'triageSentinel'), false)
})
