// Public browser credentials and wiki index supplied in ol-algolia.
export type AlgoliaConfig = {
  appId: string
  apiKey: string
  indexes: { wiki?: string }
}
