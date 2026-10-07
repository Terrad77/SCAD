# Workspace design system

Intent: a local documentary author's home screen for finding saved projects and entering existing read-only inspection tools. No account or cloud integration is implied.

Foundation: installed React/TypeScript with owned native HTML controls and existing CSS tokens. No new dependencies or fonts. System text provides clear reading rhythm; project titles use 18px, page introduction 30px/25px. Dense project rows support comparison rather than decorative metric cards.

Tokens: paper #f7f7f2, surface white, text #1d2925, secondary #65716a, action/focus #155c49, borders #dce2da (structural) and #85938a (input). Error #a13929, warning #835900. Spacing 6/12/18/22/28px; fields 5px radius, grouped list 8px. No motion, elevation or theme switch required.

Ownership: WorkspaceHome owns search and list/feedback states; viewer owns API requests, navigation and request identity guards. Real project values are escaped by React. Loading is busy/status; errors retain a retry control; empty data explains CLI creation; empty search offers clear. Account controls are omitted because no authentication backend exists.

Responsive: project rows stack below 700px, search expands, sidebar projects scroll locally, all primary actions at least 44px. Logical DOM order preserved. Skip link targets content; headings and labels remain visible. Existing project sections and Flow retain their behavior.

Budget: baseline browser bundle 253393 bytes; target delta below 10KB raw. No images, remote assets or animation dependencies. Field performance and assistive technology behavior require separate measurement.

Project creation: an inline form above the project list uses the existing surface, border, action and focus tokens. Visible labels, adjacent validation, status announcements and cancel focus return are required. Two stacked fields remain usable on narrow screens. Server ownership and request receipts protect writes; UI state only controls presentation.

Project details: Overview reuses the stacked inline form and existing tokens. A read-only research question has explanatory text when materials exist. Validation, busy state, persistent errors, safe retry and cancel focus return follow the creation form. No new dependency or motion is introduced.
