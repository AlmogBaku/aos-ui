import type { AosUiToolName } from "./tools"

/** The MIME type every MCP App view is served as (spec 2026-01-26). */
export const PRESENTATION_VIEW_MIME_TYPE = "text/html;profile=mcp-app"

export type PresentationViewName = "chart" | "map" | "stats" | "artifact"

export type PresentationView = {
  name: PresentationViewName
  resourceUri: `ui://aos-ui/${PresentationViewName}`
  /** The origins the view loads from, beyond its own inlined document. */
  csp: { connectDomains?: string[]; resourceDomains?: string[] }
}

/**
 * The view each `aos-ui` tool declares. The `aos-ui` server serves them as
 * `ui://` resources and the fixture preview renders them through the same host.
 */
export const presentationViews: Record<AosUiToolName, PresentationView> = {
  render_chart: { name: "chart", resourceUri: "ui://aos-ui/chart", csp: {} },
  render_map: {
    name: "map",
    resourceUri: "ui://aos-ui/map",
    // OpenFreeMap's style, tiles, glyphs, and sprites, which MapLibre
    // fetches; every other byte of the view is inlined.
    csp: { connectDomains: ["https://tiles.openfreemap.org"] },
  },
  render_stats: { name: "stats", resourceUri: "ui://aos-ui/stats", csp: {} },
  // The page adds each call's own file addresses to this view's policy, so
  // it declares no origin of its own.
  present_artifact: {
    name: "artifact",
    resourceUri: "ui://aos-ui/artifact",
    csp: {},
  },
}

export const presentationViewNames = Object.values(presentationViews).map(
  (view) => view.name
)

/**
 * Where the artifact view reads pdf.js's own files from the `aos-ui` server:
 * its worker, character maps, standard fonts, and image decoders, each by its
 * path in the pdf.js package. The view's sandbox fetches nothing else.
 */
export const PDFJS_RESOURCE_URI = "ui://aos-ui/pdfjs/"

/** The pdf.js worker, rebuilt as a classic script the view starts itself. */
export const PDFJS_WORKER_FILE = "pdf.worker.js"

/**
 * Where the fixture preview reads the `aos-ui` server's own answers: its
 * `tools/list` tools and each view's `resources/read` result, recorded from
 * the real server when the app is built or served.
 */
export const FIXTURE_AOS_UI_MCP_PATH = "/fixture/aos-ui-mcp.json"
