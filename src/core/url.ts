/**
 * Core URL normalization. Provider-neutral, so both the search layer and the
 * content layer canonicalize URLs identically without importing each other.
 */

/** Query parameters that are pure tracking noise and can be dropped safely. */
const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "fbclid",
  "gclid",
  "gclsrc",
  "dclid",
  "msclkid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "_hsenc",
  "_hsmi",
  "ref",
  "source",
  "spm",
  "sc_campaign",
  "sc_channel",
])

function stripTrailingSlash(path: string): string {
  if (path.length <= 1) return path
  return path.replace(/\/+$/, "")
}

/**
 * Deterministically normalizes a URL:
 * scheme+host lowercased, fragment removed, tracking parameters dropped,
 * duplicate-resolving query parameters removed, trailing slash trimmed.
 * Returns an empty string for clearly invalid URLs.
 */
export function normalizeUrl(raw: string): string {
  const trimmed = (raw ?? "").trim()
  if (trimmed === "") return ""
  try {
    const url = new URL(trimmed)
    url.protocol = url.protocol.toLowerCase()
    url.hostname = url.hostname.toLowerCase()
    url.hash = ""

    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key.toLowerCase())) url.searchParams.delete(key)
    }

    const out = new URL(url.toString())
    out.pathname = stripTrailingSlash(out.pathname)
    // Remove obvious duplicate-value query params (e.g. ?id=1&id=2 keeps the first).
    const seen = new Set<string>()
    for (const key of [...out.searchParams.keys()]) {
      if (key in seen) {
        out.searchParams.delete(key)
        continue
      }
      seen.add(key)
    }

    return out.toString().replace(/\/$/, "")
  } catch {
    // Not parseable as a URL — strip fragments and trailing slashes textually.
    const noFragment = trimmed.split("#")[0] ?? ""
    return noFragment.replace(/\/+$/, "")
  }
}

/** Best-effort canonical identity of a URL after normalization. */
export function canonicalUrl(raw: string): string {
  return normalizeUrl(raw)
}
