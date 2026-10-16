# Workspace pre-flight

## v0.13.6 Chrome follow-up — 2026-10-16

PASS (Chrome on main 4311): after restarting the stopped viewer, inspected ten MOCK run records, SelfCheck approval note, parent ID, candidate/dependency/input signatures and four saved events. Enter opens History and native disclosures. Explicit refresh returns focus to the status paragraph with the dark focus outline. Read-only e2e-v06 navigation shows the empty browser-history explanation; returning to the MOCK project restores its ten entries. Screenshot scad-run-history.png was saved and visually inspected. No project content or approval changed; generation was not started. Captured warning/error log empty.

PASS (actual DOM measurements): 319x900 CSS pixels, history approximately 265px wide and refresh control approximately 44px high, document scrollWidth 297px; 3441x1440, history approximately 940px wide, scrollWidth 3418px. No document horizontal overflow. Temporary overrides reset. DPR remains approximately 0.667; Retina DPR 2/3, touch and screen reader remain unverified. Live older-page/error/retry and late-response UI paths remain unverified; their backend contracts have automated coverage. This closes the earlier Chrome-connection/visual-history blocker within the stated scope.

Connection fix: Chrome request diagnostics demonstrated a genuine user-triggered top-level navigation with Sec-Fetch-Site cross-site, mode navigate, destination document and user ?1. The server previously rejected this harmless workspace entry. A narrow exception now allows only GET / with those navigation headers, while retaining Host and Origin checks. Cross-site API requests, non-navigation cross-site requests and all write/approval protections remain denied. Focused history/server suites pass 17 tests / 2 files, including the root entry and cross-site API checks. Final full regression: 657 tests / 60 files PASS; source/test types, full lint, full formatting and build PASS. The fixed page opens in Chrome. No commit or push performed.

## v0.13.6 browser run history — 2026-10-15

PASS: full regression 657 tests / 60 files, source/test TypeScript, full ESLint, full Prettier and production build. Seven new history tests cover stable cursor pagination across insertion, raw journal byte preservation, continuation/decision retention, active ownership versus another instance, missing parents, corrupt/cross-project records, empty history, invalid cursors/latest pointers, file-count bounds, local HTTP session/Origin/method protection and restart persistence. No new execution, approval or write path was added.

PASS (live API, main 4311): updated server returns HTTP 200 for the existing explicitly MOCK SelfCheck project. Ten retained runs are shown; the newest is COMPLETED, nine have parent links and nine have recorded decisions. This check reads journals without starting generation, changing project content or treating fixture decisions as real editorial authority. Owner/admission fields are omitted from history responses.

PASS: browser bundle 287971 bytes versus 282967 baseline (+5004), within 10KB. Warm tokens, native disclosures, wrapped identifiers, 940px reading width and 44px controls reused. No dependency, animation, raster or font added. Existing server/main project data retained; unrelated brandsans folder untouched.

UNVERIFIED: live rendered timeline, disclosure/keyboard focus, responsive mobile/ultrawide layout, UI errors/pagination/late-response navigation and screenshot visual review for this increment. Chrome is absent from the available MCP browser inventory (only in-app and MCP Apps browsers are connected); the user was asked to connect Chrome with main SCAD on 4311. No fallback browser or secondary port was used. Earlier Chrome checks do not validate the new timeline. Retina DPR 2/3, real touch/screen reader, field performance and power-loss recovery remain unverified. The browser pre-flight item stays open. No commit/push performed.

## v0.13.5 local review exports — 2026-10-14

PASS: full regression 650 tests / 59 files; source/test TypeScript, full ESLint, full Prettier and production build. Seven export tests cover exact raw UTF-8 preservation without writes, knowledge/reference retention, missing/invalid material, stale requests, incomplete publication refusal, preserved FAIL, input bounds, session/Origin/method protection and stale HTTP requests. Initial test fixture used an invalid constraint treatment; corrected to the real schema without relaxing validation. Root formatting needed normal filesystem access because the sandbox could not traverse an ignored brandsans subdirectory. No brandsans file changed.

PASS (Chrome on 4311, MOCK project): keyboard requested both Markdown and JSON downloads, visible preparation disabled both buttons, success remained explicitly phrased as requested. Both files appeared in Downloads. Comparing the downloaded JSON with the saved project found all 11 present allowlisted raw files equal; missing files remain null. The saved WARN verdict and script SPECULATION label survived. The MCP download-event wait timed out despite the file being saved; actual local file presence/content provides the download evidence. Navigation, Overview and export screenshot visually inspected; no generation or project content mutation.

PASS (DOM layout): at actual 319x900 CSS pixels, panel approximately 265px wide, stacked buttons approximately 226px wide and 44px high; document scrollWidth 297px, no horizontal overflow. Temporary viewport reset. Final browser bundle 282967 bytes versus 279973 baseline (+2994), within 10KB; no new dependency, font, raster asset or motion.

UNVERIFIED: induced live export failure/drift/retry and interrupted-response navigation, large browser downloads, actual Retina DPR 2/3, touch devices, screen reader and field performance. Error/blocked/retry paths are implemented; backend failure contracts are automated-test evidence, not live browser observations. No backup import, selected-revision publication package, upload or new generation implemented. No commit/push performed for this increment.

## Warm palette extension — 2026-10-14

PASS: user reference neutrals applied to shared CSS tokens, forms, navigation, feedback, nodes, grid and SVG edges/arrowheads. #FE5000 is the primary action fill and selection accent; links use a dark orange variant. Main Chrome viewer on 4311 was rebuilt/restarted and its computed paper/accent/node/edge values match the new tokens. Overview and Flow screenshots were saved and visually inspected; Fit and section navigation work. Keyboard Tab showed the dark #3E332C focus ring. Captured browser warning/error logs were empty.

