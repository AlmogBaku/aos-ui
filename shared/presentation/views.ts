import type { AosUiToolName } from "./tools"

/** The MIME type every MCP App view is served as (spec 2026-01-26). */
export const PRESENTATION_VIEW_MIME_TYPE = "text/html;profile=mcp-app"

export type PresentationViewName = "chart" | "map" | "stats" | "artifact"

export type PresentationView = {
  name: PresentationViewName
  resourceUri: `ui://aos-ui/${PresentationViewName}`
  /** The origins the view loads from, beyond its own inlined document. */
  csp: { connectDomains?: string[]; resourceDomains?: string[] }
  /** The browser features the view asks its host frames to allow. */
  permissions?: { clipboardWrite?: Record<string, never> }
}

/**
 * The public CDNs Agent HTML may load scripts, styles, and fonts from: Google
 * Fonts' stylesheets and font files, and Tailwind's Play CDN. Only their
 * owners publish to them, and no one else reads who asked, so a page that
 * loads from them signals nothing to anyone. A host anyone may publish to,
 * such as an npm mirror whose per-file hit counts are public, would.
 *
 * Agent HTML also has storage of its own (via the stand-in, which the
 * artifact view saves per file on its stable origin) and relays `https:`
 * links to the workspace. Loading from these CDNs signals nothing beyond what
 * an ordinary https link click would.
 */
export const AGENT_HTML_DOMAINS = [
  "https://fonts.googleapis.com",
  "https://fonts.gstatic.com",
  "https://cdn.tailwindcss.com",
]

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
  // The page adds each call's own file addresses to this view's policy. The
  // view declares only the CDNs the Agent HTML it previews may load from,
  // since that frame inherits this policy. Its Copy button writes the
  // clipboard.
  present_artifact: {
    name: "artifact",
    resourceUri: "ui://aos-ui/artifact",
    csp: { resourceDomains: AGENT_HTML_DOMAINS },
    permissions: { clipboardWrite: {} },
  },
}

export const presentationViewNames = Object.values(presentationViews).map(
  (view) => view.name
)

/**
 * The `<meta>` name under which the `aos-ui` server writes, into the artifact
 * view's HTML, the host the view expects when it declares a stable origin: its
 * `domain`, with the stable origins' port, if they name one. Only on that host
 * does the view keep Agent HTML storage past the preview.
 */
export const ARTIFACT_VIEW_HOST_META = "aos-ui-artifact-host"

/**
 * Where the artifact view reads pdf.js's own files from the `aos-ui` server:
 * its worker, character maps, standard fonts, and image decoders, each by its
 * path in the pdf.js package. The view's sandbox fetches nothing else.
 */
export const PDFJS_RESOURCE_URI = "ui://aos-ui/pdfjs/"

/** The pdf.js worker, rebuilt as a classic script the view starts itself. */
export const PDFJS_WORKER_FILE = "pdf.worker.js"

/**
 * Where the map view reads MapLibre's worker from the `aos-ui` server. Inlined,
 * the worker would carry the view past the 2 MiB a gateway accepts for one
 * App document.
 */
export const MAPLIBRE_RESOURCE_URI = "ui://aos-ui/maplibre/"

/** MapLibre's worker, the module the package ships, which starts itself. */
export const MAPLIBRE_WORKER_FILE = "maplibre-gl-worker.mjs"

/**
 * Where the artifact view reads the scripts that read Office files from the
 * `aos-ui` server: the spreadsheet worker and the Word renderer. Inlined, the
 * libraries they carry would take the view past the 2 MiB a gateway accepts
 * for one App document.
 */
export const OFFICE_RESOURCE_URI = "ui://aos-ui/office/"

/** The worker that reads a workbook's sheets, a classic script. */
export const SHEET_WORKER_FILE = "sheet.worker.js"

/** The script that draws a Word document inside its own frame. */
export const DOCX_RENDERER_FILE = "docx-preview.js"

/**
 * Where the artifact view reads the grammar it highlights code in, one Shiki
 * grammar per `<name>.json`, so the view carries none of them itself.
 */
export const GRAMMAR_RESOURCE_URI = "ui://aos-ui/grammars/"

/**
 * Where the fixture preview reads the `aos-ui` server's own answers: its
 * `tools/list` tools and each view's `resources/read` result, recorded from
 * the real server when the app is built or served.
 */
