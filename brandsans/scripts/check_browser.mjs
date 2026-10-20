import { createRequire } from "node:module"
import fs from "node:fs/promises"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
const ROOT = fileURLToPath(new URL("../", import.meta.url))
process.chdir(ROOT)
const require = createRequire(new URL("../demo/package.json", import.meta.url))
const { default: AxeBuilder } = require("@axe-core/playwright")
const { chromium } = require(process.env.BRANDSANS_PLAYWRIGHT || "playwright")
const browser = await chromium.launch({
  headless: true,
  channel: process.env.BRANDSANS_BROWSER || (process.platform === "win32" ? "msedge" : undefined),
})
try {
  const context = await browser.newContext()
  const page = await context.newPage()
  page.setDefaultTimeout(7000)
  const errors = []
  const network = []
  page.on("pageerror", (e) => errors.push(e.message))
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text())
  })
  page.on("response", (r) => {
    if (r.status() >= 400) network.push({ url: r.url(), status: r.status() })
  })
  await page.goto("http://127.0.0.1:4173/")
  await page.getByText("Both local webfonts loaded.").waitFor()
  const sizes = [320, 360, 768, 1440]
  const widths = []
  for (const width of sizes) {
    await page.setViewportSize({ width, height: 1000 })
    widths.push(
      await page.evaluate(() => ({
        viewport: innerWidth,
        content: document.documentElement.scrollWidth,
      })),
    )
    assert.equal(widths.at(-1).viewport, widths.at(-1).content)
    await page.screenshot({ path: `reports/demo-${width}.png`, fullPage: true })
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.getByRole("button", { name: "Medium", exact: true }).click()
  assert.equal(
    await page.locator("textarea").evaluate((el) => getComputedStyle(el).fontWeight),
    "500",
  )
  await page.getByLabel("Your specimen text").fill("AV To")
  await page.getByLabel("Kerning", { exact: true }).uncheck()
  assert.equal(
    await page.locator("textarea").evaluate((el) => getComputedStyle(el).fontKerning),
    "none",
  )
  await page.getByLabel("Kerning", { exact: true }).check()
  await page.getByLabel("Your specimen text").fill("Привет")
  assert.doesNotMatch(await page.locator("#text-feedback").textContent(), /Fallback characters/)
  for (const text of ["Ёжик, съешь ещё булок.", "Ґанок, їжак і єдність.", "Ўзоры шрыфту. № 2026"]) {
    await page.getByLabel("Your specimen text").fill(text)
    assert.doesNotMatch(await page.locator("#text-feedback").textContent(), /Fallback characters/)
  }
  await page.getByLabel("Your specimen text").fill("你好")
  assert.match(await page.locator("#text-feedback").textContent(), /Fallback characters/)
  await page.getByLabel("Your specimen text").fill("")
  assert.match(await page.locator("#text-feedback").textContent(), /Start typing/)
  await page.getByRole("button", { name: "Reset" }).click()
  assert.equal(await page.locator("textarea").inputValue(), "Форма в движении.")
  await page.getByRole("button", { name: "Currency", exact: true }).click()
  assert.equal(await page.locator(".glyph-grid button").count(), 14)
  await page.getByRole("button", { name: "€, U+20AC, EURO SIGN" }).click()
  assert.equal(await page.locator(".glyph-inspector strong").textContent(), "U+20AC")
  await page.getByRole("button", { name: "Cyrillic", exact: true }).click()
  assert.equal(await page.locator(".glyph-grid button").count(), 76)
  await page.getByRole("button", { name: "Ё, U+0401, CYRILLIC CAPITAL LETTER IO" }).click()
  assert.equal(await page.locator(".glyph-inspector strong").textContent(), "U+0401")
  await page.getByRole("button", { name: "All", exact: true }).click()
  assert.equal(await page.locator(".glyph-grid button").count(), 321)
  const fontCheck = await page.evaluate(() => {
    const c = document.createElement("canvas"),
      x = c.getContext("2d")
    x.font = "400 80px BrandSans"
    const a = x.measureText("AVATAR").width
    x.font = "400 80px monospace"
    x.font = "500 80px BrandSans"
    const cyrillicWidth = x.measureText("Привет, Україно! Ў").width
    x.fontKerning = "normal"
    const cyrillicKernOn = x.measureText("То").width
    x.fontKerning = "none"
    const cyrillicKernOff = x.measureText("То").width
    x.font = "500 80px Arial"
    const cyrillicFallbackWidth = x.measureText("Привет, Україно! Ў").width
    x.font = "400 80px monospace"
    return {
      cyrillicWidth,
      cyrillicFallbackWidth,
      cyrillicKernOn,
      cyrillicKernOff,
      loaded:
        document.fonts.check("400 24px BrandSans") && document.fonts.check("500 24px BrandSans"),
      brandWidth: a,
      fallbackWidth: x.measureText("AVATAR").width,
    }
  })
  assert.ok(fontCheck.loaded && fontCheck.brandWidth !== fontCheck.fallbackWidth)
  assert.notEqual(fontCheck.cyrillicWidth, fontCheck.cyrillicFallbackWidth)
  assert.ok(fontCheck.cyrillicKernOn < fontCheck.cyrillicKernOff)
  await page.keyboard.press("Tab")
  assert.ok(
    await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle !== "none"),
  )
  await page.emulateMedia({ reducedMotion: "reduce" })
  assert.equal(
    await page
      .getByRole("button", { name: "Reset" })
      .evaluate((el) => getComputedStyle(el).transitionDuration),
    "0s",
  )
  const paths = [
    "/BrandSans-fonts.zip",
    "/coverage.json",
    "/fonts/brandsans.css",
    "/OFL.txt",
    "/fonts/BrandSans-Regular.ttf",
    "/fonts/BrandSans-Medium.ttf",
    "/fonts/BrandSans-Regular.woff2",
    "/fonts/BrandSans-Medium.woff2",
  ]
  for (const path of paths) {
    const response = await page.request.get("http://127.0.0.1:4173" + path)
    assert.equal(response.status(), 200)
    assert.ok((await response.body()).length > 100)
  }
  // Simulated font transport failure and recovery: preserve user input and offer retry.
  console.log("Core interactions passed")
  const failure = await browser.newPage()
  failure.setDefaultTimeout(7000)
  await failure.route("**/fonts/*", (route) =>
    /\.(woff2|ttf)$/.test(route.request().url()) ? route.abort() : route.continue(),
  )
  await failure.goto("http://127.0.0.1:4173/")
  await failure.getByRole("button", { name: "Retry loading" }).waitFor()
  await failure.unroute("**/fonts/*")
  await failure.getByRole("button", { name: "Retry loading" }).click()
  await failure.getByText("Both local webfonts loaded.").waitFor()
  await failure.close()
  assert.deepEqual(errors, [])
  assert.deepEqual(network, [])
  const accessibility = []
  for (const width of [320, 1440]) {
    await page.setViewportSize({ width, height: 1000 })
    const scan = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze()
    accessibility.push({
      width,
      violations: scan.violations,
      incomplete: scan.incomplete.map((item) => ({ id: item.id, description: item.description })),
    })
    assert.deepEqual(scan.violations, [])
  }
  const report = {
    accessibility,
    status: "PASS",
    browser: "Chromium " + browser.version(),
    viewports: widths,
    fontCheck,
    checks: [
      "both WOFF2 fonts loaded and rendered",
      "weight switch",
      "kerning toggle",
      "unsupported text",
      "empty text",
      "reset",
      "14 currency glyphs",
      "321 total codepoints",
      "76 Cyrillic letters and Russian/Ukrainian/Belarusian samples",
      "actual Cyrillic canvas rendering and kerning",
      "glyph inspector",
      "keyboard focus outline",
      "reduced motion",
      "all downloads HTTP 200",
      "font network failure and successful retry",
    ],
    errors,
    failedResponses: network,
  }
  await fs.writeFile("reports/browser-validation.json", JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  await browser.close()
}
