# SCAD — Stellator Cognitive Architecture Driver

A modular pipeline for creating documentary film concepts using AI.  
The system chains research, evidence extraction, claims, hypothesis verification, fact-checking, narrative writing, and visual planning — all with schema validation, resumable checkpoints, and full source-to-shot traceability.

## Pipeline Overview

```mermaid
flowchart LR
    Q[Research Question] --> R[Research]
    R --> E[Evidence & Claims]
    E --> H[Hypotheses]
    H --> VF[Hypothesis Verification]
    E --> F[Fact-Check]
    VF --> N[Narrative]
    F --> N
    N --> V[Visual Planner]
    V --> S[Self-Check]
    S --> O[Output]

    style R fill:#dbeafe,stroke:#3b82f6
    style E fill:#dbeafe,stroke:#3b82f6
    style VF fill:#dcfce7,stroke:#22c55e
    style F fill:#fef3c7,stroke:#f59e0b
    style S fill:#fef3c7,stroke:#f59e0b
    style O fill:#dcfce7,stroke:#22c55e
```

### Evidence & Research Engine

The research stage is an engine, not a single prompt. It churns the raw question
through a closed loop of sub-stages:

```mermaid
flowchart TB
    P[Research Planner] --> SQ[Sub-Questions]
    SQ --> SEARCH[Search Provider]
    SEARCH --> ANA[Source Registry]
    ANA --> EXT[Evidence Extractor]
    EXT --> CLM[Claim Extractor]
    CLM --> CON[Contradiction Detector]
    CLM --> GAP[Research Gap Detector]
    GAP -->|follow-up round| SEARCH
    CON --> OUT[Research Bundle]

    style P fill:#dbeafe,stroke:#3b82f6
    style SEARCH fill:#fef3c7,stroke:#f59e0b
    style OUT fill:#dcfce7,stroke:#22c55e
```

Each sub-stage is backed by an LLM prompt with a **deterministic fallback**: if the model
output fails validation, the engine degrades gracefully to heuristic logic instead of
blocking the pipeline. Evidence, claims, contradictions, and research gaps are always
reproducible, and claims link back through evidence to specific sources.

Each pipeline stage is **resumable**: artifacts are saved to `data/projects/<name>/memory/`
and skipped on re-run unless `--force` is passed. Fact-Check, Self-Check, hypothesis
verification, and the research fallbacks are **deterministic engines** (rules, not LLM) —
they verify structure and consistency of the output without calling an API.

## Quick Start

```bash
npm install
npm run build
npm run lint
npm test
```

Generate a documentary concept offline (no API key required):

```bash
LLM_PROVIDER=mock npx scad documentary humanity-species
```

The mock provider returns deterministic JSON responses suitable for demos and testing,
and the built-in mock search provider makes the whole chain run offline.

## Commands

| Command                                                 | Description                                     |
| ------------------------------------------------------- | ----------------------------------------------- |
| `npx scad documentary <title>`                          | Run the full pipeline for a documentary concept |
| `npx scad documentary <title> --force`                  | Re-run all stages from scratch                  |
| `npx scad documentary <title> --interactive`            | Halt at checkpoints for human approval          |
| `npx scad documentary <title> --provider <mock\|brave>` | Override the search provider for this run       |
| `npx scad sources <project>`                            | Inspect research sources                        |
| `npx scad evidence <project>`                           | Inspect extracted evidence                      |
| `npx scad contradictions <project>`                     | Inspect detected contradictions                 |
| `npx scad gaps <project>`                               | Inspect research gaps and priorities            |
| `npx scad trace <project>`                              | Show shot → claim → evidence → source tracing   |
| `npx scad help`                                         | Show help text                                  |

### Human Approval

SCAD is not fully autonomous by default. Pass `--interactive` (or `-i`) to review each
checkpoint before it is locked in:

- **RESEARCH REVIEW** → **HYPOTHESIS REVIEW** → **NARRATIVE REVIEW** → **FINAL FACT CHECK**

At every checkpoint you can: `(a)pprove`, `(r)eject`, `(m)odify` (opens the artifact in
`$EDITOR`), or `(g)enerate` the stage again. Approved states are recorded in
`data/projects/<name>/memory/approved.json`. Without the flag, the pipeline auto-approves
every stage (suitable for automation and CI).

