# BrandSans web assets

SCAD uses the original BrandSans 1.200 Regular (400) and Medium (500) WOFF2 files,
copied without modification from `brandsans/fonts/`. The source package, generator,
TTF desktop fonts, standalone demo and validation reports stay in `brandsans/`.
Keep `OFL.txt` with redistributed fonts. Do not replace the font source project with
this runtime subset.

`npm run build` copies only these two WOFF2 files and the license into
`dist/ui/fonts/brandsans/`. The local viewer exposes the exact allowlisted
`/fonts/brandsans/` URLs; this is a custom Node viewer, not Vite's automatic public
directory. No CDN or remote font service is used.

Both weights use font-display: swap and no synthesized bold/italic. Latin,
Russian/Ukrainian/Belarusian letters and supported punctuation/currency symbols
use BrandSans (321 codepoints, including 76 Cyrillic letters and the numero sign).
The full Unicode Cyrillic block is not covered; unsupported scripts and combining
marks use the system fallback. Code and identifiers stay monospaced. This does
not change the English interface language.

When updating the source fonts, explicitly copy the new WOFF2 files and license
here, rebuild, and repeat browser reflow/load/fallback checks. Do not copy the
entire source/demo project into public/.
