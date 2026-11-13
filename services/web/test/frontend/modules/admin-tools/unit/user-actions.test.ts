import { expect } from 'chai'
import sinon from 'sinon'
import {
  performRestoreUser,
  performPurgeUser,
  performSendRegEmail,
  performUpdateUser,
} from '../../../../../modules/admin-tools/frontend/js/user-list/util/user-actions'
import type { User } from '../../../../../modules/admin-tools/types/user/api'

const user: User = {
  id: 'user-id',
  email: 'user@example.com',
  firstName: 'Test',
  lastName: 'User',
  isAdmin: false,
  loginCount: 0,
  signUpDate: '2026-01-01T00:00:00.000Z',
  authMethods: ['local'],
  allowUpdateDetails: false,
  allowUpdateIsAdmin: false,
  suspended: false,
  inactive: false,
}

describe('admin user action callbacks', function () {
  afterEach(function () {
    sinon.restore()
  })

  for (const action of [
    performRestoreUser,
    performPurgeUser,
    performSendRegEmail,
  ]) {
    it(`${action.name} tolerates omitted view callbacks`, async function () {
      const fetch = sinon
        .stub(globalThis, 'fetch')
        .resolves(new Response(null, { status: 200 }))
      await action(user, {})
      expect(fetch).to.have.been.calledOnce
    })
  }

  it('does not submit protected account fields and leaves caller data intact', async function () {
    const fetch = sinon
      .stub(globalThis, 'fetch')
      .resolves(new Response(null, { status: 200 }))
    const userData = {
      firstName: 'Changed',
      lastName: 'Changed',
      isAdmin: true,
      suspended: true,
    }
    await performUpdateUser(user, {}, { userData })
    expect(JSON.parse(String(fetch.firstCall.args[1]?.body))).to.deep.equal({
      suspended: true,
    })
    expect(userData).to.deep.equal({
      firstName: 'Changed',
      lastName: 'Changed',
      isAdmin: true,
      suspended: true,
    })
  })
})