Set `SCAD_DATA_DIR` to change the output root (default: `data/projects`).

## Configuration

Configure via `.env` (see `.env.example`):

| Setting                        | Values                                                      | Notes                                                     |
| ------------------------------ | ----------------------------------------------------------- | --------------------------------------------------------- |
| `LLM_PROVIDER`                 | `opencode` \| `ollama` \| `mock` \| `openai` \| `anthropic` | LLM backend; `mock` is fully offline                      |
| `OPENAI_API_KEY`               |                                                             | Required for `LLM_PROVIDER=openai`                        |
| `OPENAI_MODEL`                 | e.g. `gpt-4o`                                               | OpenAI model (used unless overridden)                     |
| `ANTHROPIC_API_KEY`            |                                                             | Required for `LLM_PROVIDER=anthropic`                     |
| `ANTHROPIC_MODEL`              | e.g. `claude-sonnet-4-20250514`                             | Anthropic model (used unless overridden)                  |
| `SEARCH_PROVIDER`              | `mock` (default) \| `brave`                                 | Search backend for the research engine                    |
| `BRAVE_SEARCH_API_KEY`         |                                                             | Required for `SEARCH_PROVIDER=brave`                      |
| `CONTENT_PROVIDER`             | `noop` (default) \| `mock` \| `http`                        | Full-page content fetcher for evidence                    |
| `RESEARCH_MAX_QUERIES`         | `10`                                                        | Max sub-questions per research run                        |
| `RESEARCH_MAX_RESULTS`         | `8`                                                         | Max search results per query                              |
| `RESEARCH_MAX_FOLLOWUP_ROUNDS` | `1`                                                         | How often gaps trigger follow-up research                 |
| `RESEARCH_MAX_SOURCES`         | `40`                                                        | Global cap on collected sources                           |
| `RESEARCH_MAX_CONTENT`         | `8000`                                                      | Per-source content length limit (chars)                   |
| `CACHE_ENABLED`                | `1`                                                         | `0` disables the JSON file cache entirely                 |
| `CACHE_TTL`                    | `86400`                                                     | Cache TTL in seconds                                      |
| `SCAD_CACHE_DIR`               | `data/cache`                                                | Where cache JSON files are stored (`data/` is gitignored) |
| `SCAD_DATA_DIR`                | `data/projects`                                             | Where documentary projects are stored                     |

### Providers & caching

- **LLM** — `openai` and `anthropic` call the real APIs with retry/timeout handling;
  `opencode` and `ollama` run local or remote models; `mock` returns deterministic JSON.
- **Search** — `brave` calls Brave Search (1000 free requests/month); `mock` is an offline
  fixture provider used by tests and demos.
- **Content** — real research is enriched with full page text: `http` fetches and extracts
  the page body (size-capped), `mock` serves fixture text, `noop` relies on snippets.
- **Cache** — search and content results are persisted as JSON under `SCAD_CACHE_DIR`
  keyed by provider + canonical URL, honoring `CACHE_ENABLED`/`CACHE_TTL`.

All real providers share `fetchWithRetry` (`src/providers/http.ts`): per-attempt timeouts,
exponential backoff, `Retry-After` handling, and automatic retry on transient failures
(408/429/5xx, timeouts, network errors).

## Project Structure

```
src/
  core/          # Domain types, Zod schemas, pipeline engine, memory store
  agents/        # LLM agents + deterministic engines (research, hypothesis, ...)
  providers/     # LLM + search + content + cache provider abstractions
  storage/       # Artifact export (project-store)
  cli/           # CLI entry point (bin.ts → cli.ts → dispatch.ts)
prompts/         # System prompt files per stage (loaded at runtime)
tests/           # Vitest unit + integration + E2E tests (offline)
examples/        # Generated documentary concept projects (mock provider)
```

Providers are injected into the research engine through small single-responsibility
interfaces: `SearchProvider`, `ContentProvider`, and `LLMProvider`. Cached variants wrap
any implementation without changing its contract, so the offline path and the real-API
path share one codebase.

### Agent Types

