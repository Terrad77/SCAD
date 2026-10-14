# Completion TODO

Baseline: main b0e9bb9 (v0.13.3). Existing untracked brandsans/ is unrelated and retained.

- [x] Read repository guidance and current workflow specs. The original Downloads specifications are unavailable; existing versioned docs define the implemented contracts.
- [x] Implement browser review and explicit continuation for all nine pipeline stages; all-stage execution covered by the mock integration test.
- [x] Bind each checkpoint to actual consumed dependencies and current human upstream approvals.
- [x] Preserve durable decisions/replay, rejected candidates and production write isolation.
- [x] Present full candidates, upstream material and explicit audit FAIL/UNKNOWN independently of consent.
- [x] Test all stages end to end, drift, interrupted decisions and HTTP protections.
- [x] Run full regression, types, lint, formatting and production build: 643 tests / 58 files PASS.
- [x] Complete supported browser pre-flight: Chrome on 4311, Claims rejection, SelfCheck approval and explicit final Resume to Completed, Script/Shots navigation, mobile/ultrawide layout and screenshot inspection. See workspace-preflight.md for exact scope.

Remaining verification gates (not claimed complete): native Retina DPR 2/3, screen reader, real touch device, live providers, field performance and real power-loss recovery. Two clearly named MOCK verification projects are retained for review; existing project content was not changed. Agent-created Chrome navigation remains blocked, while the manually opened SCAD tab is usable.

Future capabilities proposed in youtube-publishing-requirements.md (publication packaging and optional video analysis) are separate extensions. No upload, cloud accounts, Supabase, new provider purchases or automatic approvals are authorized by this implementation plan. Human review remains a real user action. No commit/push without an explicit request.
