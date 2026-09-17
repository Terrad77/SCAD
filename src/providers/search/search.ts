/** Search provider abstraction. The MVP ships without a live search backend;
 * the interface exists so a web/search extension can be plugged in later. */

export interface SearchResult {
  title: string
  url: string
  snippet: string
  sourceType?: string
}

export interface SearchProvider {
  search(query: string, limit?: number): Promise<SearchResult[]>
}

/** No-op provider used until a real search backend is wired in. */
export class NoopSearchProvider implements SearchProvider {
  async search(_query: string, _limit?: number): Promise<SearchResult[]> {
    return []
  }
}
