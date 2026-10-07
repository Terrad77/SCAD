# Workspace pre-flight

- PASS: production build, source/test TypeScript checks, full lint and formatting (plus affected-file rechecks after focus/recovery changes).
- PASS: existing suite 572 tests / 49 files; new workspace state suite 4 tests separately. Loading, error recovery markup, empty real data, safe project/error text verified by server rendering tests.
- PASS: browser real project list, empty search, clear search with focus returning to input, opening existing project and returning home. No captured console errors.
- PASS: keyboard Tab reaches skip link; Enter moves focus to content. Visible field labels, heading hierarchy, buttons and status announcements inspected through accessibility tree. Focus outline defined in shared CSS.
- PASS: DOM overflow checks at actual browser widths 450, 960, 1800 CSS pixels. Mobile rows switch to column. Requested override sizes were scaled by host; these are actual measured widths.
- PASS: no animation introduced; content and feedback do not depend on motion. No new dependency, remote font, image or account integration. Browser bundle baseline 253393 bytes, initial implementation 257200 bytes (focus/recovery follow-up adds a small amount).
- UNVERIFIED: rendered visual/screenshot inspection: MCP screenshot APIs returned Unable to capture screenshot. Real phone/touch, exact 320/360px, screen reader, zoom, automated accessibility scan and field performance were not checked.
- UNVERIFIED: real API failure/loading/empty-root UI recovery; these states are covered by component rendering tests, not an induced live server failure.

Scope: local read-only home screen, not authenticated account management. Existing project API and Flow are retained. Visual/mobile/accessibility readiness remains partly unverified due to the listed gates. No deployment, commit or push performed.
## Project section extension

The same foundation now applies to Overview, Script, Shots, Audit, History and Flow. A selected section is identified with aria-current and visible border/text treatment. Each section has an explanatory heading. Mobile navigation uses three flexible columns; the summary stacks and Flow search fills its container. No new animation, data mutation or dependency was introduced.

Verification: production build, full lint, formatting and source/test types PASS. All six section transitions were exercised against real e2e-v06 files in the browser. Mobile Flow at actual 450 CSS pixels had no page overflow; navigation resolved to three columns. Browser error log empty. Screenshot capture still unavailable, so appearance and real-device/assistive-technology checks remain UNVERIFIED. Domain tests were not rerun for this CSS/section-copy extension; prior 572 tests and four workspace-state tests remain the latest test runs.

## Project creation increment — 2026-10-06

PASS: 589 tests in 53 files; production build, source/test type checking, ESLint and Prettier. Creation tests cover durable replay, content conflicts, Trash/restore replay, validation, existing targets, interrupted receipts, shared CLI ownership and HTTP capability/Origin/body limits.

PASS (browser functional checks): separate data root on port 4312; empty workspace, New project, both required-field errors with focus, keyboard submission, pending state, successful creation and automatic project opening, list return, cancellation and trigger focus restoration. Stopping the test server produced a visible connection error, retained submitted values and Retry creation. No real project data was changed.

PASS (DOM layout checks): actual innerWidth 320, 450 and 1800 CSS pixels; document scrollWidth did not exceed innerWidth. The viewport override was reset. Production browser bundle: 264092 bytes versus 260726 baseline (+3366, within 10KB budget).

UNVERIFIED: screenshot-based visual review (both documented in-app screenshot APIs returned Unable to capture screenshot), screen-reader testing, real mobile device/touch and field performance metrics. These checks do not certify full accessibility or production readiness.

## Project details increment — 2026-10-07

PASS: 598 tests in 54 files, production build, source/test TypeScript checks and full ESLint. New tests cover metadata preservation, durable replay after subsequent edits, crash reconciliation, stale snapshots, shared ownership, question locking for unknown memory/output files, byte preservation, unsafe paths, invalid metadata/revision journals and HTTP protection. The existing publication test now also verifies that details cannot be edited while publishing.

PASS (Chrome functional checks): existing MotoGP-Forgeries Overview, keyboard opening with title focus, empty-title validation and focus, read-only question, Cancel and restored trigger focus. Existing project files were not changed through the browser. DOM overflow checks passed at actual widths 480 and 3480 CSS pixels; temporary viewport override reset. Captured error/warning log empty. Successful disk/HTTP saves are covered by tests, not a browser save against real projects.

Production browser bundle: 267812 bytes (+3720 versus creation, +7086 versus 260726 baseline), within the 10KB budget. UNVERIFIED: screenshot visual review (Chrome capture timed out; earlier captures produced repeated tiles), exact 320px layout, real touch/mobile device, screen reader and field performance. No commit or push performed.
