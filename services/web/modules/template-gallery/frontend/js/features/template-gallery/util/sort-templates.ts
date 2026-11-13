import { Sort } from '../types/api'
import { TemplateListEntry } from '../../../../../types/template'
import { SortingOrder } from '../../../../../../../types/sorting-order'
import { Compare } from '../../../../../../../types/helpers/array/sort'

const order = (order: SortingOrder, templates: TemplateListEntry[]) => {
  return order === 'asc' ? [...templates] : templates.reverse()
}

export const defaultComparator = (
  v1: TemplateListEntry,
  v2: TemplateListEntry,
  key: 'name' | 'lastUpdated'
) => {
  const value1 = v1[key].toLowerCase()
  const value2 = v2[key].toLowerCase()

  if (value1 !== value2) {
    return value1 < value2 ? Compare.SORT_A_BEFORE_B : Compare.SORT_A_AFTER_B
  }

  return Compare.SORT_KEEP_ORDER
}

export default function sortTemplates(
  templates: TemplateListEntry[],
  sort: Sort
) {
  let sorted = [...templates]
  if (sort.by === 'name') {
    sorted = sorted.sort((...args) => {
      return defaultComparator(...args, 'name')
    })
  }

  if (sort.by === 'lastUpdated') {
    sorted = sorted.sort((...args) => {
      return defaultComparator(...args, 'lastUpdated')
    })
  }

  return order(sort.order, sorted)
}
