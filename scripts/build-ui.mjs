import { build } from "esbuild"
await build({
  entryPoints: ["src/ui/viewer.ts"],
  outfile: "dist/ui/viewer.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
})
