/**
 * Minimal HTML → plain-text extraction. SCAD intentionally does NOT use a
 * browser or crawler; this strips markup enough to feed evidence extraction.
 * It is deliberately conservative: blocks (script/style/head) are removed,
 * tags are dropped and common entities are decoded.
 */

const BLOCK_TAG_RE = /<(script|style|head|noscript|svg|iframe|template)\b[\s\S]*?<\/\1\s*>/gi

export const ENTITY_MAP: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
  "#x27": "'",
  "#quot": '"',
  "#amp": "&",
}

/** Decodes common HTML entities (named and numeric) into plain characters. */
export function decodeHtmlEntities(text: string): string {
  const named = text.replace(/&([a-zA-Z#x0-9]+);/g, (match, name: string | undefined) => {
    if (!name) return match
    const decoded = ENTITY_MAP[name.toLowerCase()]
    if (decoded !== undefined) return decoded
    if (name.length > 1 && name.startsWith("#")) {
      const hex = name.startsWith("#x") || name.startsWith("#X")
      const digits = name.slice(hex ? 2 : 1)
      const code = Number.parseInt(digits, hex ? 16 : 10)
      if (Number.isNaN(code) || code < 0 || code > 0x10ffff) return match
      try {
        return String.fromCodePoint(code)
      } catch {
        return match
      }
    }
    return match
  })
  return named
}

/** Extracts readable text from an HTML document, collapsing whitespace. */
export function extractPlainText(html: string): string {
  if (typeof html !== "string" || html.length === 0) return ""
  const withoutBlocks = html.replace(BLOCK_TAG_RE, " ")
  const withoutTags = withoutBlocks.replace(/<[^>]*>/g, " ")
  return decodeHtmlEntities(withoutTags).replace(/\s+/g, " ").trim()
}

/** Best-effort `<title>` extraction for source metadata. */
export function extractTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (!match) return undefined
  const title = decodeHtmlEntities(match[1]!).replace(/\s+/g, " ").trim()
  return title.length > 0 ? title : undefined
}
