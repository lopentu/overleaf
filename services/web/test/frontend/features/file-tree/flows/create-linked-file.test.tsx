import { expect } from 'chai'
import { act, cleanup, renderHook } from '@testing-library/react'
import fetchMock from 'fetch-mock'
import sinon from 'sinon'
import { EditorProviders } from '../../../helpers/editor-providers'
import { FileTreeMainProvider } from '@/features/file-tree/contexts/file-tree-main'
import { FileTreeSelectableProvider } from '@/features/file-tree/contexts/file-tree-selectable'
import {
  FileTreeActionableProvider,
  useFileTreeActionable,
} from '@/features/file-tree/contexts/file-tree-actionable'
import { ReferencesContext } from '@/features/ide-react/context/references-context'

describe('Creating a linked file', function () {
  afterEach(function () {
    cleanup()
    fetchMock.removeRoutes().clearHistory()
  })

  for (const name of ['references.bib', 'figure.pdf']) {
    it(`returns the created file ID for ${name}`, async function () {
      const indexAllReferences = sinon.stub().resolves()
      const response = { new_file_id: 'linked-file-id' }
      fetchMock.post('express:/project/:projectId/linked_file', response)
      const { result } = renderHook(useFileTreeActionable, {
        wrapper: ({ children }) => (
          <EditorProviders scope={{ editor: { sharejs_doc: null } }}>
            <ReferencesContext.Provider
              value={{
                referenceKeys: new Set(),
                indexAllReferences,
                searchLocalReferences: async () => ({ hits: [] }),
              }}
            >
              <FileTreeMainProvider
                refProviders={{}}
                setRefProviderEnabled={() => {}}
                setStartedFreeTrial={() => {}}
              >
                <FileTreeSelectableProvider onSelect={() => {}}>
                  <FileTreeActionableProvider>
                    {children}
                  </FileTreeActionableProvider>
                </FileTreeSelectableProvider>
              </FileTreeMainProvider>
            </ReferencesContext.Provider>
          </EditorProviders>
        ),
      })
      let created
      await act(async () => {
        created = await result.current.finishCreatingLinkedFile({
          name,
          provider: 'url',
          data: { url: 'https://example.com/source' },
        })
      })
      expect(created).to.deep.equal(response)
      expect(indexAllReferences.callCount).to.equal(
        name.endsWith('.bib') ? 1 : 0
      )
      if (name.endsWith('.bib')) {
        expect(indexAllReferences).to.have.been.calledWith(true)
      }
    })
  }
})