| Component          | Stage        | Type          | Description                                                        |
| ------------------ | ------------ | ------------- | ------------------------------------------------------------------ |
| `ResearchEngine`   | `research`   | LLM + rules   | Plan → search → evidence → claims → contradictions → gaps loop     |
| `ClaimsAgent`      | `claims`     | LLM           | Legacy claim extraction (used only when research has no claims)    |
| `HypothesisAgent`  | `hypotheses` | LLM           | Generates testable hypotheses grounded in evidence                 |
| `verifyHypotheses` | `hypotheses` | Deterministic | Verifies hypotheses against evidence, gaps, and contradictions     |
| `FactCheckEngine`  | `factCheck`  | Deterministic | Verifies claims against research sources                           |
| `NarrativeAgent`   | `narrative`  | LLM           | Writes a narrative structure with knowledge-level tagged sentences |
| `VisualAgent`      | `visual`     | LLM           | Converts narrative into visual shots                               |
| `SelfCheckEngine`  | `selfCheck`  | Deterministic | Validates structural consistency of all outputs                    |

## Testing

```bash
npm test          # unit + integration + E2E tests (offline, deterministic)
npm run check     # TypeCheck (tsc --noEmit)
npm run lint      # ESLint (zero warnings)
npm run format:check # Prettier
```

All tests run **offline** with `MockLLMProvider` / `MockSearchProvider` — no API key
required. Real-provider behavior (Brave, OpenAI, Anthropic, HTTP content) is exercised
against mocked `fetch` calls.

## Traceability

Every shot in the output traces back through the evidence chain:

```
SHOT → SNT (narrative sentence) → CLM (claim) → EVID (evidence) → SRC (source)
```

`TraceService` builds the full report from the research bundle, and
`buildTraceabilityReport()` covers the legacy pipeline; both are included in the output
(`traceability.json`).

## Domain Model

Core entities produced and consumed by the pipeline (all validated with Zod):

| Entity                | Stage          | Description                                                     |
| --------------------- | -------------- | --------------------------------------------------------------- |
| `Source`              | `research`     | A normalized, deduplicated reference with reliability/relevance |
| `SearchQuery`         | `research`     | A concrete query bound to a sub-question                        |
| `Evidence`            | `research`     | A claim-level finding tied to exactly one source                |
| `Claim`               | `research`     | A conclusion backed by linked evidence ids and sources          |
| `Contradiction`       | `research`     | Classified conflicts (population/period/definition/methodology) |
| `ResearchGap`         | `research`     | Uncovered sub-questions, weak evidence or open verification     |
| `ResearchBundle`      | `research`     | The full deterministic research output of one run               |
| `Hypothesis`          | `hypotheses`   | A testable assumption grounded in evidence                      |
| `FactCheckAssessment` | `factCheck`    | A claim checked against the research artifact                   |
| `Narrative`           | `narrative`    | Sections of knowledge-tagged sentences                          |
| `Shot`                | `visual`       | A timed visual beat linked to narrative sentences               |
| `SelfCheck`           | `selfCheck`    | Structural validation report over all artifacts                 |
| `TraceabilityReport`  | `traceability` | Shot → sentence → claim → evidence → source chain               |

**Research loop.** The research stage runs `question → plan → search → sources → evidence →
claims → contradictions → gaps → follow-up research → updated claims`, then ships the
`ResearchBundle` to hypotheses and fact-check. Because the whole chain degrades to
deterministic fallbacks, the loop runs identically offline and online.

## Roadmap

- **v0.1 — Core pipeline prototype (done).** The 7-stage pipeline with mock providers,
  resumable stages, human-approval checkpoints, and full traceability; first documentary
  concept generated offline.
- **v0.2 — Evidence & Research Engine (done).** Research became an engine: plan → search →
  sources → evidence → claims → contradictions → gaps → follow-up rounds, deterministic
  fallbacks everywhere, hypotheses verified against the evidence chain, and a working
  `ResearchBundle`. Ship: traceability report for every shot.
- **v0.3 — Real research providers (done).** Brave Search binding, OpenAI + Anthropic LLM
  bindings, content-extraction abstraction (`http`/`mock`/`noop`), JSON file caching with
  TTL, and retry/timeout/backoff transport shared by all real providers. Offline mode
  (`mock` everywhere) still requires no API keys.
- **v0.4 — Validation & scale (next).** Vector storage behind the `MemoryStore` seam,
  richer approve/reject/modify UI, more search providers, and staged documentary extraction
  (longer, source-driven outputs).

## License

MIT
