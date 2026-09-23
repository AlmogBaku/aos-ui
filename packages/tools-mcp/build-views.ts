import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

import { buildViews, VIEWS_OUTPUT_DIRECTORY } from "./views/build"

/** `bun run tools-mcp:build`: writes each view where the server loads it. */
const views = await buildViews()
await mkdir(VIEWS_OUTPUT_DIRECTORY, { recursive: true })
for (const [name, html] of Object.entries(views))
  await writeFile(path.join(VIEWS_OUTPUT_DIRECTORY, `${name}.html`), html)
