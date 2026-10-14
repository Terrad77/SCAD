# v0.13.5 local review exports

- [x] Define read-only export scope and snapshot identity contract.
- [x] Implement version-bound Markdown script and raw JSON snapshot export.
- [x] Add English download UI with loading/error/empty/blocked states and cleanup.
- [x] Verify raw preservation, drift, invalid files, bounds and HTTP protection.
- [x] Run types, lint, formatting, tests and build: 650 tests / 59 files PASS.
- [x] Inspect downloads and navigation in Chrome on 4311; document actual evidence in workspace-preflight.md.

Scope: local review copies of the displayed saved snapshot, including audit/freshness qualifications. No new generation, file mutation, approval, restorable backup, selected-revision publication package, upload, final chapter timings, subtitles, cloud or Supabase integration. Future publication packaging remains separately scoped. No commit/push without an explicit request.
