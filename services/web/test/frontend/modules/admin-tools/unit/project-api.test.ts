import { expect } from 'chai'
import type {} from 'chai-as-promised'
import sinon from 'sinon'
import {
  getProjects,
  trashProjectForUser,
  untrashProjectForUser,
  undeleteProject,
} from '../../../../../modules/admin-tools/frontend/js/project-list/util/api'

describe('admin project owner actions', function () {
  afterEach(function () {
    sinon.restore()
  })

  for (const action of [
    trashProjectForUser,
    untrashProjectForUser,
    undeleteProject,
  ]) {
    it(`${action.name} rejects a missing owner without sending a request`, async function () {
      const fetch = sinon
        .stub(globalThis, 'fetch')
        .resolves(new Response(null, { status: 200 }))
      await expect(action('project-id', undefined)).to.be.rejectedWith(
        'Project owner is unavailable'
      )
      expect(fetch).not.to.have.been.called
    })
  }
})

describe('admin project listing', function () {
  afterEach(function () {
    sinon.restore()
  })

  for (const { userId, path } of [
    { userId: null, path: '/admin/projects' },
    { userId: 'owner-id', path: '/admin/user/owner-id/projects' },
  ]) {
    it(`loads projects from ${path}`, async function () {
      const projects = { totalSize: 0, projects: [] }
      const fetch = sinon.stub(globalThis, 'fetch').resolves(
        new Response(JSON.stringify(projects), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )

      expect(
        await getProjects({ userId, by: 'lastUpdated', order: 'desc' })
      ).to.deep.equal(projects)
      expect(fetch).to.have.been.calledOnce
      expect(fetch.firstCall.args[0]).to.equal(path)
      expect(fetch.firstCall.args[1]?.method).to.equal('POST')
      expect(JSON.parse(String(fetch.firstCall.args[1]?.body))).to.deep.equal({
        sort: { by: 'lastUpdated', order: 'desc' },
      })
    })
  }
})
