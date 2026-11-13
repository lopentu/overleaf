import { SortingOrder } from '../../../../../../../types/sorting-order'
import { TemplateListEntry } from '../../../../../types/template'

export type Sort = {
  by: 'lastUpdated' | 'name'
  order: SortingOrder
}

export type GetTemplatesResponseBody = {
  totalSize: number
  templates: TemplateListEntry[]
}
