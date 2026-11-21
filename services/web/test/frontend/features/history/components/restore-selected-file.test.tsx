import { act, cleanup, renderHook } from '@testing-library/react'
import { expect } from 'chai'
import fetchMock from 'fetch-mock'
import { ErrorBoundary } from 'react-error-boundary'
import { HistoryProvider } from '@/features/history/context/history-context'
import { useRestoreSelectedFile } from '@/features/history/context/hooks/use-restore-selected-file'
import type { HistoryContextValue } from '@/features/history/context/types/history-context-value'
import type { FileDiff } from '@/features/history/services/types/file'
import { EditorProviders, PROJECT_ID } from '../../../helpers/editor-providers'

describe('restoring a selected file from history', function () {
  afterEach(function () {
    cleanup()
    fetchMock.removeRoutes().clearHistory()
  })

  it('uses revision zero when it is the selected version', async function () {
    const endpoint = `/project/${PROJECT_ID}/revert_file`
    fetchMock.post(endpoint, { id: 'restored-doc', type: 'doc' })
    const { result } = renderHook(useRestoreSelectedFile, {
      wrapper: ({ children }) => (
        <ErrorBoundary fallback={<div>restore failed</div>}>
          <EditorProviders scope={{ editor: { sharejs_doc: null } }}>
            <HistoryProvider>{children}</HistoryProvider>
          </EditorProviders>
        </ErrorBoundary>
      ),
    })
    const file: FileDiff = { pathname: 'main.tex', operation: 'edited' }
    const selection: HistoryContextValue['selection'] = {
      comparing: true,
      updateRange: {
        fromV: 0,
        toV: 0,
        fromVTimestamp: 0,
        toVTimestamp: 2,
      },
      files: [file],
      selectedFile: file,
      previouslySelectedPathname: null,
    }

    await act(async () => result.current.restoreSelectedFile(selection))

    const calls = fetchMock.callHistory.calls(endpoint)
    expect(calls).to.have.lengthOf(1)
    expect(JSON.parse(String(calls[0].options.body))).to.deep.equal({
      pathname: file.pathname,
      version: 0,
    })
  })
})
