import type { PresentationToolName } from "./tools"

/** The MIME type every MCP App view is served as (spec 2026-01-26). */
export const PRESENTATION_VIEW_MIME_TYPE = "text/html;profile=mcp-app"

export type PresentationViewName = "chart" | "map" | "stats"

export type PresentationView = {
  name: PresentationViewName
  resourceUri: `ui://aos-ui/${PresentationViewName}`
  /** The origins the view loads from, beyond its own inlined document. */
  csp: { connectDomains?: string[]; resourceDomains?: string[] }
}

/**
 * The view each presentation tool declares. The `aos-ui` server serves them as
 * `ui://` resources and the fixture preview renders them through the same host.
 */
export const presentationViews: Record<PresentationToolName, PresentationView> =
  {
    render_chart: { name: "chart", resourceUri: "ui://aos-ui/chart", csp: {} },
    render_map: {
      name: "map",
      resourceUri: "ui://aos-ui/map",
      // OpenFreeMap's style, tiles, glyphs, and sprites, which MapLibre
      // fetches; every other byte of the view is inlined.
      csp: { connectDomains: ["https://tiles.openfreemap.org"] },
    },
    render_stats: { name: "stats", resourceUri: "ui://aos-ui/stats", csp: {} },
  }

export const presentationViewNames = Object.values(presentationViews).map(
  (view) => view.name
)

/**
 * Where the fixture preview reads the `aos-ui` server's own answers: its
 * `tools/list` tools and each view's `resources/read` result, recorded from
 * the real server when the app is built or served.
 */
export const FIXTURE_AOS_UI_MCP_PATH = "/fixture/aos-ui-mcp.json"
