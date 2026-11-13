import { deleteJSON, postJSON } from '@/infrastructure/fetch-json'
import { Template } from '../../../../../types/template'

export function deleteTemplate(template: Template) {
  return deleteJSON(`/template/${template.id}/delete`, {
    body: {
      version: template.version,
    },
  })
}

type UpdateTemplateOptions = {
  template: Template
  editedTemplate: Template
}

export function updateTemplate({
  template,
  editedTemplate,
}: UpdateTemplateOptions): Promise<Template | null> {
  const updatedFields: Partial<Template> = {
    name: editedTemplate.name.trim(),
    license: editedTemplate.license,
    category: editedTemplate.category,
    language: editedTemplate.language,
    authorMD: editedTemplate.authorMD.trim(),
    descriptionMD: editedTemplate.descriptionMD.trim(),
  }

  const editableFields = [
    'name',
    'license',
    'category',
    'language',
    'authorMD',
    'descriptionMD',
  ] as const
  const changedFields: Partial<
    Pick<Template, (typeof editableFields)[number]>
  > = {}
  for (const key of editableFields) {
    const value = updatedFields[key]
    if (value !== undefined && template[key] !== value) {
      changedFields[key] = value
    }
  }

  if (Object.keys(changedFields).length === 0) {
    return Promise.resolve(null)
  }

  return postJSON(`/template/${editedTemplate.id}/edit`, {
    body: changedFields,
  })
}
