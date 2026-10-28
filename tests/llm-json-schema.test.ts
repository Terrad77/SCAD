import { describe, expect, it } from "vitest"
import { z } from "zod"
import {
  ClaimsOutputSchema,
  EvidenceOutputSchema,
  HypothesesOutputSchema,
  NarrativeSchema,
  ResearchOutputSchema,
  ResearchPlanOutputSchema,
  SelfCheckOutputSchema,
  VisualOutputSchema,
} from "../src/core/schemas.js"
import { normalizeJsonSchemaNulls, toLLMJsonSchema } from "../src/core/json-schema.js"

describe("provider JSON Schema support", () => {
  it("converts optional Zod properties to strict required nullable properties", () => {
    const result = toLLMJsonSchema(
      z.object({ title: z.string(), notes: z.string().optional() }),
      "stage / output",
    )

    expect(result.name).toBe("stage___output")
    expect(result.schema).toMatchObject({
      type: "object",
      required: ["title", "notes"],
      additionalProperties: false,
      properties: {
        title: { type: "string" },
        notes: { type: ["string", "null"] },
      },
    })
    expect(result.schema).not.toHaveProperty("$schema")
  })

  it("normalizes synthetic nulls back to optional and defaulted Zod fields", () => {
    const schema = z.object({
      title: z.string(),
      notes: z.string().optional(),
      tags: z.array(z.string()).default([]),
      explicitlyNullable: z.string().nullable(),
      nested: z.object({ optional: z.boolean().optional() }).optional(),
    })

    const normalized = normalizeJsonSchemaNulls(
      {
        title: "Script",
        notes: null,
        tags: null,
        explicitlyNullable: null,
        nested: { optional: null },
      },
      schema,
    )
    expect(schema.parse(normalized)).toEqual({
      title: "Script",
      tags: [],
      explicitlyNullable: null,
      nested: {},
    })
  })

  it("converts the nested production audit schema used by SelfCheck", () => {
    const result = toLLMJsonSchema(SelfCheckOutputSchema, "self-check")
    expect(result.schema).toMatchObject({ type: "object", additionalProperties: false })
  })

  it("converts the Zod schemas used at production LLM call sites", () => {
    const schemas = [
      ClaimsOutputSchema,
      EvidenceOutputSchema,
      HypothesesOutputSchema,
      NarrativeSchema,
      ResearchOutputSchema,
      ResearchPlanOutputSchema,
      SelfCheckOutputSchema,
      VisualOutputSchema,
    ]
    for (const schema of schemas) {
      expect(toLLMJsonSchema(schema, "scad_stage").schema).toMatchObject({ type: "object" })
    }
  })
})
