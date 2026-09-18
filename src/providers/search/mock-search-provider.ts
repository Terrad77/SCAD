import type { SearchProvider, SearchRequest, SearchResult } from "./search-provider.js"
import { dedupeSearchResults } from "./normalize.js"

interface MockFixture {
  url: string
  title: string
  snippet?: string
  source?: string
  publishedAt?: string
}

/**
 * Deterministic fixture-based search provider used by tests and the offline
 * demo. No network, no API keys. Results are stable for a given query so the
 * entire research pipeline is reproducible.
 */
export class MockSearchProvider implements SearchProvider {
  readonly name = "mock"

  constructor(private readonly fixtures: Record<string, MockFixture[]> = DEFAULT_FIXTURES) {}

  async search(request: SearchRequest): Promise<SearchResult[]> {
    const limit = request.limit ?? 8
    const query = request.query.trim().toLowerCase()
    const matched = Object.entries(this.fixtures)
      .filter(
        ([topic]) => query.includes(topic) || topic.split(" ").some((word) => query.includes(word)),
      )
      .sort(([a], [b]) => b.length - a.length)
      .flatMap(([, results]) => results)

    const pool = matched.length > 0 ? matched : FALLBACK_FIXTURES
    const results = pool
      .slice(0, limit)
      .map((fixture, index) => this.toResult(fixture, query, index))
    return dedupeSearchResults(results)
  }

  private toResult(fixture: MockFixture, query: string, index: number): SearchResult {
    return {
      id: `RSLT_${String(index + 1).padStart(3, "0")}`,
      title: fixture.title,
      url: fixture.url,
      snippet: fixture.snippet,
      source: fixture.source,
      publishedAt: fixture.publishedAt,
    }
  }
}

const DEFAULT_FIXTURES: Record<string, MockFixture[]> = {
  species: [
    {
      url: "https://www.nature.com/articles/s41559-024-00001",
      title: "What is a biological species? A modern synthesis",
      snippet:
        "A species is commonly defined as a group of organisms that can interbreed and produce fertile offspring, yet the concept strains at the edges of reproductive isolation.",
      source: "Nature Ecology & Evolution",
      publishedAt: "2023-05-14",
    },
    {
      url: "https://www.plos.org/species-concept-review",
      title: "The species problem: why biological definitions are contested",
      snippet:
        "Different species concepts emphasize interbreeding, ecology or phylogeny, and they do not always agree on which populations deserve species status.",
      source: "PLOS Biology",
      publishedAt: "2022-11-02",
    },
  ],
  neanderthal: [
    {
      url: "https://www.nature.com/articles/nature12961",
      title: "A high-quality Neanderthal genome sequence",
      snippet:
        "Sequencing of a Neanderthal genome shows that non-African modern humans carry an estimated 1-4% Neanderthal ancestry from ancient admixture.",
      source: "Nature",
      publishedAt: "2014-02-13",
    },
    {
      url: "https://www.bbc.com/news/science-environment-antarctic-neanderthal",
      title: "New analysis revises Neanderthal admixture estimates",
      snippet:
        "A re-analysis using modern statistical methods suggests admixture estimates vary by population and methodology, and some European populations may show slightly lower introgression.",
      source: "BBC News",
      publishedAt: "2023-08-21",
    },
  ],
  isolation: [
    {
      url: "https://www.pnas.org/doi/reproductive-isolation-barriers",
      title: "Reproductive isolation: the engine of speciation",
      snippet:
        "Theory and breeding experiments show that prolonged reproductive isolation is the primary route by which populations diverge into separate species over many generations.",
      source: "Proceedings of the National Academy of Sciences",
      publishedAt: "2019-03-28",
    },
    {
      url: "https://royalsocietypublishing.org/doi/speciation-timescales",
      title: "Timescales of vertebrate speciation",
      snippet:
        "Comparative studies indicate that full reproductive isolation in vertebrates typically requires tens of thousands to millions of years of separation.",
      source: "Proceedings of the Royal Society B",
      publishedAt: "2021-06-09",
    },
  ],
  mars: [
    {
      url: "https://www.nasa.gov/mars-habitation-long-term-effects",
      title: "Long-term Mars habitation: biological unknowns",
      snippet:
        "NASA reports that the long-term biological effects of low gravity and radiation over many generations remain unknown, and no multi-generational study exists.",
      source: "NASA",
      publishedAt: "2022-02-17",
    },
    {
      url: "https://www.space.com/mars-genetic-divergence-analysis",
      title: "Could an isolated Mars colony diverge genetically?",
      snippet:
        "Modeling suggests that a small, isolated human population on Mars could drift genetically, but whether this becomes reproductive isolation is speculative and untested.",
      source: "Space.com",
      publishedAt: "2024-01-10",
    },
  ],
  genetic: [
    {
      url: "https://www.science.org/doi/crispr-germline-heritable",
      title: "Heritable human genome editing: technical status",
      snippet:
        "Current gene-editing research demonstrates heritable changes in model organisms; human germline editing remains technically immature and legally restricted in most nations.",
      source: "Science",
      publishedAt: "2020-06-05",
    },
    {
      url: "https://www.who.int/genetics/human-genome-editing-position",
      title: "WHO position on human genome editing",
      snippet:
        "The WHO calls for caution on heritable human genome editing, noting that technical feasibility does not imply safety or ethical acceptability.",
      source: "WHO",
      publishedAt: "2021-07-12",
    },
  ],
  evolution: [
    {
      url: "https://www.cell.com/current biology/no-evidence-current-human-divergence",
      title: "No evidence that modern human populations are diverging into new species",
      snippet:
        "Population geneticists find no evidence that contemporary human populations are reproductively isolated; migration and gene flow remain pervasive.",
      source: "Current Biology",
      publishedAt: "2023-10-02",
    },
    {
      url: "https://maxplanck-institute-biology/reproductive-divergence-critique",
      title: "Reproductive divergence is not observed in isolated human populations",
      snippet:
        "Even historically isolated human groups show no signs of reproductive isolation from the global population, according to large-scale genomic datasets.",
      source: "Max Planck Institute for Evolutionary Biology",
      publishedAt: "2022-09-15",
    },
  ],
}

const FALLBACK_FIXTURES: MockFixture[] = [
  {
    url: "https://example.org/research/topic-overview",
    title: "Overview of current research on the question",
    snippet:
      "General background material relevant to the research question, providing starting points rather than conclusions.",
    source: "Encyclopedia of Human Evolution",
  },
  {
    url: "https://example.org/research/related-study",
    title: "A related study from a peer-reviewed venue",
    snippet:
      "A secondary study that touches on aspects of the question; relevance and reliability are assessed separately by the source analyzer.",
    source: "Journal of Anthropological Sciences",
  },
]
