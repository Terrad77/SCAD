import { renderScript } from "../core/documentary.js"
import type { ProjectView } from "./project-reader.js"
import { ViewerError } from "./project-reader.js"

export type ExportFormat = "script" | "snapshot"
export type ProjectExport = { filename: string; mime: string; content: string }

/** Local review copies only; never confers approval or publication authority. */
export function buildProjectExport(
  view: ProjectView,
  raw: Record<string, string | null>,
  format: ExportFormat,
): ProjectExport {
  if (view.production.publication === "PUBLISHING")
    throw new ViewerError(409, "PUBLISHING", "Finish the pending publication before exporting")
  if (Object.values(view.files).some((f) => ["CORRUPT", "UNREADABLE"].includes(f.status)))
    throw new ViewerError(
      409,
      "EXPORT_INVALID",
      "Some files failed validation. Refresh and inspect their status before exporting.",
    )
  const filename = "scad-" + view.id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80)
  const freshness =
    view.production.freshness?.artifacts.map((a) => ({
      artifact: a.artifact,
      status: a.status,
      reason: a.reason ?? null,
    })) ?? null
  const auditVerdict = view.selfCheck?.production?.verdict ?? "UNKNOWN"
  const notice =
    "Local review copy of saved materials. Not a backup, human approval or authorization to publish. Missing, stale and UNKNOWN findings remain unresolved."
  let result: ProjectExport
  if (format === "script") {
    if (!view.narrative || raw.narrative === null)
      throw new ViewerError(409, "SCRIPT_MISSING", "No valid saved script is available to export")
    // Use the original validated body, preserving all knowledge/reference fields.
    const narrative: Parameters<typeof renderScript>[0] = JSON.parse(raw.narrative!)
    result = {
      filename: filename + "-script.md",
      mime: "text/markdown;charset=utf-8",
      content: [
        "# SCAD saved script — review copy",
        "",
        notice,
        "",
        "Project: " + view.id,
        "Snapshot: " + view.readVersion,
        "Saved audit: " + auditVerdict,
        "Audit integrity: " + view.production.auditIntegrity,
        "Freshness: " +
          (freshness?.map((a) => a.artifact + "=" + a.status).join("; ") || "UNKNOWN"),
        view.production.notice ?? "",
        "",
        "---",
        "",
        renderScript(narrative),
      ].join("\n"),
    }
  } else {
    result = {
      filename: filename + "-snapshot.json",
      mime: "application/json;charset=utf-8",
      content:
        JSON.stringify(
          {
            schema: "scad.review-export.v1",
            project: view.id,
            readVersion: view.readVersion,
            notice,
            files: view.files,
            production: { ...view.production, freshness },
            savedAuditVerdict: auditVerdict,
            // Raw UTF-8 file contents are strings, not schema-reconstructed artifacts.
            // Excludes run receipts, approvals, credentials and arbitrary filesystem files.
            rawFiles: raw,
          },
          null,
          2,
        ) + "\n",
    }
  }
  if (Buffer.byteLength(result.content) > 24 * 1024 * 1024)
    throw new ViewerError(413, "EXPORT_TOO_LARGE", "Review export exceeds the 24 MB download limit")
  return result
}
