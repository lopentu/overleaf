import { act, cleanup, renderHook } from '@testing-library/react'
import { expect } from 'chai'
import fetchMock from 'fetch-mock'
import sinon from 'sinon'
import { useEditorManagerContext } from '@/features/ide-react/context/editor-manager-context'
import { DocumentContainer } from '@/features/ide-react/editor/document-container'
import DocumentCompiler from '@/features/pdf-preview/util/compiler'
import customLocalStorage from '@/infrastructure/local-storage'
import getMeta from '@/utils/meta'
import { EditorProviders, PROJECT_ID } from '../../../helpers/editor-providers'

const ROOT_ID = 'root-doc'
const SAVED_ID = 'saved-doc'
const DEEP_LINKED_ID = 'deep-linked-doc'
const STALE_ID = 'replaced-doc'
const STORAGE_KEY = `doc.open_id.${PROJECT_ID}`

describe('choosing the initial editor document', function () {
  let exposedSettings: ReturnType<typeof getMeta<'ol-ExposedSettings'>>

  beforeEach(function () {
    exposedSettings = getMeta('ol-ExposedSettings')
    window.metaAttributesCache.set('ol-ExposedSettings', {
      ...exposedSettings,
      validRootDocExtensions: ['tex'],
    })
    sinon.stub(DocumentCompiler.prototype, 'compile').resolves()
    sinon.stub(DocumentContainer.prototype, 'join').callsFake(callback => {
      callback?.()
    })
  })

  afterEach(function () {
    cleanup()
    fetchMock.removeRoutes().clearHistory()
    sinon.restore()
    customLocalStorage.removeItem(STORAGE_KEY)
    window.metaAttributesCache.set('ol-ExposedSettings', exposedSettings)
    window.history.replaceState(null, '', '/')
  })

  async function openInitialDocument(fallbackId?: string) {
    const { result } = renderHook(useEditorManagerContext, {
      wrapper: ({ children }) => (
        <EditorProviders
          rootDocId={ROOT_ID}
          rootFolder={[
            {
              _id: 'root-folder',
              name: 'rootFolder',
              docs: [
                { _id: ROOT_ID, name: 'main.tex' },
                { _id: SAVED_ID, name: 'saved.tex' },
                { _id: DEEP_LINKED_ID, name: 'linked.tex' },
              ],
              folders: [],
              fileRefs: [],
            },
          ]}
          scope={{ editor: { sharejs_doc: null } }}
        >
          {children}
        </EditorProviders>
      ),
    })

    let openedId: string | undefined
    await act(async () => {
      openedId = (await result.current.openInitialDoc(fallbackId))?._id
    })
    return openedId
  }

  it('uses a valid deep link before the saved document and project root', async function () {
    window.history.replaceState(null, '', `/?doc=${DEEP_LINKED_ID}`)
    customLocalStorage.setItem(STORAGE_KEY, SAVED_ID)
    expect(await openInitialDocument(ROOT_ID)).to.equal(DEEP_LINKED_ID)
  })

  it('uses the saved document when the deep-link document is missing', async function () {
    window.history.replaceState(null, '', `/?doc=${STALE_ID}`)
    customLocalStorage.setItem(STORAGE_KEY, SAVED_ID)
    expect(await openInitialDocument(ROOT_ID)).to.equal(SAVED_ID)
  })

  it('opens the project root when restore replaced the saved document ID', async function () {
    customLocalStorage.setItem(STORAGE_KEY, STALE_ID)
    expect(await openInitialDocument(ROOT_ID)).to.equal(ROOT_ID)
    expect(customLocalStorage.getItem(STORAGE_KEY)).to.equal(ROOT_ID)
  })

  it('leaves the editor without an open document when no root is supplied', async function () {
    customLocalStorage.setItem(STORAGE_KEY, STALE_ID)
    expect(await openInitialDocument()).to.equal(undefined)
  })

  it('leaves the editor without an open document when the root ID is missing', async function () {
    customLocalStorage.setItem(STORAGE_KEY, STALE_ID)
    expect(await openInitialDocument('missing-root')).to.equal(undefined)
  })
})
