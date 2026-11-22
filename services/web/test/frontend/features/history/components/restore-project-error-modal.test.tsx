import { cleanup, render, screen } from '@testing-library/react'
import { expect } from 'chai'
import { RestoreProjectErrorModal } from '@/features/history/components/diff-view/modals/restore-project-error-modal'
import { FetchError } from '@/infrastructure/fetch-json'
import { SplitTestProvider } from '@/shared/context/split-test-context'

describe('the project restoration error dialog', function () {
  afterEach(cleanup)

  it('explains how to resolve a path conflict without showing response details', async function () {
    const rawMessage = 'Private diagnostic from the server'
    const showError = (status: number, code?: string) => (
      <SplitTestProvider>
        <RestoreProjectErrorModal
          error={
            new FetchError(
              rawMessage,
              '/project/test/revert-project',
              undefined,
              new Response(null, { status }),
              { code, message: rawMessage }
            )
          }
          resetErrorBoundary={() => {}}
        />
      </SplitTestProvider>
    )
    const guidance =
      'Some file or folder paths conflict with this version. Rename or move conflicting items in the current project, or choose a different version.'
    const conflictCode = 'project_restore_path_conflict'
    const { rerender } = render(showError(409, conflictCode))

    await screen.findByText(guidance)
    expect(screen.queryByText(rawMessage)).to.be.null

    for (const error of [
      showError(409),
      showError(409, 'unrelated_conflict'),
      showError(500, conflictCode),
    ]) {
      rerender(error)
      await screen.findByText(
        'There was a problem restoring the project. Please try again in a few moments. Contact us if the problem persists.'
      )
      expect(screen.queryByText(guidance)).to.be.null
      expect(screen.queryByText(rawMessage)).to.be.null
    }
  })
})
