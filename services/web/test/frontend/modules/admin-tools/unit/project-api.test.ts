import { expect } from 'chai'
import type {} from 'chai-as-promised'
import sinon from 'sinon'
import {
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
