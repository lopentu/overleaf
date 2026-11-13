import { expect } from 'chai'
import {
  cleanup,
  render,
  screen,
  waitFor,
  fireEvent,
} from '@testing-library/react'
import fetchMock from 'fetch-mock'
import sinon from 'sinon'
import { ErrorBoundary } from 'react-error-boundary'
import { t } from 'i18next'
import GitSyncExportModal from '../../frontend/js/components/modals/git-sync-export-modal'
import GitSyncMergeOverviewModal from '../../frontend/js/components/modals/git-sync-merge-overview-modal'

const projectSyncState = {
  mergeStatus: 'clean' as const,
  repoFullName: 'owner/repo',
  unmergedBranchName: null,
}

describe('GitHub sync modal response handling', function () {
  afterEach(function () {
    cleanup()
    fetchMock.removeRoutes().clearHistory()
    sinon.restore()
  })

  it('shows a translated export error', async function () {
    fetchMock.get('/user/github-sync/orgs', { user: 'owner', orgs: [] })
    fetchMock.post('/project/project-id/github-sync/export', {
      status: 500,
      body: { key: 'something_went_wrong_server' },
    })
    sinon.stub(console, 'error')
    render(
      <ErrorBoundary fallback={<p>Export render failed</p>}>
        <GitSyncExportModal
          projectId="project-id"
          projectName="repo"
          handleHide={() => {}}
          setModalStatus={() => {}}
        />
      </ErrorBoundary>
    )
    await screen.findByRole('option', { name: 'owner' })
    fireEvent.click(
      screen.getByRole('button', { name: t('create_project_in_github') })
    )
    await waitFor(() => {
      expect(screen.queryByText('Export render failed')).to.equal(null)
      expect(screen.queryByText(t('something_went_wrong_server'))).not.to.equal(
        null
      )
    })
  })

  it('returns to loading when the merge overview has no project response', async function () {
    fetchMock.get('/project/project-id/github-sync/merge/overview', {
      body: 'null',
      headers: { 'Content-Type': 'application/json' },
    })
    const setModalStatus = sinon.spy()
    sinon.stub(console, 'error')
    render(
      <ErrorBoundary fallback={<p>Overview render failed</p>}>
        <GitSyncMergeOverviewModal
          projectId="project-id"
          projectSyncState={projectSyncState}
          handleHide={() => {}}
          setModalStatus={setModalStatus}
          commitMessage=""
          setCommitMessage={() => {}}
        />
      </ErrorBoundary>
    )
    await waitFor(() =>
      expect(setModalStatus).to.have.been.calledWith('loading')
    )
    expect(screen.queryByText('Overview render failed')).to.equal(null)
  })
})
