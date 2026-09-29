import babel from "@rolldown/plugin-babel"
import { reactCompilerPreset } from "@vitejs/plugin-react"
import path from "node:path"

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const src = escapeRegExp(path.join(import.meta.dirname, "src") + path.sep)

/**
 * React Compiler over our own `src/` app code only: libraries under
 * `node_modules`, `packages/`, `shared/`, the React-free service worker, and
 * test code stay as written. Test scaffolding reads mutable globals such as
 * `window.location` from hook-named helpers, which the compiler would cache.
 * Add it beside `react()`; the preset runs only in Vite's client environment,
 * so Vitest compiles its jsdom project and leaves the Node one alone.
 */
export function reactCompiler() {
  const preset = reactCompilerPreset()
  // The preset ships only a `code` filter, so the id filter is set whole.
  preset.rolldown.filter = {
    ...preset.rolldown.filter,
    id: {
      include: new RegExp(`^${src}`),
      exclude: [
        /\/node_modules\//,
        new RegExp(`^${src}(sw|components/test-utils)/`),
        /\.test(-helpers)?\.tsx?$/,
      ],
    },
  }
  return babel({ presets: [preset] })
}
