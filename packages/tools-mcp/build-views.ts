import { mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"

import { buildPdfjs, buildViews, VIEWS_OUTPUT_DIRECTORY } from "./views/build"

/**
 * `bun run tools-mcp:build`: writes each view, and the pdf.js files the
 * artifact view reads, where the server loads them.
 */
const views = await buildViews()
await mkdir(VIEWS_OUTPUT_DIRECTORY, { recursive: true })
for (const [name, html] of Object.entries(views))
  await writeFile(path.join(VIEWS_OUTPUT_DIRECTORY, `${name}.html`), html)

const pdfjs = path.join(VIEWS_OUTPUT_DIRECTORY, "pdfjs")
await rm(pdfjs, { recursive: true, force: true })
for (const [name, bytes] of await buildPdfjs()) {
  const file = path.join(pdfjs, name)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, bytes)
}
