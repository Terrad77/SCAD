import React, { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import coverage from "./coverage.json"
import "./style.css"

type Weight = 400 | 500
type FontState = "loading" | "ready" | "error"
const presets = [
  { label: "Русский", text: "Форма в движении." },
  { label: "Українська", text: "Привіт, Україно! Ґанок і їжак." },
  { label: "Беларуская", text: "Жыве Беларусь! Ўзоры шрыфту." },
  { label: "Latin", text: "Form in motion." },
  { label: "Kerning pairs", text: "ТА То Га УА / AV To WA" },
  { label: "Latin & currency", text: "ÀÉÎÖÜ ÇÑ æœ ß · € $ £ ¥ ₽ ₴ ₹ ₿" },
]
const supported = new Set(coverage.codepoints.map((item) => item.character))
function App() {
  const [text, setText] = useState(presets[0].text)
  const [weight, setWeight] = useState<Weight>(400)
  const [size, setSize] = useState(92)
  const [tracking, setTracking] = useState(0)
  const [kern, setKern] = useState(true)
  const [fontState, setFontState] = useState<FontState>("loading")
  const [attempt, setAttempt] = useState(0)
  const [group, setGroup] = useState("All")
  const [selected, setSelected] = useState("A")
  useEffect(() => {
    let active = true
    setFontState("loading")
    const loading =
      attempt === 0
        ? Promise.all([
            document.fonts.load("400 24px BrandSans"),
            document.fonts.load("500 24px BrandSans"),
          ])
        : Promise.all(
            ([400, 500] as const).map(async (w) => {
              const url = new URL(
                `fonts/BrandSans-${w === 400 ? "Regular" : "Medium"}.woff2`,
                document.baseURI,
              )
              const face = new FontFace("BrandSans", `url("${url.href}")`, {
                weight: String(w),
                style: "normal",
                display: "swap",
              })
              await face.load()
              if (active) document.fonts.add(face)
              return [face]
            }),
          )
    loading
      .then((results) => {
        if (active) setFontState(results.every((result) => result.length > 0) ? "ready" : "error")
      })
      .catch(() => {
        if (active) setFontState("error")
      })
    return () => {
      active = false
    }
  }, [attempt])
  const normalized = text.normalize("NFC")
  const missing = [...new Set([...normalized].filter((c) => !supported.has(c) && !/\s/u.test(c)))]
  const characters = coverage.codepoints.filter((item) => {
    switch (group) {
      case "Letters":
        return /\p{L}/u.test(item.character)
      case "Latin":
        return /\p{Script=Latin}/u.test(item.character)
      case "Cyrillic":
        return /\p{Script=Cyrillic}/u.test(item.character)
      case "Numbers":
        return /\p{N}/u.test(item.character)
      case "Currency":
        return /\p{Sc}/u.test(item.character)
      case "Punctuation & symbols":
        return /[\p{P}\p{S}]/u.test(item.character)
      default:
        return true
    }
  })
  const picked = coverage.codepoints.find((item) => item.character === selected)!
  return (
    <>
      <a className="skip" href="#playground">
        Skip to type tester
      </a>
      <header className="masthead">
        <a className="wordmark" href="#">
          BrandSans
          <span className="red-dot" aria-hidden="true" />
        </a>
        <nav aria-label="Main">
          <a href="#playground">Type tester</a>
          <a href="#glyphs">Character set</a>
          <a className="download" href="./BrandSans-fonts.zip" download>
            Download family <span aria-hidden="true">↗</span>
          </a>
        </nav>
      </header>
      <main>
        <section className="intro" aria-labelledby="intro-heading">
          <div className="eyebrow">Independent type design · Version {coverage.version}</div>
          <h1 id="intro-heading">
            Precision.
            <br />
            <span>With a pulse.</span>
          </h1>
          <div className="intro-bottom">
            <p>
              An original geometric sans with broad shoulders,
              <br className="desktop-break" /> open forms, and a forward-looking rhythm.
            </p>
            <p className="family-meta">
              2 weights <span>Regular 400 / Medium 500</span>
              <br />
              {coverage.codepointCount} characters <span>Latin + Cyrillic + symbols</span>
            </p>
          </div>
          <div className="hero-specimen" aria-hidden="true">
            <span>S</span>
            <div className="measurement">
              <span>Cap height 700</span>
              <span>x-height 520</span>
              <span>Baseline 0</span>
            </div>
          </div>
        </section>
        <section className="tester" id="playground" aria-labelledby="tester-heading">
          <div className="section-head">
            <h2 id="tester-heading">Make it say something.</h2>
            <p>Live type tester</p>
          </div>
          <div className="toolbar">
            <fieldset className="weights">
              <legend>Weight</legend>
              {([400, 500] as const).map((w) => (
                <button
                  key={w}
                  type="button"
                  aria-pressed={weight === w}
                  onClick={() => setWeight(w)}
                >
                  {w === 400 ? "Regular" : "Medium"}
                </button>
              ))}
            </fieldset>
            <label className="range-field">
              Size <output>{size}px</output>
              <input
                type="range"
                min="20"
                max="160"
                value={size}
                onChange={(e) => setSize(Number(e.target.value))}
              />
            </label>
            <label className="range-field">
              Tracking <output>{tracking.toFixed(2)}em</output>
              <input
                type="range"
                min="-0.04"
                max="0.12"
                step="0.01"
                value={tracking}
                onChange={(e) => setTracking(Number(e.target.value))}
              />
            </label>
            <label className="check">
              <input type="checkbox" checked={kern} onChange={(e) => setKern(e.target.checked)} />{" "}
              Kerning
            </label>
            <button
              className="reset"
              onClick={() => {
                setText(presets[0].text)
                setSize(92)
                setWeight(400)
                setTracking(0)
                setKern(true)
              }}
            >
              Reset ↺
            </button>
          </div>
          <label htmlFor="specimen-input" className="sr-only">
            Your specimen text
          </label>
          <textarea
            id="specimen-input"
            spellCheck={false}
            maxLength={2000}
            placeholder="Type something here…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            style={{
              fontSize: `clamp(20px, ${size / 12}vw, ${size}px)`,
              fontWeight: weight,
              letterSpacing: `${tracking}em`,
              fontKerning: kern ? "normal" : "none",
              fontFeatureSettings: `"kern" ${kern ? 1 : 0}`,
            }}
            aria-describedby="text-feedback"
          />
          <div className="tester-bottom">
            <div className="presets" role="group" aria-label="Sample text">
              {presets.map((sample) => (
                <button
                  key={sample.label}
                  onClick={() => setText(sample.text)}
                  aria-label={`Use sample: ${sample.text}`}
                >
                  {sample.label} ↗
                </button>
              ))}
            </div>
            <p id="text-feedback" role="status">
              {missing.length
                ? `Fallback characters: ${missing.join(" ")}`
                : !text
                  ? "Start typing to preview the font."
                  : `${[...normalized].length} characters · Unicode coverage checked`}
            </p>
          </div>
          {normalized !== text && (
            <p className="normalization-preview" style={{ fontWeight: weight }}>
              NFC: <span>{normalized}</span>
            </p>
          )}
          <p className={`font-status ${fontState === "error" ? "error" : ""}`} role="status">
            {fontState === "ready"
              ? "Both local webfonts loaded."
              : fontState === "loading"
                ? "Loading local webfonts…"
                : "Font loading failed. The preview uses a fallback font."}
            {fontState === "error" && (
              <button onClick={() => setAttempt((a) => a + 1)}>Retry loading</button>
            )}
          </p>
        </section>
        <section className="weights-showcase" aria-labelledby="weights-heading">
          <div>
            <div className="eyebrow">One idea. Two voices.</div>
            <h2 id="weights-heading">
              Quiet confidence.
              <br />A stronger statement.
            </h2>
            <p>
              Regular brings space and clarity. Medium adds presence without changing the geometry.
              Numerals share one advance width in both weights.
            </p>
          </div>
          <div className="weight-samples">
            <div>
              <span>Regular · 400</span>
              <p>Built to move.</p>
              <small>0123456789 — € $ £ ¥</small>
            </div>
            <div>
              <span>Medium · 500</span>
              <p>Built to move.</p>
              <small>0123456789 — ₽ ₴ ₹ ₿</small>
            </div>
          </div>
        </section>
        <section className="glyph-section" id="glyphs" aria-labelledby="glyph-heading">
          <div className="section-head">
            <h2 id="glyph-heading">Every character counts.</h2>
            <p>
              {coverage.codepointCount} mapped codepoints / {coverage.glyphCount} glyphs
            </p>
          </div>
          <div className="glyph-toolbar">
            <fieldset className="filter">
              <legend className="sr-only">Character category</legend>
              {[
                "All",
                "Letters",
                "Latin",
                "Cyrillic",
                "Numbers",
                "Punctuation & symbols",
                "Currency",
              ].map((category) => (
                <button
                  key={category}
                  aria-pressed={group === category}
                  onClick={() => {
                    setGroup(category)
                    if (category === "Cyrillic") setSelected("Ж")
                  }}
                >
                  {category}
                </button>
              ))}
            </fieldset>
            <a href="./coverage.json" download>
              Coverage JSON ↗
            </a>
          </div>
          <div className="glyph-layout">
            <div className="glyph-grid">
              {characters.map((item) => (
                <button
                  type="button"
                  key={item.hex}
                  aria-label={`${item.character}, ${item.hex}, ${item.name}`}
                  aria-pressed={selected === item.character}
                  onClick={() => setSelected(item.character)}
                >
                  {/[\s\u00ad]/u.test(item.character) ? "␣" : item.character}
                </button>
              ))}
            </div>
            <aside className="glyph-inspector" aria-label="Selected glyph">
              <span className="glyph-large">{/[\s\u00ad]/u.test(selected) ? "␣" : selected}</span>
              <strong>{picked.hex}</strong>
              <p>{picked.name}</p>
              <small>Spaces and soft hyphen use a visible placeholder in this grid.</small>
            </aside>
          </div>
          <p className="coverage-note">
            Russian, Ukrainian and Belarusian Cyrillic ({coverage.cyrillicCodepointCount} letters),
            Basic Latin, Latin-1 Supplement and selected Latin extensions; typographic punctuation,
            14 currency symbols, arrows and №. No combining marks. Use NFC for accented text.
          </p>
        </section>
        <section className="implementation" aria-labelledby="implementation-heading">
          <div>
            <div className="eyebrow">Ready for your next canvas</div>
            <h2 id="implementation-heading">
              From outline
              <br />
              to interface.
            </h2>
            <p>
              TrueType for desktop. WOFF2 for the web.
              <br />
              Original contours, shared metrics, real pair positioning.
            </p>
            <a className="primary" href="./BrandSans-fonts.zip" download>
              Get BrandSans ↗
            </a>
          </div>
          <div className="spec-sheet">
            <dl>
              <div>
                <dt>Formats</dt>
                <dd>TTF / WOFF2</dd>
              </div>
              <div>
                <dt>Units per em</dt>
                <dd>1,000</dd>
              </div>
              <div>
                <dt>Ascender / descender</dt>
                <dd>1,000 / −260</dd>
              </div>
              <div>
                <dt>Kerning</dt>
                <dd>{coverage.kerningPairs.Regular} pairs · GPOS + kern</dd>
              </div>
              <div>
                <dt>License</dt>
                <dd>SIL Open Font License 1.1</dd>
              </div>
            </dl>
            <code>
              font-family: 'BrandSans', sans-serif;
              <br />
              font-weight: 400; /* or 500 */
              <br />
              font-kerning: normal;
            </code>
            <a href="./fonts/brandsans.css" download>
              Download @font-face CSS ↗
            </a>
          </div>
        </section>
      </main>
      <footer>
        <a className="wordmark" href="#">
          BrandSans
          <span className="red-dot" aria-hidden="true" />
        </a>
        <p>
          Original geometry. Independent identity.
          <br />
          Not affiliated with Nissan. No logo or font outlines copied.
        </p>
        <a href="./OFL.txt" download>
          Font license ↗
        </a>
      </footer>
    </>
  )
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
