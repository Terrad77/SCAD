import type {
  Claim,
  Evidence,
  Narrative,
  ResearchBundle,
  ResearchOutput,
  Shot,
  Hypothesis,
} from "../../src/core/schemas.js"

export function makeSource(over: Partial<ResearchOutput["sources"][number]> = {}) {
  return {
    id: "SRC_001",
    title: "A Reliable Work",
    author: "Author",
    type: "BOOK",
    reliability: 0.9,
    ...over,
  }
}

export function makeResearch(over: Partial<ResearchOutput> = {}): ResearchOutput {
  return {
    sources: [makeSource()],
    summary: "Established science summary.",
    ...over,
  }
}

export function makeClaim(over: Partial<Claim> = {}): Claim {
  return {
    id: "CLM_001",
    statement: "Humans share a common ancestor with Neanderthals.",
    sources: ["SRC_001"],
    evidence: ["Genomic data shows interbreeding."],
    confidence: 0.8,
    status: "SUPPORTED",
    knowledge: "FACT",
    ...over,
  }
}

export function makeClaims(over: Partial<ReturnType<typeof makeResearch>> = {}): {
  claims: Claim[]
} {
  return { claims: [makeClaim()], ...over }
}

export function makeHypothesis(over: Partial<Hypothesis> = {}): Hypothesis {
  return {
    id: "HYP_001",
    statement: "Geographic isolation could drive reproductive divergence.",
    basis: ["Isolation reduces gene flow."],
    supportingClaims: ["CLM_001"],
    contradictingClaims: [],
    confidence: 0.5,
    status: "ACTIVE",
    assumptions: ["Isolation persists for millennia."],
    missingInfo: ["Necessary timescale."],
    verificationTasks: ["Model population genetics."],
    ...over,
  }
}

export function makeNarrative(over: Partial<Narrative> = {}): Narrative {
  return {
    title: "Can Humanity Become a New Species?",
    logline: "A documentary about the future of human evolution.",
    thesis: "Technology is beginning to shape human evolution.",
    sections: [
      {
        id: "SEC_001",
        heading: "Hook",
        sentences: [
          {
            id: "SNT_001",
            text: "Humans share ancestors with Neanderthals, whose genetic influence reached into modern populations.",
            knowledge: "FACT",
            claimIds: ["CLM_001"],
          },
          {
            id: "SNT_002",
            text: "But what if technology begins to rewrite the human story?",
            knowledge: "SPECULATION",
            claimIds: [],
          },
        ],
      },
    ],
    ...over,
  }
}

export function makeShot(over: Partial<Shot> = {}): Shot {
  return {
    id: "SHOT_001",
    duration: 7,
    narration: "Humans share ancestors with Neanderthals.",
    visualType: "AI_RECONSTRUCTION",
    description: "Two hominins crossing a ridge.",
    camera: "slow tracking shot",
    lighting: "natural dawn light",
    mood: "contemplative",
    source: "SRC_001",
    narrativeSentenceIds: ["SNT_001"],
    ...over,
  }
}

export function makeShots(over: Partial<ReturnType<typeof makeNarrative>> = {}): { shots: Shot[] } {
  return { shots: [makeShot()], ...over }
}

export function makeEvidence(over: Partial<Evidence> = {}): Evidence {
  return {
    id: "EV_001",
    sourceId: "SRC_001",
    statement: "Genomic data shows interbreeding between hominins.",
    excerpt: "Genomic data shows interbreeding.",
    supportsClaims: ["CLM_001"],
    contradictsClaims: [],
    confidence: 0.85,
    ...over,
  }
}

/** Deterministic, structurally-independent ResearchBundle for v0.4 tests. */
export function makeResearchBundle(over: Partial<ResearchBundle> = {}): ResearchBundle {
  return {
    question: "Can humanity become a new species?",
    summary: "Two independent sources support the interbreeding claim.",
    plan: {
      id: "PLAN_001",
      question: "Can humanity become a new species?",
      subQuestions: [
        { id: "SUB_Q_001", text: "Did interbreeding happen?" },
        { id: "SUB_Q_002", text: "Does isolation drive divergence?" },
      ],
    },
    queries: [
      { id: "QRY_001", subquestionId: "SUB_Q_001", query: "interbreeding" },
      { id: "QRY_002", subquestionId: "SUB_Q_002", query: "isolation divergence" },
    ],
    sources: [
      {
        id: "SRC_001",
        title: "Reuters Science Desk",
        url: "https://reuters.com/science/interbreeding",
        publisher: "Reuters",
        type: "NEWS",
        reliability: 0.7,
      },
      {
        id: "SRC_002",
        title: "Nature Journal",
        url: "https://nature.com/articles/hominin",
        publisher: "Nature Portfolio",
        type: "JOURNAL",
        reliability: 0.9,
      },
    ],
    evidence: [
      makeEvidence({ id: "EV_001", sourceId: "SRC_001" }),
      makeEvidence({
        id: "EV_002",
        sourceId: "SRC_002",
        statement: "Neanderthal admixture is documented in modern genomes.",
      }),
    ],
    claims: [
      makeClaim({
        evidence: ["Genomic data shows interbreeding."],
        evidenceIds: ["EV_001", "EV_002"],
        subquestionIds: ["SUB_Q_001"],
      }),
    ],
    contradictions: [],
    gaps: [],
    ...over,
  }
}
