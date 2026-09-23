import tailwind from "@tailwindcss/postcss"
import react from "@vitejs/plugin-react"
import path from "node:path"
import { build, type Rolldown } from "vite"

import {
  presentationViewNames,
  type PresentationViewName,
} from "../../../shared/presentation/views"

const VIEWS_DIRECTORY = import.meta.dirname
/** Where `bun run tools-mcp:build` writes the views the server loads. */
export const VIEWS_OUTPUT_DIRECTORY = path.resolve(
  VIEWS_DIRECTORY,
  "../dist/views"
)

const ENTRIES: Record<PresentationViewName, string> = {
  chart: "chart-main.tsx",
  map: "map-main.tsx",
  stats: "stats-main.tsx",
}

/** Inline text must not close the element that carries it. */
function inlineScript(code: string) {
  return code.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--")
}

function inlineStyle(css: string) {
  return css.replace(/<\/(style)/gi, "<\\/$1")
}

function document(js: string, css: string) {
  return [
    "<!doctype html>",
    '<html lang="en" dir="ltr">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<style>${inlineStyle(css)}</style>`,
    "</head>",
    "<body>",
    '<div id="root"></div>',
    `<script type="module">${inlineScript(js)}</script>`,
    "</body>",
    "</html>",
  ].join("\n")
}

/**
 * Builds one view into a single self-contained HTML document: one inline
 * module script, one inline stylesheet, every asset a `data:` URL. The App
 * sandbox loads nothing else, since its CSP names only declared domains.
 */
export async function buildView(name: PresentationViewName): Promise<string> {
  const output = await build({
    configFile: false,
    logLevel: "warn",
    root: VIEWS_DIRECTORY,
    mode: "production",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [react()],
    // Vite derives the JSX transform from the process's NODE_ENV, which is
    // "development" inside the fixture dev server that builds these views.
    // Match the production React the define above selects, or every view
    // throws on `jsxDEV`.
    oxc: { jsx: { development: false } },
    // Vite minifies the stylesheet itself. Tailwind's own optimized output is
    // cached per process and comes back empty on a second build in the same
    // one, which is how the fixture dev server and the tests build views.
    css: { postcss: { plugins: [tailwind({ optimize: false })] } },
    build: {
      write: false,
      emptyOutDir: false,
      cssCodeSplit: false,
      assetsInlineLimit: () => true,
      modulePreload: false,
      reportCompressedSize: false,
      rolldownOptions: {
        input: path.join(VIEWS_DIRECTORY, ENTRIES[name]),
        output: { format: "es", codeSplitting: false },
      },
    },
  })
  const bundles = (
    Array.isArray(output) ? output : [output]
  ) as Rolldown.RolldownOutput[]
  const files = bundles.flatMap((bundle) => bundle.output)
  const scripts: string[] = []
  const styles: string[] = []
  const stray: string[] = []
  for (const file of files) {
    if (file.type === "chunk") scripts.push(file.code)
    else if (file.fileName.endsWith(".css")) styles.push(String(file.source))
    else stray.push(file.fileName)
  }
  if (scripts.length !== 1 || stray.length > 0)
    throw new Error(
      `The ${name} view did not build into one document: ${files.map((file) => file.fileName).join(", ")}`
    )
  return document(scripts[0]!, styles.join("\n"))
}

/** Every presentation view, keyed by name. */
export async function buildViews(): Promise<
  Record<PresentationViewName, string>
> {
  const views = {} as Record<PresentationViewName, string>
  for (const name of presentationViewNames) views[name] = await buildView(name)
  return views
}
