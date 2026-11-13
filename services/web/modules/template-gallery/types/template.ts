export type TemplateListEntry = Pick<
  Template,
  'id' | 'version' | 'name' | 'lastUpdated' | 'author' | 'description'
>

export type Template = {
  id: string
  version: string
  name: string
  lastUpdated: string
  author: string
  authorMD: string
  description: string
  descriptionMD: string
  license: string
  category: string
  compiler?: string
  language?: string
  mainFile: string
  imageName?: string
  owner: string
}
