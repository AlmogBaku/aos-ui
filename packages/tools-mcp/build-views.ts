import { mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"

import {
  buildGrammars,
  buildPdfjs,
  buildViews,
  VIEWS_OUTPUT_DIRECTORY,
} from "./views/build"

/**
 * `bun run tools-mcp:build`: writes each view, and the pdf.js files and
 * grammars the artifact view reads, where the server loads them.
 */
const views = await buildViews()
await mkdir(VIEWS_OUTPUT_DIRECTORY, { recursive: true })
for (const [name, html] of Object.entries(views))
  await writeFile(path.join(VIEWS_OUTPUT_DIRECTORY, `${name}.html`), html)

async function writeFolder(folder: string, files: Map<string, Uint8Array>) {
  const root = path.join(VIEWS_OUTPUT_DIRECTORY, folder)
  await rm(root, { recursive: true, force: true })
  for (const [name, bytes] of files) {
    const file = path.join(root, name)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, bytes)
  }
}

await writeFolder("pdfjs", await buildPdfjs())
await writeFolder("grammars", await buildGrammars())
