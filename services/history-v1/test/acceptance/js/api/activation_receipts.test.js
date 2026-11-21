'use strict'

const { randomUUID } = require('node:crypto')
const { expect } = require('chai')
const { ObjectId } = require('mongodb')
const fetch = require('node-fetch')
const { Change, File, Operation } = require('overleaf-editor-core')
const queueChanges = require('../../../../storage/lib/queue_changes')
const cleanup = require('../storage/support/cleanup')
const testProjects = require('./support/test_projects')
const testServer = require('./support/test_server')

describe('history activation receipts', function () {
  beforeEach(cleanup.everything)

  beforeEach(function () {
    this.historyId = new ObjectId().toString()
    this.publication = {
      historyId: this.historyId,
      batchId: randomUUID(),
      ordinal: 0,
      entryOrdinal: 0,
      digest: 'ab'.repeat(32),
    }
    this.lookup = (publication, authorization) => {
      const headers = { 'content-type': 'application/json' }
      if (authorization) headers.Authorization = authorization
      return fetch(
        testServer.url(
          `/api/projects/${this.historyId}/activation-receipts/lookup`
        ),
        { method: 'POST', body: JSON.stringify(publication), headers }
      )
    }
  })

  it('requires service credentials and matching Mongo history scope', async function () {
    const jwt = testServer.createTokenForProject(this.historyId)
    expect((await this.lookup(this.publication)).status).to.equal(401)
    expect(
      (await this.lookup(this.publication, `Bearer ${jwt}`)).status
    ).to.equal(401)
    const wrongProject = {
      ...this.publication,
      historyId: new ObjectId().toString(),
    }
    expect(
      (await this.lookup(wrongProject, testServer.basicAuthHeader)).status
    ).to.equal(400)
  })

  it('distinguishes a buffered change from durable activation and a conflicting replay', async function () {
    await testProjects.createEmptyProject(this.historyId)
    const change = new Change(
      [Operation.addFile('main.tex', File.fromHash(File.EMPTY_FILE_HASH))],
      new Date()
    )
    change.setHistoryPublication(this.publication)
    await queueChanges(this.historyId, [change], 0)

    const buffered = await this.lookup(
      this.publication,
      testServer.basicAuthHeader
    )
    expect(buffered.status).to.equal(200)
    expect(buffered.headers.get('cache-control')).to.equal('no-store')
    expect(await buffered.json()).to.deep.equal({ status: 'pending' })

    await testServer.basicAuthClient.apis.ProjectImport.flushChanges({
      project_id: this.historyId,
    })

    const committed = await this.lookup(
      this.publication,
      testServer.basicAuthHeader
    )
    expect(committed.status).to.equal(200)
    expect(await committed.json()).to.deep.equal({
      status: 'committed',
      historyVersion: 1,
    })

    const conflict = await this.lookup(
      { ...this.publication, digest: 'cd'.repeat(32) },
      testServer.basicAuthHeader
    )
    expect(conflict.status).to.equal(200)
    expect(await conflict.json()).to.deep.equal({ status: 'conflict' })
  })
})