PASS: calculated WCAG luminance ratios: body text/paper 10.35:1, secondary text/paper 5.66:1, links/paper 4.81:1, dark text/orange action 5.03:1, input boundary/surface 5.73:1, node boundary/surface 3.83:1, error text/error surface 6.35:1 and warning text/warning surface 6.85:1. Sidebar secondary text uses the darker focus token rather than the lower-contrast general secondary token. Hover/active actions retain dark text on bright orange variants. Status labels remain visible independently of color.

PASS: source/test types, full ESLint, production build, affected-file formatting and git diff whitespace check. Relevant existing suites: 56 tests / 7 files PASS (workspace, creation, run/review/checkpoint workflow and Flow). No new tests for token substitutions, dependencies, fonts, raster assets or animation. Browser bundle 279973 bytes, +112 over the preceding 279861 build. Initial sandbox builds/tests could not read an ancestor directory; the same checks passed with normal filesystem access.

PASS (DOM measurements): actual widths 319 and 3441 CSS pixels without page horizontal overflow; Flow widths approximately 265 and 3121 pixels respectively, temporary viewport reset. Native Retina DPR 2/3, touch and screen reader remain UNVERIFIED. Narrow full-page screenshot output was scaled/cropped inconsistently by the capture tool and is not used to certify mobile appearance. Main wide screenshots are the visual evidence. No project content, commit or push changed by this palette extension.

## v0.13.4 complete checkpoints — 2026-10-14

PASS: full regression 643 tests / 58 files, source/test TypeScript checks, full ESLint, Prettier and production build. Eleven new workflow tests cover all nine mock stages through explicit review/resume and final export, consumed dependency signatures, upstream human approval drift, candidate byte preservation, rejection, interrupted decision reconciliation, cross-stage receipt forgery, malformed preparation and protected HTTP review routes. Every SelfCheck check ID/status is included in the readable summary. The full suite ran with two workers after concurrent load exposed existing default-timeout failures; runtime admission and approval requirements were not relaxed.

PASS (Chrome, main viewer on 4311, clearly named MOCK fixtures): Claims empty-reason validation with textarea focus and aria-invalid, keyboard rejection with retained candidate and no Resume, persisted SelfCheck approval across server/page restart, visible WARN and individual UNKNOWN findings, keyboard final Resume with disabled busy state and completion focus. The final child log contains explicit continuation and pipeline completion only, with no generation events. Refresh loads the production manifest; Script and Shots show saved materials. Approval does not alter the audit Warning. The final mock continuation reuses saved candidates; paid provider execution was not tested. Existing user project content was not changed. Two MOCK projects are retained for inspection. Captured warning/error console log was empty.

PASS (layout and visual inspection): actual measured CSS viewports 319x900, 480x1350, 2560x1080 and 3441x1440 without document horizontal overflow; review width capped at approximately 940 CSS pixels, large raw JSON scrolls locally. Temporary viewport overrides were reset. Chrome screenshot capture now works; Claims rejection and Completed with retained Warning were saved and visually inspected. This supersedes the earlier screenshot/runtime blockers for this increment. Agent-created navigation still returns ERR_BLOCKED_BY_CLIENT; claiming the manually opened SCAD tab works. The cause of that navigation restriction is not established.

PASS: no new dependencies, remote fonts, assets or animation. Final browser bundle 279861 bytes versus 278914 baseline (+947, within 10KB). The unrelated untracked brandsans demo is excluded from SCAD lint/format traversal; its files were not changed.

UNVERIFIED: Retina DPR 2/3 and native hardware (Chrome measured DPR approximately 0.667), screen reader, real mobile/touch, live providers, field performance and actual power-loss recovery. Mobile widths are measured CSS sizes, not proof of native Retina behavior. Lost-response UI retry and every intermediate stage's rendered browser interaction were not exercised live; durable replay and all-stage completion are covered by automated tests. No commit or push performed for this increment.

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

## v0.13.3 explicit Research continuation - 2026-10-09

PASS: 632 tests / 57 files after synchronization fixes; source/test TypeScript, full ESLint, production build and full Prettier. Thirteen new continuation tests cover real Research-to-Claims checkpoint behavior, parent history, byte preservation of Research and approval, durable cross-instance and cross-operation replay conflicts, active/interrupted execution with no automatic relaunch, rejected/undecided/legacy/drifted checkpoints, missing completion receipt, shared ownership and protected HTTP routes.

Initial full regression exposed a test admission race (WAITING_REVIEW becomes visible just before ownership release) and a child-process test exceeding the default 5s runner timeout. Review/resume setup now explicitly waits for ownership release; the subprocess test runner allows 15s around its existing 10s child timeout. Runtime ownership is unchanged. Final full regression passed.

PASS: no new dependencies or animation. Browser bundle 278914 bytes versus 277582 baseline (+1332), within the 10KB increment budget. Updated viewer on port 4311 returned HTTP 200 and served the Resume UI bundle; HTTP verification did not run generation against real project data.

UNVERIFIED: rendered browser/keyboard/responsive pre-flight for the new action. MCP could not initialize its browser runtime (sandbox setup refresh failure; reset and retry also failed). No screenshot, visual or keyboard claim is made for this increment. Previous v0.13.2 mobile/ultrawide results are historical, not a new validation. Retina DPR 2/3, real hardware/touch, screen reader, paid/live providers, field performance and power-loss durability remain unverified. Browser gate stays open in TODO-v0.13.3.md. No commit or push performed.
