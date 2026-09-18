import type { Source } from "../schemas.js"
import { canonicalUrl } from "../../providers/search/normalize.js"
import type { SearchResult } from "../../providers/search/search-provider.js"
import type { SourceAnalyzer } from "../../agents/research/source-analyzer.js"

/**
 * Persistent source registry for the Evidence & Research Engine.
 *
 * Sources are normalized (canonical URL) and deduplicated when added. Each
 * source keeps enough metadata to identify and evaluate it. The registry can
 * be persisted and reloaded through a MemoryStore.
 */
export class SourceRegistry {
  private readonly sources: Source[] = []
  private readonly byCanonical = new Map<string, Source>()
  private readonly byId = new Map<string, Source>()

  constructor(initial: Source[] = []) {
    for (const source of initial) this.add(source)
  }

  private assignId(): string {
    return `SRC_${String(this.sources.length + 1).padStart(3, "0")}`
  }

  private keyOf(source: Source): string {
    return source.canonicalUrl || canonicalUrl(source.url ?? "")
  }

  add(source: Omit<Source, "id"> & { id?: string }): Source {
    const key = this.keyOf(source as Source)
    if (key && this.byCanonical.has(key)) {
      const existing = this.byCanonical.get(key)!
      return existing
    }
    const merged: Source = { ...source, id: source.id ?? this.assignId() }
    this.sources.push(merged)
    this.byId.set(merged.id, merged)
    if (key) this.byCanonical.set(key, merged)
    return merged
  }

  /**
   * Normalizes, analyzes and registers search results in order. Returns the
   * newly added sources (deduplicated against existing entries).
   */
  addSearchResults(
    results: SearchResult[],
    meta: { queryId: string; subquestionId: string },
    analyzer: SourceAnalyzer,
  ): Source[] {
    const added: Source[] = []
    for (let rank = 0; rank < results.length; rank += 1) {
      const result = results[rank]!
      const analyzed = analyzer.analyze(result, rank)
      const source = this.add({
        ...analyzed,
        canonicalUrl: canonicalUrl(result.url),
        queryId: meta.queryId,
        subquestionId: meta.subquestionId,
        accessedAt: new Date().toISOString(),
      })
      if (source.queryId === meta.queryId) added.push(source)
    }
    return added
  }

  all(): Source[] {
    return [...this.sources]
  }

  get(id: string): Source | undefined {
    return this.byId.get(id)
  }

  get size(): number {
    return this.sources.length
  }

  has(id: string): boolean {
    return this.byId.has(id)
  }
}
