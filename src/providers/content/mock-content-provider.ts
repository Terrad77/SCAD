import type { ContentProvider, ContentRequest, ContentResult } from "./content-provider.js"

/** Deterministic offline content fixtures keyed by canonical source URL. */
export const MOCK_CONTENT_FIXTURES: Record<string, { title: string; text: string }> = {
  "https://www.nature.com/articles/s41559-024-00001": {
    title: "What is a biological species? A modern synthesis",
    text: "A species is commonly defined as a group of organisms that can interbreed and produce fertile offspring, yet the concept strains at the edges of reproductive isolation. Modern synthesis frameworks reconcile several definitions but agree that reproductive isolation is the central criterion for most multicellular organisms. Full-page marker: only the fetched article body contains this sentence.",
  },
  "https://www.plos.org/species-concept-review": {
    title: "The species problem: why biological definitions are contested",
    text: "Different species concepts emphasize interbreeding, ecology or phylogeny, and they do not always agree on which populations deserve species status. No single definition handles bacteria, plants, and parthenogenetic lineages, which is why the species problem persists.",
  },
  "https://www.nature.com/articles/nature12961": {
    title: "A high-quality Neanderthal genome sequence",
    text: "Sequencing of a Neanderthal genome shows that non-African modern humans carry an estimated 1-4% Neanderthal ancestry from ancient admixture occurring roughly 50,000 to 60,000 years ago.",
  },
  "https://www.pnas.org/doi/reproductive-isolation-barriers": {
    title: "Reproductive isolation: the engine of speciation",
    text: "Theory and breeding experiments show that prolonged reproductive isolation is the primary route by which populations diverge into separate species over many generations.",
  },
  "https://www.cell.com/current biology/no-evidence-current-human-divergence": {
    title: "No evidence that modern human populations are diverging into new species",
    text: "Population geneticists find no evidence that contemporary human populations are reproductively isolated; migration and gene flow remain pervasive across every inhabited continent.",
  },
}

/**
 * Deterministic, offline content provider used by tests and the mock demo.
 * Unknown URLs yield empty text so the engine degrades to search snippets.
 */
export class MockContentProvider implements ContentProvider {
  readonly name = "mock"

  constructor(
    private readonly fixtures: Record<
      string,
      { title: string; text: string }
    > = MOCK_CONTENT_FIXTURES,
  ) {}

  async fetchContent(request: ContentRequest): Promise<ContentResult> {
    const maxBytes = request.maxBytes ?? 8_000
    const fixture = this.fixtures[request.url]
    const title = fixture?.title
    const text = fixture?.text ?? ""
    const truncated = typeof fixture?.text === "string" && fixture.text.length > maxBytes
    return {
      url: request.url,
      title,
      text: text.slice(0, maxBytes),
      fetchedAt: new Date().toISOString(),
      truncated,
      contentType: "text/plain",
    }
  }
}
