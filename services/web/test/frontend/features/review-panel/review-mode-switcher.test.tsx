import { EditorView } from '@codemirror/view'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect } from 'chai'

import ReviewModeSwitcher from '@/features/review-panel/components/review-mode-switcher'
import { TrackChangesStateProvider } from '@/features/review-panel/context/track-changes-state-context'
import { CodeMirrorViewContext } from '@/features/source-editor/components/codemirror-context'
import { renderWithEditorContext } from '../../helpers/render-with-context'

describe('ReviewModeSwitcher', function () {
  it('announces Editing as disabled to reviewers', async function () {
    const view = new EditorView({})
    try {
      renderWithEditorContext(
        <CodeMirrorViewContext.Provider value={view}>
          <TrackChangesStateProvider>
            <ReviewModeSwitcher />
          </TrackChangesStateProvider>
        </CodeMirrorViewContext.Provider>,
        {
          permissionsLevel: 'review',
          scope: { editor: { sharejs_doc: null } },
          projectFeatures: { trackChanges: true },
        }
      )

      const user = userEvent.setup()
      await user.click(screen.getByRole('button', { name: 'Reviewing' }))
      const editing = screen.getByRole('menuitem', { name: /^Editing/ })
      expect(editing.getAttribute('aria-disabled')).to.equal('true')
    } finally {
      view.destroy()
    }
  })
})
