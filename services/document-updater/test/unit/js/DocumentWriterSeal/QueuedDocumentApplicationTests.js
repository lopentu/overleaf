const assert = require('node:assert/strict')
const {
  createDocumentReceiptCommands,
} = require('../../../../app/js/DocumentWriterSeal')
const keys = require('../../../../config/settings.defaults').redis
  .documentupdater.key_schema

const projectId = 'synthetic-project'
const docId = 'synthetic-doc'
const identity = { batchId: 'synthetic-batch', ordinal: 2 }
const update = {
  previousVersion: 27,
  version: 28,
  historyEntries: ['{"exact":"original payload"}'],
  lines: '["updated"]',
  hash: 'digest',
  ranges: '{}',
  timestamp: 123,
  author: 'author',
  maxOps: 100,
  opsTtl: 3600,
  documentOps: ['{"v":27}'],
}

describe('DocumentWriterSeal queue receipts', function () {
  it('uses only the document slot and preserves serialized history entries', async function () {
    const calls = []
    const receipt = {
      previousVersion: 27,
      version: 28,
      historyEntries: update.historyEntries,
    }
    const replies = [
      ['unrecorded'],
      ['applied', JSON.stringify(receipt)],
      ['replayed', JSON.stringify(receipt)],
      ['replayed', JSON.stringify(receipt)],
    ]
    const commands = createDocumentReceiptCommands(
      {
        async eval(script, keyCount, ...args) {
          calls.push({ keyCount, args })
          return replies.shift()
        },
      },
      keys
    )
    assert.equal(await commands.getReceipt(projectId, docId, identity), null)
    assert.deepEqual(await commands.apply(projectId, docId, identity, update), {
      status: 'applied',
      receipt,
    })
    assert.deepEqual(
      await commands.apply(projectId, docId, identity, {
        ...update,
        previousVersion: 28,
        version: 29,
        historyEntries: ['{"recomputed":"different payload"}'],
      }),
      { status: 'replayed', receipt }
    )
    assert.deepEqual(
      await commands.getReceipt(projectId, docId, identity),
      receipt
    )

    const receiptField = JSON.stringify([projectId, identity.batchId, 2])
    assert.equal(calls[0].args[calls[0].keyCount + 1], receiptField)
    const { keyCount, args } = calls[1]
    assert.equal(keyCount, 15)
    assert.ok(args.slice(0, keyCount).every(key => key.includes(`{${docId}}`)))
    assert.equal(args[keyCount - 1], `DocumentApplicationReceipts:{${docId}}`)
    assert.equal(args[keyCount + 11], receiptField)
    assert.equal(args[keyCount + 12], JSON.stringify(receipt))
  })

  it('rejects an invalid receipt reply and an out-of-range entry ordinal', async function () {
    const commands = createDocumentReceiptCommands(
      {
        async eval() {
          return ['replayed', '{"unrecognised":true}']
        },
      },
      keys
    )
    await assert.rejects(
      commands.getReceipt(projectId, docId, identity),
      /receipt/
    )
    await assert.rejects(
      commands.getReceipt(projectId, docId, { ...identity, ordinal: 8 }),
      /identity/
    )
  })
})
