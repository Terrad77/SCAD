# Workspace design system

Intent: a local documentary author's home screen for finding saved projects and entering existing read-only inspection tools. No account or cloud integration is implied.

Foundation: installed React/TypeScript with owned native HTML controls and existing CSS tokens. No new dependencies or fonts. System text provides clear reading rhythm; project titles use 18px, page introduction 30px/25px. Dense project rows support comparison rather than decorative metric cards.

Tokens: paper #f7f7f2, surface white, text #1d2925, secondary #65716a, action/focus #155c49, borders #dce2da (structural) and #85938a (input). Error #a13929, warning #835900. Spacing 6/12/18/22/28px; fields 5px radius, grouped list 8px. No motion, elevation or theme switch required.

Ownership: WorkspaceHome owns search and list/feedback states; viewer owns API requests, navigation and request identity guards. Real project values are escaped by React. Loading is busy/status; errors retain a retry control; empty data explains CLI creation; empty search offers clear. Account controls are omitted because no authentication backend exists.

Responsive: project rows stack below 700px, search expands, sidebar projects scroll locally, all primary actions at least 44px. Logical DOM order preserved. Skip link targets content; headings and labels remain visible. Existing project sections and Flow retain their behavior.

Budget: baseline browser bundle 253393 bytes; target delta below 10KB raw. No images, remote assets or animation dependencies. Field performance and assistive technology behavior require separate measurement.

Project creation: an inline form above the project list uses the existing surface, border, action and focus tokens. Visible labels, adjacent validation, status announcements and cancel focus return are required. Two stacked fields remain usable on narrow screens. Server ownership and request receipts protect writes; UI state only controls presentation.

Project details: Overview reuses the stacked inline form and existing tokens. A read-only research question has explanatory text when materials exist. Validation, busy state, persistent errors, safe retry and cancel focus return follow the creation form. No new dependency or motion is introduced.

Pipeline runs: a compact bordered panel in Overview separates the explicit action, live status and collapsible chronological log. Existing semantic tokens, system text and 44px controls apply. Long event content wraps; log overflow stays local. The panel owns polling and request identity; server ownership and journals determine execution. No animation or new package. Increment bundle budget: less than 10KB over 267812 bytes.

Retina / high-density displays: layout, pointer coordinates and breakpoints use CSS pixels independently of devicePixelRatio. Current Flow nodes are DOM text and edges are SVG, so they use browser vector rendering without a bitmap backing-store multiplier. Preserve native text rendering and vector assets; do not force pixelated image rendering. Future raster assets require appropriate srcset/sizes or 2x/3x sources. Any future HTML canvas must size its backing store from measured CSS size multiplied by devicePixelRatio, keep interaction coordinates in CSS pixels, and update on container resize or display-density changes.

High-density verification gate: inspect text, SVG edges, borders, focus rings and drag/zoom at DPR 1, 2 and 3; cover both narrow and wide CSS viewports and browser zoom. A high screen resolution alone does not prove Retina support. Native Retina hardware and explicit DPR emulation remain unverified; current browser viewport tooling changes dimensions, not devicePixelRatio.

Ultrawide 21:9 requirement: use available horizontal space for the evidence Flow workspace while retaining readable line lengths for forms and narrative text. Required viewport probes are 2560x1080 and 3440x1440 CSS pixels, with DPR checked separately. Check navigation, trace sidebar, Flow fit/zoom, long labels and absence of accidental page overflow. These ultrawide probes are not yet verified; the existing workspace max-width may need a focused follow-up before claiming full-width Flow support.

Research review: the existing run panel contains a separate semantic review section with summary, source/evidence and complete raw-candidate disclosures. Native controls reuse action, error and focus tokens; decision feedback distinguishes historical consent from current content. Review reading width is bounded to 940 CSS pixels. Flow alone removes the workspace maximum width on ultrawide displays; other content retains its existing limits. No raster assets, dependencies or motion added. Increment bundle baseline 271714 bytes; budget delta below 10KB.

Resume extension (v0.13.3): Research review owns explicit continuation admission and immutable retry identity; ProjectRunPanel owns subsequent status polling and focus. Native English button with disabled/busy state, adjacent persistent alert, and parent link in the run journal. Reuse existing semantic colors, 44px controls, bounded review width and mobile wrapping. No new motion/dependency; incremental browser bundle budget remains 10KB.
