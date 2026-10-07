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

## v0.13.1 pipeline runs — 2026-10-07

PASS: full regression 607 tests / 55 files, source/test types, ESLint, production build and formatting. Nine new job tests cover a real mock-provider documentary checkpoint with no approvals/downstream generation, active replay, CLI exclusion, another server's unverified ownership, durable old receipts, stale input, invalid requests, redacted failure state, corrupt/empty journal pointers, unsafe output junctions and HTTP capability/Origin plus restart persistence.

PASS: Chrome displays v0.13 and the new Overview panel against real projects without starting generation. In-app browser against a separate root and mock providers: keyboard Run, disabled Starting state, Failed state with log when the test server lacked its prompt working directory, successful new run after correcting the working directory, automatic WAITING_REVIEW, disabled duplicate Run, expandable log, material refresh showing saved research and no downstream artifacts, and page reload preserving the same checkpoint. No real project content was changed. Captured browser error/warning log empty.

PASS: DOM overflow checks at actual 320 and 1800 CSS pixel widths; long signature wraps and controls stack at 320; override reset. Screenshot capture worked in the in-app browser and the checkpoint/log plus narrow layout were visually inspected. Chrome screenshot capture was not retried. Final browser bundle: 271714 bytes, +3902 over 267812 baseline, within the increment's 10KB budget.

UNVERIFIED: paid/live provider execution, full browser approval/Resume (outside 13.1), real touch device, screen reader, field performance, actual process-kill/power-loss recovery and Chrome screenshot appearance. The server's shutdown waits for active jobs; no cancellation or automatic ownership recovery is provided. No commit or push performed.

Retina follow-up: source inspection confirms Flow uses DOM nodes and SVG edges rather than an HTML canvas bitmap. No resolution-dependent bitmap asset was found in the workspace UI. The design-system map now explicitly requires CSS-pixel layout/input coordinates, vector rendering, high-density raster sources when introduced, and DPR-aware backing stores for any future HTML canvas. DPR 1/2/3 rendering, mixed-density monitor movement and native Retina hardware are UNVERIFIED; viewport-only checks above do not cover those cases. No rendering-code change was necessary from this inspection.

21:9 follow-up: required checks recorded for 2560x1080 and 3440x1440 CSS pixels, independently of Retina DPR. Full-width Flow behavior, trace layout and readable text widths at these dimensions remain UNVERIFIED. This commit records the requirement without claiming an ultrawide rendering fix.

## v0.13.2 Research review — 2026-10-07

PASS: full regression 619 tests / 56 files, source/test TypeScript checks, full ESLint, production build and formatting. Twelve review tests cover exact candidate/input/snapshot binding, rejection reasons and preservation, durable replay, crash reconciliation before/after journal update without duplicate events, historical approvals after candidate changes, corrupt/inconsistent receipts and ledgers, shared CLI ownership, legacy checkpoints and protected HTTP routes. Windows transient atomic-rename sharing failures now receive bounded retries without deleting the destination or relaxing ownership.

PASS (in-app browser, isolated mock-provider data root): keyboard Approve, visible busy state, Reject with an empty reason and focus/aria-invalid feedback, successful rejection with reason, focus on the recorded result, persistence after page reload and no automatic continuation. Sources/evidence, raw candidate and identity disclosures were opened. Mock provider output is explicitly identified as demo data. No real project content was changed. Captured error logs were empty. Screenshot capture worked and the rendered review result was inspected.

PASS (actual measured CSS viewports): review at 320x900, 2560x1080 and 3440x1440 without document horizontal overflow. Review content remains capped at 940 CSS pixels. Flow and Fit were exercised at both ultrawide sizes: Flow widths 2221.25 and 3101.25 CSS pixels, removing the former 1700px workspace cap for Flow only. The graph and controls were visually inspected; temporary viewport overrides were reset. This supersedes the earlier unverified ultrawide layout item.

Final browser bundle: 277582 bytes, +5868 over 271714, within the increment's 10KB budget. No dependency was added. Main viewer on port 4311 was restarted with the final build.

UNVERIFIED: Retina DPR 2/3 or real hardware (browser measured DPR approximately 0.8), screen reader, real touch devices, field performance, paid/live providers and actual power-loss recovery. Lost-response UI retry was not induced live; durable identical-request replay is covered by tests. Browser Resume and reviews for other pipeline stages are outside this increment. No commit or push performed.
