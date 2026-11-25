import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { expect } from 'chai'
import fetchMock from 'fetch-mock'
import { ErrorBoundary } from 'react-error-boundary'
import Toolbar from '@/features/history/components/diff-view/toolbar/toolbar'
import { HistoryProvider } from '@/features/history/context/history-context'
import type { HistoryContextValue } from '@/features/history/context/types/history-context-value'
import type { FileRemoved } from '@/features/history/services/types/file'
import { SplitTestContext } from '@/shared/context/split-test-context'
import { EditorProviders, PROJECT_ID } from '../../../helpers/editor-providers'

describe('recovering a deleted file from history', function () {
  afterEach(function () {
    cleanup()
    fetchMock.removeRoutes().clearHistory()
  })

  const cases = [
    {
      name: 'uses add-only recovery for a renamed file in an older view',
      isCurrentVersion: false,
      newPathname: 'chapters/renamed.tex',
      deletedAtV: 1,
    },
    {
      name: 'uses the historical name of a renamed file in the current view',
      isCurrentVersion: true,
      newPathname: 'chapters/renamed.tex',
      deletedAtV: 1,
    },
    {
      name: 'uses the original name when the last available revision is zero',
      isCurrentVersion: false,
      deletedAtV: 0,
    },
  ]

  for (const { name, isCurrentVersion, newPathname, deletedAtV } of cases) {
    it(name, async function () {
      const endpoint = `/project/${PROJECT_ID}/restore_file`
      fetchMock.post(endpoint, { id: 'restored-doc', type: 'doc' })
      const file: FileRemoved = {
        pathname: 'chapters/initial.tex',
        newPathname,
        operation: 'removed',
        deletedAtV,
        editable: true,
      }
      const selection: HistoryContextValue['selection'] = {
        comparing: true,
        updateRange: {
          fromV: 0,
          toV: 2,
          fromVTimestamp: 1710000000000,
          toVTimestamp: 1710000001000,
        },
        files: [file],
        selectedFile: file,
        previouslySelectedPathname: null,
      }

      render(
        <ErrorBoundary fallback={<div>restore failed</div>}>
          <EditorProviders scope={{ editor: { sharejs_doc: null } }}>
            <SplitTestContext.Provider
              value={{
                splitTestVariants: { 'revert-file': 'enabled' },
                splitTestInfo: {},
              }}
            >
              <HistoryProvider>
                <Toolbar
                  diff={null}
                  selection={selection}
                  isCurrentVersion={isCurrentVersion}
                />
              </HistoryProvider>
            </SplitTestContext.Provider>
          </EditorProviders>
        </ErrorBoundary>
      )

      fireEvent.click(screen.getByRole('button', { name: 'Restore file' }))
      await waitFor(() =>
        expect(fetchMock.callHistory.calls(endpoint)).to.have.lengthOf(1)
      )
      const [call] = fetchMock.callHistory.calls(endpoint)
      expect(JSON.parse(String(call.options.body))).to.deep.equal({
        pathname: newPathname ?? file.pathname,
        version: deletedAtV,
      })
    })
  }
})
