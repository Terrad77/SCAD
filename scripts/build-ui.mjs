import { build } from "esbuild"
import { copyFile, mkdir } from "node:fs/promises"
import { URL } from "node:url"
const fonts = new URL("../dist/ui/fonts/brandsans/", import.meta.url)
await mkdir(fonts, { recursive: true })
for (const file of ["BrandSans-Regular.woff2", "BrandSans-Medium.woff2", "OFL.txt"]) {
  await copyFile(
    new URL("../public/fonts/brandsans/" + file, import.meta.url),
    new URL(file, fonts),
  )
}
await build({
  entryPoints: ["src/ui/viewer.ts"],
  outdir: "dist/ui",
  splitting: true,
  chunkNames: "chunks/[name]-[hash]",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
})
