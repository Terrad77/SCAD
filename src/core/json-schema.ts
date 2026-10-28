import type { z } from "zod"
import type { LLMJsonSchema } from "../providers/llm/llm.js"

type SchemaDef = {
  typeName?: string
  innerType?: z.ZodTypeAny
  schema?: z.ZodTypeAny
  type?: z.ZodTypeAny
  shape?: () => Record<string, z.ZodTypeAny>
  options?: z.ZodTypeAny[]
  values?: unknown[] | Record<string, unknown>
  value?: unknown
  checks?: Array<{ kind?: string }>
  unknownKeys?: string
  catchall?: z.ZodTypeAny
}

/** Convert a Zod v3 object to the common strict-output subset used by vendors. */
export function toLLMJsonSchema(schema: z.ZodTypeAny, name: string): LLMJsonSchema {
  const converted = toSchema(schema) as Record<string, unknown>
  if (converted.type !== "object") {
    throw new Error("Native JSON Schema output requires a root Zod object schema")
  }
  return { name: safeSchemaName(name), schema: converted }
}

/**
 * OpenAI strict schemas represent optional fields as required nullable fields.
 * Turn those synthetic nulls back into absent values before the authoritative
 * Zod parse, preserving `.optional()` and `.default()` semantics.
 */
export function normalizeJsonSchemaNulls(value: unknown, schema: z.ZodTypeAny): unknown {
  const type = schemaDef(schema).typeName
  const def = schemaDef(schema)

  if (type === "ZodEffects" && def.schema) {
    return normalizeJsonSchemaNulls(value, def.schema)
  }
  if ((type === "ZodOptional" || type === "ZodDefault") && def.innerType) {
    if (value === null && !acceptsNull(def.innerType)) return undefined
    return normalizeJsonSchemaNulls(value, def.innerType)
  }
  if (type === "ZodNullable" && def.innerType) {
    return value === null ? null : normalizeJsonSchemaNulls(value, def.innerType)
  }
  if (type === "ZodArray" && def.type && Array.isArray(value)) {
    return value.map((item) => normalizeJsonSchemaNulls(item, def.type!))
  }
  if (type === "ZodObject" && def.shape && isRecord(value)) {
    const result: Record<string, unknown> = { ...value }
    for (const [key, propertySchema] of Object.entries(def.shape())) {
      if (!(key in result)) continue
      const normalized = normalizeJsonSchemaNulls(result[key], propertySchema)
      if (normalized === undefined) delete result[key]
      else result[key] = normalized
    }
    return result
  }
  if (type === "ZodUnion" && def.options) {
    for (const option of def.options) {
      const normalized = normalizeJsonSchemaNulls(value, option)
      if (option.safeParse(normalized).success) return normalized
    }
  }
  return value
}

function acceptsNull(schema: z.ZodTypeAny): boolean {
  const { typeName, innerType, schema: effectSchema, options } = schemaDef(schema)
  if (typeName === "ZodNullable") return true
  if ((typeName === "ZodOptional" || typeName === "ZodDefault") && innerType) {
    return acceptsNull(innerType)
  }
  if (typeName === "ZodEffects" && effectSchema) return acceptsNull(effectSchema)
  if (typeName === "ZodUnion" && options) return options.some(acceptsNull)
  return false
}

function schemaDef(schema: z.ZodTypeAny): SchemaDef {
  return schema._def as SchemaDef
}

function toSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = schemaDef(schema)
  switch (def.typeName) {
    case "ZodEffects":
      if (def.schema) return toSchema(def.schema)
      break
    case "ZodOptional":
    case "ZodDefault":
      if (def.innerType) return nullableSchema(toSchema(def.innerType))
      break
    case "ZodNullable":
      if (def.innerType) return nullableSchema(toSchema(def.innerType))
      break
    case "ZodObject": {
      if (!def.shape) break
      if (
        def.unknownKeys === "passthrough" ||
        (def.catchall && schemaDef(def.catchall).typeName !== "ZodNever")
      ) {
        throw new Error("Native JSON Schema output requires closed Zod objects")
      }
      const properties: Record<string, unknown> = {}
      const required: string[] = []
      for (const [key, property] of Object.entries(def.shape())) {
        properties[key] = toSchema(property)
        // Strict provider formats require all object keys. Optional Zod fields
        // are represented as nullable and normalized after the response.
        required.push(key)
      }
      return { type: "object", properties, required, additionalProperties: false }
    }
    case "ZodArray":
      if (def.type) return { type: "array", items: toSchema(def.type) }
      break
    case "ZodString":
      return { type: "string" }
    case "ZodNumber":
      return { type: def.checks?.some((check) => check.kind === "int") ? "integer" : "number" }
    case "ZodBoolean":
      return { type: "boolean" }
    case "ZodEnum":
      if (Array.isArray(def.values)) return { type: "string", enum: def.values }
      break
    case "ZodNativeEnum":
      if (def.values && !Array.isArray(def.values)) {
        const values = [...new Set(Object.values(def.values).filter(isJsonPrimitive))]
        return {
          type: values.every((value) => typeof value === "string") ? "string" : "number",
          enum: values,
        }
      }
      break
    case "ZodLiteral":
      if (isJsonPrimitive(def.value)) {
        return { type: jsonType(def.value), const: def.value }
      }
      break
    case "ZodUnion":
      if (def.options) return { anyOf: def.options.map(toSchema) }
      break
    case "ZodNull":
      return { type: "null" }
  }
  throw new Error(`Unsupported Zod type for native JSON Schema: ${def.typeName ?? "unknown"}`)
}

function nullableSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (typeof schema.type === "string") return { ...schema, type: [schema.type, "null"] }
  if (Array.isArray(schema.type) && !schema.type.includes("null")) {
    return { ...schema, type: [...schema.type, "null"] }
  }
  return { anyOf: [schema, { type: "null" }] }
}

function safeSchemaName(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64)
  return safe || "scad_output"
}

function isJsonPrimitive(value: unknown): value is string | number | boolean | null {
  return value === null || ["string", "number", "boolean"].includes(typeof value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function jsonType(value: string | number | boolean | null): string {
  return value === null ? "null" : typeof value
}
