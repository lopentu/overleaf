import { expect } from 'chai'
import sinon from 'sinon'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import SettingsMenuSelect from '../../../../../modules/template-gallery/frontend/js/features/template/components/settings/settings-menu-select'

describe('template settings select', function () {
  afterEach(cleanup)

  it('applies an empty-string default before an optgroup default', function () {
    const onChange = sinon.spy()
    render(
      <SettingsMenuSelect
        name="language"
        label="Language"
        options={[{ value: '', label: 'Off' }]}
        optgroup={{
          label: 'Languages',
          options: [{ value: 'en', label: 'English' }],
        }}
        onChange={onChange}
      />
    )
    expect(onChange).to.have.been.calledWith('')
    expect(onChange).not.to.have.been.calledWith('en')
  })

  it('does not call onChange with undefined when there are no options', function () {
    const onChange = sinon.spy()
    render(
      <SettingsMenuSelect
        name="category"
        label="Category"
        options={[]}
        onChange={onChange}
      />
    )
    expect(onChange).not.to.have.been.called
  })
  it('uses the provided accessible label and preserves numeric option values', function () {
    const onChange = sinon.spy()
    render(
      <SettingsMenuSelect
        name="count"
        label="Count"
        options={[
          { value: 0, label: 'None' },
          { value: 1, label: 'One' },
        ]}
        onChange={onChange}
      />
    )
    onChange.resetHistory()
    fireEvent.change(screen.getByRole('combobox', { name: 'Count' }), {
      target: { value: '1' },
    })
    expect(onChange).to.have.been.calledWith(1)
  })
})