export const FIXTURE_AOS_UI_MCP_PATH = "/fixture/aos-ui-mcp.json"

/**
 * The domain the fixture's stable origins sit under, as the preview that
 * turns them on names them: `http://*.mcp-apps.localhost:<its port>`.
 */
export const FIXTURE_MCP_APP_STABLE_DOMAIN = "mcp-apps.localhost"

/**
 * The fixture's artifact view's `_meta.ui.domain`: the stable origin key of
 * `http://127.0.0.1:4110/mcp`, the URL a harness on the host registers the
 * `aos-ui` server at, below `FIXTURE_MCP_APP_STABLE_DOMAIN`. The browser
 * computes no key, so it was computed once and pasted:
 * `bun -e 'import { mcpAppStableOriginKey } from "@harness-gw/sdk/node"; console.log(mcpAppStableOriginKey("http://127.0.0.1:4110/mcp"))'`.
 */
export const FIXTURE_ARTIFACT_VIEW_DOMAIN = `7cc446137c2736c67e8c3639c0348c67.${FIXTURE_MCP_APP_STABLE_DOMAIN}`

/** The path prefix for the synthetic files the fixture serves to the artifact view. */
export const FIXTURE_MCP_APP_FILES_PATH = "/fixture/mcp-app-files"

/**
 * The synthetic fixture files served at `FIXTURE_MCP_APP_FILES_PATH/<name>`
 * for exercising the artifact view in fixture mode: a PDF with a CCITT Group 4
 * image, a PNG, an HTML file whose visible effect confirms that its
 * scripts run and its fetch is refused, a tone, colour bars, a two-sheet
 * workbook, and a Word document carrying a script link and an embedded HTML
 * part its frame must refuse, which the preview's artifact tool calls show;
 * and the Markdown,
 * CSV, JSON, code, and HTML files its published attachments carry.
 */
export const FIXTURE_MCP_APP_FILES = {
  pdf: "report.pdf",
  png: "preview.png",
  html: "test.html",
  audio: "briefing-tone.mp3",
  video: "color-bars.mp4",
  markdown: "enterprise-ai-brief.md",
  csv: "quarterly-spend.csv",
  json: "quarterly-spend.json",
  code: "growth-rate.ts",
  page: "market-summary.html",
  sheet: "crm-pipeline.xlsx",
  document: "sales-proposal.docx",
} as const

/**
 * The exact URL paths that carry `Access-Control-Allow-Origin: *`, so the
 * artifact view can fetch them from the sandbox origin.
 */
export const FIXTURE_MCP_APP_FILE_PATHS = Object.values(
  FIXTURE_MCP_APP_FILES
).map((name) => `${FIXTURE_MCP_APP_FILES_PATH}/${name}`)

/**
 * Each fixture file's `fileId` by its path, as the tools server and the
 * gateway give one: `artifactFileId` (`@harness-gw/sdk/node`) of the path.
 * The browser computes none, so each was computed once and pasted:
 * `bun -e 'import { artifactFileId } from "@harness-gw/sdk/node"; console.log(artifactFileId("/fixture/mcp-app-files/report.pdf"))'`.
 */
export const FIXTURE_MCP_APP_FILE_IDS: ReadonlyMap<string, string> = new Map(
  (
    [
      ["pdf", "83dd05ab7501dab3"],
      ["png", "39f6f21ba2b120b9"],
      ["html", "31f870e8fd4a5d2e"],
      ["audio", "64791ac3ef3d8d6d"],
      ["video", "9e3286011078f802"],
      ["markdown", "2ac3018a4fdefe21"],
      ["csv", "37ef13d87f7a4393"],
      ["json", "e633aa9f35c4e001"],
      ["code", "aa845e2768a8c3f0"],
      ["page", "19ca46590f90e9d6"],
      ["sheet", "dffccb69c3bffd1c"],
      ["document", "9b419a596a79c8d0"],
    ] as const satisfies ReadonlyArray<
      readonly [keyof typeof FIXTURE_MCP_APP_FILES, string]
    >
  ).map(([file, fileId]) => [
    `${FIXTURE_MCP_APP_FILES_PATH}/${FIXTURE_MCP_APP_FILES[file]}`,
    fileId,
  ])
)
