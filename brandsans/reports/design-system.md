# Design system and verification contract

Intent: a designer evaluates actual BrandSans outlines, spacing and supported characters, then downloads usable font files. This is a specimen tool; sample phrases are editable specimen content, not product claims.

Foundation: React 19.3.0, TypeScript 5.9.3, Vite 7.3.6; native form elements and owned CSS, no UI, animation or icon suite. Independent package; existing SCAD files are outside the implementation scope.

Typography: BrandSans for specimens and headings; Arial/system sans for controls so unsupported scripts and technical metadata stay legible. Editorial scale exposes geometry while body labels keep a conventional reading rhythm.

Color: warm paper #eeeeea, ink #20211f, secondary text #5c5e57, dark comparison surface #242620, accent #b42a18, focus #174ac2. Red is an identity accent, never the sole indication of an error or selection.

Composition: open, asymmetric introductory specimen, a horizontal tool strip, dark weight comparison and dense glyph grid. Hairlines organize comparisons rather than card decoration. No stock imagery is needed: the actual font is the visual subject.

Components/states: native buttons for weight and category selection expose aria-pressed; range inputs have labels and outputs; checkbox toggles kern; textarea preserves user input, supports empty state and unsupported-character feedback. Font loading has loading/ready/error and retry. Downloads are real anchors. Glyph inspector updates from selected Unicode data. All controls retain visible focus.

Responsive contract: fluid main width capped at 1600px, ~5% gutters; two-column sections collapse below 760px; glyph inspector moves above the grid below 400px; controls wrap and all content remains in DOM order. Touch controls target >=44px. Sticky inspector is confined to its section.

Motion: only color/background transitions, 120ms, enabled under prefers-reduced-motion: no-preference. No scroll interception or animated content. Light specimen and fixed dark comparison are intentional surfaces, not a theme toggle.

Performance budget: initial gzip JS <100KB, CSS <5KB, two WOFF2 combined <40KB. Both font weights are essential to the specimen, preloaded locally. No remote runtime requests, media or analytics. Field Core Web Vitals are unverified because this is a local demo.

Verification evidence lives in validation.json, browser-validation.json and preflight.md. OS installation, physical mobile devices, print output, screen-reader certification and cross-browser coverage require additional verification; no universal production certification is claimed.

Revision 1.100: expanded capitals and digits, flat shoulders, compact corner radii, square terminals and a horizontal S. Lowercase expansion is moderated to preserve reading rhythm. The isolated S now demonstrates the decisive form. Heading sizes were retuned for the wider outlines; responsive gates must be rerun with the new actual WOFF2 files.

Revision 1.200: 76 Cyrillic letters for Russian, Ukrainian and Belarusian plus the numero sign. Keep the prior Latin outlines, metrics and 220 pair values byte-equivalent at the glyph-data level; extend GPOS to cyrl. The tester now opens with Russian sample text, offers Russian/Ukrainian/Belarusian presets, and filters Latin/Cyrillic separately. Missing-character feedback remains useful for unsupported scripts. Font budgets remain two WOFF2 files under 40KB combined.
