# v0.13.6 browser run history

- [x] Inspect durable run storage and define read-only timeline scope.
- [x] Add bounded paginated history API with identity/path/session protections.
- [x] Add English timeline, parents, recorded decisions/events, loading/empty/error and keyboard feedback.
- [x] Verify pagination, read-only preservation, ownership, invalid journals and HTTP restart behavior.
- [x] Run regression, types, lint, formatting and production build: 657 tests / 60 files PASS.
- [x] Follow-up 2026-10-16: inspect main Chrome UI, disclosure/refresh focus, empty history and mobile/ultrawide DOM layout; screenshot saved and visually checked. Live older-page/error/retry paths remain unverified; see pre-flight.
- [x] Record pre-flight evidence; main 4311 API returns the retained ten-record MOCK continuation chain without writes.

No new generation, review/resume actions, approval authority, cancellation, journal recovery/deletion, publication packaging, cloud or Supabase. Journals are historical observations, not revalidated approval receipts. No commit/push without an explicit request.
