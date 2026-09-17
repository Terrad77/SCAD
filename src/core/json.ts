/**
 * Extracts a JSON object from model output. STrips optional Markdown fences and
 * leading/trailing prose, then relies on strict JSON.parse + Zod validation.
 */
export function parseJsonObject(raw: string): unknown {
  const trimmed = raw.trim()
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim()
  return JSON.parse(unfenced)
}
