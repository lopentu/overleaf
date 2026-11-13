import { createElement, type ReactNode } from 'react'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { expect } from 'chai'
import sinon from 'sinon'
import {
  ProjectListProvider,
  useProjectListContext,
} from '../../../../../modules/admin-tools/frontend/js/project-list/context/project-list-context'
import { UserIdentityProvider } from '../../../../../modules/admin-tools/frontend/js/user-list/context/user-identity-context'
import type { GetProjectsResponseBody } from '../../../../../modules/admin-tools/types/project/api'

const projects: GetProjectsResponseBody = {
  totalSize: 1,
  projects: [
    {
      id: 'project-a',
      name: 'Project A',
      owner: 'owner-a',
      lastUpdated: '2026-01-01T00:00:00.000Z',
      lastUpdatedBy: null,
      deleted: false,
      trashed: false,
    },
  ],
}

function renderProjectList(projectsOwnerId: string | null) {
  return renderHook(useProjectListContext, {
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(UserIdentityProvider, {
        users: [],
        children: createElement(ProjectListProvider, {
          projectsOwnerId,
          children,
        }),
      }),
  })
}

describe('admin project list data loading', function () {
  beforeEach(function () {
    window.metaAttributesCache.delete('ol-prefetchedProjectsBlob')
    localStorage.clear()
  })

  afterEach(function () {
    cleanup()
    sinon.restore()
    window.metaAttributesCache.delete('ol-prefetchedProjectsBlob')
  })

  it('recovers the all-project view when prefetch data is missing', async function () {
    const fetch = sinon.stub(globalThis, 'fetch').resolves(
      new Response(JSON.stringify(projects), {
        headers: { 'Content-Type': 'application/json' },
      })
    )
    const { result } = renderProjectList(null)

    await waitFor(() => expect(result.current.isLoading).to.equal(false))
    expect(result.current.visibleProjects).to.deep.equal(projects.projects)
    expect(result.current.totalProjectsCount).to.equal(1)
    expect(result.current.loadProgress).to.equal(100)
    expect(fetch.firstCall.args[0]).to.equal('/admin/projects')
  })

  for (const blob of [projects, { totalSize: 0, projects: [] }]) {
    it(`uses the prefetched list with ${blob.totalSize} projects without a request`, function () {
      window.metaAttributesCache.set('ol-prefetchedProjectsBlob', blob)
      const fetch = sinon.stub(globalThis, 'fetch')
      const { result } = renderProjectList(null)

      expect(result.current.visibleProjects).to.deep.equal(blob.projects)
      expect(result.current.totalProjectsCount).to.equal(blob.totalSize)
      expect(result.current.isLoading).to.equal(false)
      expect(fetch).not.to.have.been.called
    })
  }

  it('loads the owner list even if all-project prefetch data is available', async function () {
    window.metaAttributesCache.set('ol-prefetchedProjectsBlob', projects)
    const fetch = sinon.stub(globalThis, 'fetch').resolves(
      new Response(JSON.stringify({ totalSize: 0, projects: [] }), {
        headers: { 'Content-Type': 'application/json' },
      })
    )
    const { result } = renderProjectList('owner-a')

    await waitFor(() => expect(result.current.isLoading).to.equal(false))
    expect(result.current.visibleProjects).to.deep.equal([])
    expect(result.current.totalProjectsCount).to.equal(0)
    expect(fetch.firstCall.args[0]).to.equal('/admin/user/owner-a/projects')
  })
})
