/**
 * Offline demo fixtures for the movie pipeline. Each agent stage returns a
 * canned JSON response, so `LLM_PROVIDER=mock scad documentary <title>` runs
 * end-to-end without an API key. Used by the CLI factory and examples.
 */
export const DEMO_STAGE_RESPONSES: Record<string, string> = {
  research: JSON.stringify({
    sources: [
      { id: "SRC_001", title: "Neanderthal Genome Project", type: "PAPER", reliability: 0.95 },
      { id: "SRC_002", title: "Future Evolution of Humans", type: "BOOK", reliability: 0.7 },
    ],
    summary:
      "Well-established facts about Neanderthal admixture and future evolutionary pressures on Homo sapiens.",
  }),
  claims: JSON.stringify({
    claims: [
      {
        id: "CLM_001",
        statement: "Modern humans carry 1-4% Neanderthal DNA from ancient interbreeding.",
        sources: ["SRC_001"],
        evidence: ["Genomic sequencing of Neanderthal and modern populations."],
        confidence: 0.95,
        status: "SUPPORTED",
        knowledge: "FACT",
      },
      {
        id: "CLM_002",
        statement: "Technology is creating selective pressures unlike anything in natural history.",
        sources: ["SRC_002"],
        evidence: ["Discussion of genetic engineering, AI, and human enhancement."],
        confidence: 0.6,
        status: "PARTIAL",
        knowledge: "INTERPRETATION",
      },
      {
        id: "CLM_003",
        statement: "A genetically modified human population might diverge rapidly.",
        sources: ["SRC_002"],
        evidence: ["Speculative projection from current gene therapy research."],
        confidence: 0.4,
        status: "PARTIAL",
        knowledge: "SPECULATION",
      },
    ],
  }),
  hypothesis: JSON.stringify({
    hypotheses: [
      {
        id: "HYP_001",
        statement: "Geographic or reproductive isolation could cause new speciation.",
        basis: ["Allopatric speciation models."],
        supportingClaims: ["CLM_001"],
        contradictingClaims: [],
        confidence: 0.5,
        status: "ACTIVE",
        assumptions: ["A sufficiently isolated population persists."],
        missingInfo: ["Isolation threshold for humans."],
        verificationTasks: ["Review reproductive isolation research."],
      },
      {
        id: "HYP_002",
        statement:
          "Genetic engineering may bypass natural selection and create a new form of human.",
        basis: ["Gene therapy and synthetic biology advances."],
        supportingClaims: ["CLM_002"],
        contradictingClaims: [],
        confidence: 0.55,
        status: "ACTIVE",
        assumptions: ["Technology continues to advance without major restrictions."],
        missingInfo: ["Technical feasibility of heritable human germline changes."],
        verificationTasks: ["Assess CRISPR human germline progress."],
      },
    ],
  }),
  narrative: JSON.stringify({
    title: "Can Humanity Become a New Species?",
    logline:
      "When technology begins to shape evolution, the definition of 'human' may change forever.",
    thesis:
      "Human evolution is no longer driven only by nature; technology is creating new forces of divergence.",
    sections: [
      {
        id: "SEC_001",
        heading: "Hook",
        sentences: [
          {
            id: "SNT_001",
            text: "Humans carry a small but measurable percentage of Neanderthal DNA from encounters tens of thousands of years ago.",
            knowledge: "FACT",
            claimIds: ["CLM_001"],
          },
          {
            id: "SNT_002",
            text: "But what if our species could split again — this time, driven by technology rather than ice and isolation?",
            knowledge: "SPECULATION",
            claimIds: ["CLM_003"],
          },
        ],
      },
      {
        id: "SEC_002",
        heading: "What is a biological species?",
        sentences: [
          {
            id: "SNT_003",
            text: "In classical biology, a species is a group of organisms that can interbreed and produce fertile offspring.",
            knowledge: "FACT",
            claimIds: [],
          },
          {
            id: "SNT_004",
            text: "The definition works well for well-isolated populations but blurs at the edges.",
            knowledge: "INTERPRETATION",
            claimIds: [],
          },
        ],
      },
      {
        id: "SEC_003",
        heading: "Humans and Neanderthals",
        sentences: [
          {
            id: "SNT_005",
            text: "Modern humans and Neanderthals interbred, leaving a small genetic legacy in non-African populations today.",
            knowledge: "FACT",
            claimIds: ["CLM_001"],
          },
        ],
      },
      {
        id: "SEC_004",
        heading: "Technology as a new evolutionary force",
        sentences: [
          {
            id: "SNT_006",
            text: "CRISPR and other gene-editing tools could alter the human germline within a generation.",
            knowledge: "INTERPRETATION",
            claimIds: ["CLM_002"],
          },
          {
            id: "SNT_007",
            text: "If heritable changes are introduced and propagate through a population, the result may be a new lineage.",
            knowledge: "SPECULATION",
            claimIds: ["CLM_003"],
          },
        ],
      },
    ],
  }),
  visual: JSON.stringify({
    shots: [
      {
        id: "SHOT_001",
        duration: 5,
        narration: "Humans carry a small but measurable percentage of Neanderthal DNA.",
        visualType: "INFOGRAPHIC",
        description: "Animated bar chart showing 1-4% Neanderthal DNA percentage.",
        narrativeSentenceIds: ["SNT_001"],
      },
      {
        id: "SHOT_002",
        duration: 4,
        narration: "But what if our species could split again?",
        visualType: "AI_RECONSTRUCTION",
        description: "Two divergent human silhouettes against a futuristic backdrop.",
        camera: "slow pan",
        mood: "mysterious",
        narrativeSentenceIds: ["SNT_002"],
      },
      {
        id: "SHOT_003",
        duration: 6,
        narration: "In classical biology, a species is a group that can interbreed.",
        visualType: "ABSTRACT",
        description: "Animated interbreeding circle diagram.",
        narrativeSentenceIds: ["SNT_003"],
      },
      {
        id: "SHOT_004",
        duration: 5,
        narration: "Modern humans and Neanderthals interbred.",
        visualType: "ARCHIVE",
        description: "Side-by-side hominid skulls with data overlay.",
        narrativeSentenceIds: ["SNT_005"],
      },
      {
        id: "SHOT_005",
        duration: 5,
        narration: "CRISPR could alter the human germline within a generation.",
        visualType: "AI_RECONSTRUCTION",
        description: "Double helix unwinding and reassembling with gene-editing visuals.",
        camera: "close-up",
        mood: "contemplative",
        narrativeSentenceIds: ["SNT_006"],
      },
      {
        id: "SHOT_006",
        duration: 4,
        narration: "The result may be a new lineage.",
        visualType: "ABSTRACT",
        description: "Branching evolutionary tree with a new fork forming.",
        camera: "pull back",
        mood: "unsettling",
        narrativeSentenceIds: ["SNT_007"],
      },
    ],
  }),
  revision: JSON.stringify({
    statement:
      "Genetic engineering may bypass natural selection and create a new form of human, subject to the heritability and long-term fitness of edited traits.",
  }),
  "alternative-explanations": JSON.stringify({
    hypothesis: {
      statement:
        "Technological culture alone may drive human divergence, without any heritable genetic change being required.",
      basis: [
        "Cultural and environmental selection pressures can split populations behaviorally.",
        "The claim that technology changes selective pressures does not imply a genetic split.",
      ],
      supportingClaims: ["CLM_002"],
      contradictingClaims: ["CLM_003"],
      assumptions: ["A genetically altered lineage is not required for divergence."],
      missingInfo: ["Longitudinal evidence of panmixia vs. genetic isolation."],
      verificationTasks: ["Check interbreeding models for genetically edited populations."],
    },
  }),
}
