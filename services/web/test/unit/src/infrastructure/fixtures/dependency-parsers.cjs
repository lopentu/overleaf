// @ts-check
const nodeAssert = require('node:assert/strict')
const {
  DOMImplementation: XmlDomImplementation,
  DOMParser: XmlDomParser,
  XMLSerializer: XmlDomSerializer,
} = require('@xmldom/xmldom')
const { z } = require('zod')

/** @param {Document} document */
function serializeWellFormed(document) {
  // The 0.8 LTS API takes options in argument FOUR, unlike 0.9 examples.
  return new XmlDomSerializer().serializeToString(document, false, undefined, {
    requireWellFormed: true,
  })
}

/** @returns {Document} */
function documentWithRoot() {
  return new XmlDomImplementation().createDocument(null, 'root', null)
}

/** @param {() => void} serialize */
function rejectsInvalidState(serialize) {
  nodeAssert.throws(serialize, (/** @type {unknown} */ error) => {
    return error instanceof Error && 'code' in error && error.code === 11
  })
}

/** @type {Record<string, () => void | Promise<void>>} */
const scenarios = {
  'xml-element-name': () => {
    const doc = documentWithRoot()
    doc.documentElement.appendChild(doc.createElement('node injected="yes"'))
    rejectsInvalidState(() => {
      serializeWellFormed(doc)
    })
  },
  'xml-attribute-name': () => {
    const doc = documentWithRoot()
    doc.documentElement.setAttribute('safe="yes" injected', 'value')
    rejectsInvalidState(() => {
      serializeWellFormed(doc)
    })
  },
  'xml-processing-instruction-target': () => {
    const doc = documentWithRoot()
    doc.documentElement.appendChild(
      doc.createProcessingInstruction('target>', 'data')
    )
    rejectsInvalidState(() => {
      serializeWellFormed(doc)
    })
  },
  'xml-doctype-name': () => {
    const implementation = new XmlDomImplementation()
    const type = implementation.createDocumentType('root><injected', '', '')
    const doc = implementation.createDocument(null, 'root', type)
    rejectsInvalidState(() => {
      serializeWellFormed(doc)
    })
  },
  'xml-valid-namespaced-unicode': () => {
    const xml =
      '<samlp:Response xmlns:samlp="urn:fixture:protocol" xmlns:saml="urn:fixture:assertion" ID="fixture-1"><saml:NameID>論文 &amp; café</saml:NameID></samlp:Response>'
    const doc = new XmlDomParser().parseFromString(xml, 'text/xml')
    nodeAssert.equal(serializeWellFormed(doc), xml)
    nodeAssert.equal(
      doc.getElementsByTagNameNS('urn:fixture:assertion', 'NameID').item(0)
        ?.textContent,
      '論文 & café'
    )
  },
  'xml-namespace-memory-budget': () => {
    const depth = 3000
    const opens = Array.from(
      { length: depth },
      (_, index) => `<a xmlns:p${index}="urn:${index}">`
    ).join('')
    const doc = new XmlDomParser().parseFromString(
      `<r>${opens}${'</a>'.repeat(depth)}</r>`,
      'text/xml'
    )
    nodeAssert.equal(doc.getElementsByTagName('a').length, depth)
    nodeAssert.equal(
      doc
        .getElementsByTagName('a')
        .item(depth - 1)
        ?.lookupNamespaceURI(`p${depth - 1}`),
      `urn:${depth - 1}`
    )
  },
  'xml-many-attributes-budget': () => {
    const count = 40000
    const attributes = Array.from(
      { length: count },
      (_, index) => `a${index}="${index}"`
    ).join(' ')
    const doc = new XmlDomParser().parseFromString(
      `<r ${attributes}/>`,
      'text/xml'
    )
    nodeAssert.equal(doc.documentElement.attributes.length, count)
    nodeAssert.equal(doc.documentElement.getAttribute('a39999'), '39999')
  },
  'xml-malformed-end-tag-budget': () => {
    const parser = new XmlDomParser({
      errorHandler: { warning() {}, error() {}, fatalError() {} },
    })
    const doc = parser.parseFromString(
      `<r></${' '.repeat(256 * 1024)}x>`,
      'text/xml'
    )
    nodeAssert.equal(doc.documentElement.tagName, 'r')
  },
  'xml-malformed-recovery-budget': () => {
    const parser = new XmlDomParser({
      errorHandler: { warning() {}, error() {}, fatalError() {} },
    })
    const doc = parser.parseFromString(
      `<r>${'<'.repeat(32000)}></r>`,
      'text/xml'
    )
    nodeAssert.equal(doc.documentElement.textContent, `${'<'.repeat(32000)}>`)
  },
  'zod-oversized-invalid-array': () => {
    const result = z.array(z.string()).max(4).safeParse(Array(10000).fill(null))
    nodeAssert.equal(result.success, false)
    if (result.success) throw new Error('Oversized invalid array accepted')
    nodeAssert.deepEqual(
      result.error.issues.map(issue => issue.code),
      ['too_big']
    )
    nodeAssert.deepEqual(result.error.issues[0]?.path, [])
  },
  'zod-oversized-array-skips-elements': () => {
    let parsed = 0
    const schema = z
      .array(
        z.string().transform(value => {
          parsed++
          return value
        })
      )
      .max(4)
    nodeAssert.equal(
      schema.safeParse(Array(10000).fill('fixture')).success,
      false
    )
    nodeAssert.equal(parsed, 0)
  },
  'zod-oversized-set-skips-elements': () => {
    let parsed = 0
    const schema = z
      .set(
        z.string().transform(value => {
          parsed++
          return value
        })
      )
      .max(4)
    const input = new Set(
      Array.from({ length: 10000 }, (_, index) => `fixture-${index}`)
    )
    nodeAssert.equal(schema.safeParse(input).success, false)
    nodeAssert.equal(parsed, 0)
  },
  'zod-valid-boundaries-and-errors': () => {
    const schema = z.array(z.string()).max(4)
    nodeAssert.deepEqual(schema.parse(['a', 'b', 'c', 'd']), [
      'a',
      'b',
      'c',
      'd',
    ])
    const invalid = schema.safeParse(['a', null])
    nodeAssert.equal(invalid.success, false)
    if (invalid.success) throw new Error('Invalid element accepted')
    nodeAssert.equal(invalid.error.issues[0]?.code, 'invalid_type')
    nodeAssert.deepEqual(invalid.error.issues[0]?.path, [1])
  },
}

const scenario = process.argv[2]
nodeAssert.ok(scenario, 'Missing scenario')
const runScenario = scenarios[scenario]
nodeAssert.ok(runScenario, 'Unknown scenario')
Promise.resolve()
  .then(runScenario)
  .then(() => {
    console.log('PASS')
  })
  .catch((/** @type {unknown} */ error) => {
    console.error(error)
    process.exitCode = 1
  })
