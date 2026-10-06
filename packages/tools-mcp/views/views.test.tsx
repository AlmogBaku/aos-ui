import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps"
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { PDFDocumentProxy } from "pdfjs-dist"
import { bundledLanguagesInfo } from "shiki/langs"
import { afterEach, describe, expect, it, vi } from "vitest"

import { Code } from "./artifact/code"
import { PREVIEW_LIMITS, knownType, textFormat } from "./artifact/file"
import { keyAction } from "./artifact/zoom"
import { PdfPages } from "./artifact/pdf-preview"
import { ArtifactView } from "./artifact-view"
import { ChartView } from "./chart-view"
import { VIEW_LABELS, viewLocale, type ViewLocale } from "./locale"
import { MapView } from "./map-view"
import { StatsView } from "./stats-view"
import { presentationValue, resultValue, type ViewApp } from "./view"
import { render_chartSchema } from "../../../shared/presentation/tools"
import { GRAMMAR_RESOURCE_URI } from "../../../shared/presentation/views"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const chart = {
  title: "Enterprise AI spend",
  type: "line",
  xKey: "quarter",
  series: [
    { key: "total", label: "Total AI spend" },
    { key: "genai", label: "GenAI spend" },
  ],
  data: [
    { quarter: "Q4’24", total: 300, genai: 220 },
    { quarter: "Q1’25", total: 365, genai: 275 },
  ],
} as const

const map = {
  title: "Interview coverage",
  locations: [
    { id: "london", label: "London", latitude: 51.5072, longitude: -0.1276 },
    {
      id: "tel-aviv",
      label: "Tel Aviv",
      latitude: 32.0853,
      longitude: 34.7818,
    },
  ],
}

/** Shiki's own grammar for `name`, as the server serves it at `uri`. */
async function grammar(uri: string, name: string) {
  const info = bundledLanguagesInfo.find(
    ({ id, aliases }) => id === name || aliases?.includes(name)
  )
  const grammars = info ? (await info.import()).default : []
  const text = JSON.stringify(
    grammars.find((grammar) => grammar.name === name) ?? grammars.at(-1)
  )
  return { contents: [{ uri, mimeType: "application/json", text }] }
}

/** A page that grants every request a view sends it, grammars included. */
function fakeApp() {
  return {
    readServerResource: vi.fn(async ({ uri }: { uri: string }) =>
      uri.startsWith(GRAMMAR_RESOURCE_URI)
        ? grammar(uri, uri.slice(GRAMMAR_RESOURCE_URI.length, -".json".length))
        : { contents: [] }
    ),
    downloadFile: vi.fn(async () => ({})),
    openLink: vi.fn(async () => ({})),
    requestDisplayMode: vi.fn(async () => ({ mode: "inline" as const })),
    fitWidth: vi.fn(),
  } satisfies ViewApp
}

function props<T>(value: T, locale: ViewLocale = "en") {
  return { value, locale, labels: VIEW_LABELS[locale], app: fakeApp() }
}

describe("the value a view draws", () => {
  const parsedChart = render_chartSchema.parse(chart)

  it("draws a valid tool input until a valid result replaces it", () => {
    expect(presentationValue(render_chartSchema, chart, undefined)).toEqual(
      parsedChart
    )
    const retitled = { ...chart, title: "Retitled" }
    expect(
      presentationValue(render_chartSchema, chart, {
        content: [],
        structuredContent: { ok: true, value: retitled },
      })
    ).toEqual(render_chartSchema.parse(retitled))
  })

  it("falls back to the JSON a text-only result ends with", () => {
    const result = {
      content: [
        {
          type: "text" as const,
          text: `Ready.\n\nStructured fallback:\n${JSON.stringify(chart)}`,
        },
      ],
    }
    expect(resultValue(result)).toEqual(chart)
    expect(presentationValue(render_chartSchema, { bad: 1 }, result)).toEqual(
      parsedChart
    )
  })

  it("draws nothing from an invalid input and an empty result", () => {
    expect(
      presentationValue(render_chartSchema, { bad: 1 }, { content: [] })
    ).toBeUndefined()
  })

  it("reads the host's locale tag", () => {
    expect(viewLocale("he-IL")).toBe("he")
    expect(viewLocale("en-US")).toBe("en")
    expect(viewLocale(undefined)).toBe("en")
  })
})

describe("chart view", () => {
  it("keeps the data available as a table", async () => {
    render(<ChartView {...props(render_chartSchema.parse(chart))} />)
    await userEvent.click(
      screen.getByRole("button", { name: "View chart data" })
    )
    expect(
      screen.getByRole("table", { name: "Enterprise AI spend data" })
    ).toBeVisible()
    expect(screen.getByRole("cell", { name: "365" })).toBeVisible()
  })

  it("labels the table in Hebrew and keeps provider labels", async () => {
    render(<ChartView {...props(render_chartSchema.parse(chart), "he")} />)
    await userEvent.click(
      screen.getByRole("button", { name: "הצגת נתוני התרשים" })
    )
    expect(
      screen.getByRole("table", { name: "Enterprise AI spend — נתוני תרשים" })
    ).toBeVisible()
    expect(
      screen.getByRole("columnheader", { name: "Total AI spend" })
    ).toBeVisible()
  })

  it("draws a pie chart with its table", async () => {
    const pie = render_chartSchema.parse({
      title: "Illustrative allocation",
      type: "pie",
      xKey: "category",
      series: [{ key: "value", label: "Share" }],
      data: [
        { category: "Research", value: 45 },
        { category: "Delivery", value: 55 },
      ],
    })
    render(<ChartView {...props(pie)} />)
    await userEvent.click(
      screen.getByRole("button", { name: "View chart data" })
    )
    expect(
      screen.getByRole("table", { name: "Illustrative allocation data" })
    ).toBeVisible()
  })
})

describe("map view", () => {
  it("keeps the locations available as a list", async () => {
    render(<MapView {...props(map)} />)
    await userEvent.click(
      screen.getByRole("button", { name: "View map locations" })
    )
    const list = screen.getByRole("list", {
      name: "Interview coverage locations",
    })
    expect(list).toHaveTextContent("London — 51.5072, -0.1276")
    expect(list).toHaveTextContent("Tel Aviv — 32.0853, 34.7818")
  })

  it("labels the list in Hebrew", async () => {
    render(<MapView {...props(map, "he")} />)
    await userEvent.click(
      screen.getByRole("button", { name: "הצגת מיקומי המפה" })
    )
    expect(
      screen.getByRole("list", { name: "Interview coverage — מיקומים" })
    ).toBeVisible()
  })
})

describe("artifact view", () => {
  const notes = { filename: "notes.txt" }

  /** What the page reports: the file's current address, by argument name. */
  function files(path: string) {
    return { "aos/files": { path } }
  }

  /** What the page reports while the view shows in the side panel. */
  const PIP: McpUiHostContext = { displayMode: "pip" }
  const OFFERED: McpUiHostContext = { availableDisplayModes: ["inline", "pip"] }

  /**
   * Shows one file the page grants, served with `body`, in the side panel
   * unless `context` says otherwise.
   */
  function showFile(
    file: { filename: string; mimeType?: string },
    body: string,
    context: McpUiHostContext = {}
  ) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body))
    )
    const view = props(file)
    const address = `https://aos.test/files/${file.filename}?pass=one`
    const shown = (next: McpUiHostContext) => (
      <ArtifactView
        {...view}
        context={{ ...files(address), ...PIP, ...next }}
      />
    )
    const { rerender } = render(shown(context))
    return {
      app: view.app,
      address,
      rerender: (next: McpUiHostContext) => rerender(shown(next)),
    }
  }

  it.each([
    ["growth.ts", "typescript"],
    ["Card.tsx", "tsx"],
    ["build.js", "javascript"],
    ["build.mjs", "javascript"],
    ["config.yaml", "yaml"],
    ["config.yml", "yaml"],
    ["pyproject.toml", "toml"],
    ["main.py", "python"],
    ["main.go", "go"],
    ["main.rs", "rust"],
    ["deploy.sh", "bash"],
    ["schema.sql", "sql"],
    ["site.css", "css"],
    ["Dockerfile", "dockerfile"],
  ])("highlights %s as %s", (filename, language) => {
    expect(textFormat(knownType({ filename })!)).toEqual({
      format: "code",
      language,
    })
  })

  it.each([
    ["Markdown by its extension", { filename: "brief.md" }, "# Launch brief"],
    [
      "Markdown by its type",
      { filename: "brief", mimeType: "text/markdown" },
      "# Launch brief",
    ],
    [
      "Markdown by its extension beside a vague text type",
      { filename: "brief.md", mimeType: "text/x-unknown" },
      "# Launch brief",
    ],
  ])("lays out %s with its headings", async (_case, file, body) => {
    showFile(file, body)
    expect(
      await screen.findByRole("heading", { name: "Launch brief" })
    ).toBeVisible()
  })

  it("reads a declared type before the file name's", async () => {
    showFile({ filename: "brief.md", mimeType: "text/plain" }, "# Launch brief")
    expect(await screen.findByText("# Launch brief")).toBeVisible()
    expect(screen.queryByRole("heading", { name: "Launch brief" })).toBeNull()
  })

  it("keeps a Markdown file's raw HTML out of the view", async () => {
    showFile(
      { filename: "brief.md" },
      "Intro\n\n<button>Raw button</button>\n\n<script>window.ran = true</script>"
    )
    expect(await screen.findByText("Intro")).toBeVisible()
    expect(screen.queryByRole("button", { name: "Raw button" })).toBeNull()
    expect(document.querySelector("script")).toBeNull()
  })

  it("opens a Markdown link through the page, never in its frame", async () => {
    const { app } = showFile(
      { filename: "brief.md" },
      "[Roadmap](https://example.com/roadmap) and [mail](mailto:ops@example.com)"
    )
    const link = await screen.findByRole("link", { name: "Roadmap" })
    const navigated = !fireEvent.click(link)
    expect(navigated).toBe(true)
    expect(app.openLink).toHaveBeenCalledWith({
      url: "https://example.com/roadmap",
    })
    expect(screen.queryByRole("link", { name: "mail" })).toBeNull()
  })

  it("shows a CSV file as a table under its header row", async () => {
    showFile(
      { filename: "spend.csv" },
      'quarter,total\nQ1,365\n"Q2, est.",410\n'
    )
    expect(
      await screen.findByRole("columnheader", { name: "quarter" })
    ).toBeVisible()
    expect(screen.getByRole("columnheader", { name: "total" })).toBeVisible()
    expect(screen.getByRole("cell", { name: "Q2, est." })).toBeVisible()
  })

  it("indents JSON, keeping text that does not parse as it came", async () => {
    showFile({ filename: "config.json" }, '{"region":"eu","replicas":2}')
    const region = await screen.findByRole("region", { name: "config.json" })
    expect(region.textContent).toBe('{\n  "region": "eu",\n  "replicas": 2\n}')
    cleanup()
    showFile({ filename: "broken.json" }, '{"region":')
    expect(
      (await screen.findByRole("region", { name: "broken.json" })).textContent
    ).toBe('{"region":')
  })

  it("shows an HTML file's source, highlighted as HTML, from the keyboard, with a Copy of its own", async () => {
    const user = userEvent.setup()
    const html = "<h1>Launch plan</h1>"
    const { app } = showFile({ filename: "plan.html" }, html)
    await user.click(await screen.findByRole("tab", { name: "Preview" }))
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull()
    await user.keyboard("{ArrowRight}")
    const source = screen.getByRole("tab", { name: "Source" })
    expect(source).toHaveFocus()
    expect(source).toHaveAttribute("aria-selected", "true")
    const panel = screen.getByRole("tabpanel")
    expect(panel).toHaveTextContent(html)
    expect(screen.queryByTitle("HTML preview")).toBeNull()
    await waitFor(() => expect(panel.querySelector("span")).not.toBeNull())
    expect(app.readServerResource.mock.calls[0]?.[0].uri).toBe(
      `${GRAMMAR_RESOURCE_URI}html.json`
    )
    await user.click(within(panel).getByRole("button", { name: "Copy" }))
    expect(await navigator.clipboard.readText()).toBe(html)
  })

  // Each case names a grammar no other case loads, since a loaded grammar
  // stays loaded for the view's life.
  it.each([
    [
      "a file by its name, with the grammar it embeds",
      { filename: "feed.xml" },
      "<feed/>",
      ["xml", "java"],
    ],
    [
      "a file by its declared type",
      { filename: "deploy", mimeType: "text/x-shellscript" },
      "echo ready",
      ["bash"],
    ],
    [
      "a Markdown fence",
      { filename: "notes.md" },
      "```go\npackage main\n```",
      ["go"],
    ],
  ])(
    "highlights %s, reading only the grammars it needs",
    async (_case, file, body, names) => {
      const { app } = showFile(file, body)
      const region = await screen.findByRole("region", { name: file.filename })
      await waitFor(() => expect(region.querySelector("span")).not.toBeNull())
      expect(app.readServerResource.mock.calls.map(([{ uri }]) => uri)).toEqual(
        names.map((name) => `${GRAMMAR_RESOURCE_URI}${name}.json`)
      )
    }
  )

  it("shows code past its limit as plain text, reading no grammar", () => {
    const { readServerResource } = fakeApp()
    render(
      <Code
        code="fn main() {}"
        language="rust"
        label="main.rs"
        read={readServerResource}
        limit={4}
      />
    )
    const region = screen.getByRole("region", { name: "main.rs" })
    expect(region.textContent).toBe("fn main() {}")
    expect(region.querySelector("span")).toBeNull()
    expect(readServerResource).not.toHaveBeenCalled()
  })

  it("colours code up to its limit leaving out its long lines, which stay plain", async () => {
    const { readServerResource } = fakeApp()
    // Coloured, the long line would split at each number and sign.
    const data = "1 + 2 + 3 + 4 + 5 + 6 + 7"
    render(
      <Code
        code={`fn main() {}\n${data}`}
        language="rust"
        label="main.rs"
        read={readServerResource}
        limit={12}
        lineLimit={20}
      />
    )
    const region = screen.getByRole("region", { name: "main.rs" })
    await waitFor(() => expect(region.querySelector("span")).not.toBeNull())
    expect(within(region).getByText(data)).toBeInTheDocument()
  })

  it("copies the file's text as it came", async () => {
    const user = userEvent.setup()
    const json = '{"region":"eu"}'
    showFile({ filename: "config.json" }, json)
    await user.click(await screen.findByRole("button", { name: "Copy" }))
    expect(await navigator.clipboard.readText()).toBe(json)
    expect(screen.getByRole("button", { name: "Copied" })).toBeVisible()
  })

  it("copies through a selection when the page withholds the clipboard", async () => {
    const user = userEvent.setup()
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockRejectedValue(
        new DOMException("Blocked by a permissions policy", "NotAllowedError")
      )
    let copied: string | undefined
    const execCommand = vi.fn(() => {
      const field = document.querySelector("textarea")
      copied = field?.value.slice(field.selectionStart, field.selectionEnd)
      return true
    })
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    })
    try {
      showFile({ filename: "notes.txt" }, "Launch notes")
      await user.click(await screen.findByRole("button", { name: "Copy" }))
      expect(
        await screen.findByRole("button", { name: "Copied" })
      ).toBeVisible()
      expect(execCommand).toHaveBeenCalledWith("copy")
      expect(copied).toBe("Launch notes")
    } finally {
      writeText.mockRestore()
      Reflect.deleteProperty(document, "execCommand")
    }
  })

  it("shows a file in its message as a card, unread, that opens the side panel only where offered", async () => {
    const user = userEvent.setup()
    const inline: McpUiHostContext = { displayMode: "inline" }
    const { app, address, rerender } = showFile(
      notes,
      "Quarterly notes",
      inline
    )
    expect(await screen.findByText("notes.txt")).toBeVisible()
    expect(screen.queryByRole("button", { name: "View notes.txt" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Full screen" })).toBeNull()
    await user.click(screen.getByRole("button", { name: "Download" }))
    expect(app.downloadFile).toHaveBeenCalledWith({
      contents: [{ type: "resource_link", uri: address, name: "notes.txt" }],
    })

    rerender({ ...inline, ...OFFERED })
    await user.click(screen.getByRole("button", { name: "View notes.txt" }))
    expect(app.requestDisplayMode.mock.calls).toEqual([[{ mode: "pip" }]])
    expect(screen.queryByText("Quarterly notes")).toBeNull()
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull()
    expect(fetch).not.toHaveBeenCalled()

    rerender({ ...PIP, ...OFFERED })
    expect(await screen.findByText("Quarterly notes")).toBeVisible()
  })

  it.each([
    { natural: [400, 200], room: 600, drawn: 512 },
    { natural: [8, 8], room: 100, drawn: 100 },
  ])(
    "shows a $natural image in its message alone at $drawn wide in $room, opening the side panel on a press",
    async ({ natural: [width, height], room, drawn }) => {
      const { app } = showFile({ filename: "preview.png" }, "", {
        displayMode: "inline",
        containerDimensions: { width: room, maxHeight: 6000 },
        ...OFFERED,
      })
      const thumbnail = await screen.findByAltText("preview.png")
      Object.defineProperties(thumbnail, {
        naturalWidth: { value: width },
        naturalHeight: { value: height },
      })
      fireEvent.load(thumbnail)
      expect(app.fitWidth).toHaveBeenLastCalledWith(drawn)
      const image = screen.getByRole("button", { name: "View preview.png" })
      expect(image).toContainElement(thumbnail)
      expect(screen.getAllByRole("button")).toEqual([image])
      await userEvent.click(image)
      expect(app.requestDisplayMode.mock.calls).toEqual([[{ mode: "pip" }]])
    }
  )

  it("goes full screen where offered, previews the file whole there, and Esc returns it where it came from", async () => {
    const user = userEvent.setup()
    const modes: McpUiHostContext = {
      availableDisplayModes: ["inline", "fullscreen", "pip"],
    }
    const { app, rerender } = showFile(notes, "Quarterly notes", {
      displayMode: "inline",
      ...modes,
    })
    await user.click(screen.getByRole("button", { name: "Full screen" }))
    rerender({ displayMode: "fullscreen", ...modes })
    expect(await screen.findByText("Quarterly notes")).toBeVisible()
    expect(screen.queryByRole("button", { name: "Full screen" })).toBeNull()
    await user.keyboard("{Escape}")

    rerender({ displayMode: "pip", ...modes })
    await user.click(await screen.findByRole("button", { name: "Full screen" }))
    rerender({ displayMode: "fullscreen", ...modes })
    await user.keyboard("{Escape}")

    expect(app.requestDisplayMode.mock.calls).toEqual([
      [{ mode: "fullscreen" }],
      [{ mode: "inline" }],
      [{ mode: "fullscreen" }],
      [{ mode: "pip" }],
    ])
  })

  it.each([
    ["notes.txt", false],
    ["brief.md", false],
    ["page.html", false],
    ["report.pdf", true],
    ["brief.mp3", true],
  ])(
    "offers Open in new tab for %s only where the browser shows it itself: %s",
    (filename, offered) => {
      const { app, address } = showFile({ filename }, "", {
        displayMode: "inline",
      })
      const open = screen.queryByRole("button", { name: "Open in new tab" })
      expect(open !== null).toBe(offered)
      if (open) {
        fireEvent.click(open)
        expect(app.openLink).toHaveBeenCalledWith({ url: address })
      }
    }
  )

  it("plays audio straight from the file's address, never reading it", async () => {
    const { address, rerender } = showFile({ filename: "brief.mp3" }, "", {
      displayMode: "inline",
    })
    expect(screen.getByLabelText("Audio: brief.mp3")).toHaveAttribute(
      "src",
      address
    )
    rerender(PIP)
    expect(screen.getByLabelText("Audio: brief.mp3")).toHaveAttribute(
      "src",
      address
    )
    await act(() => Promise.resolve())
    expect(fetch).not.toHaveBeenCalled()
  })

  it("moves Refresh, Download, and Full screen into a menu in a narrow side panel", async () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(390)
    try {
      const user = userEvent.setup()
      const { app, address } = showFile(notes, "Quarterly notes", {
        availableDisplayModes: ["inline", "fullscreen", "pip"],
      })
      expect(await screen.findByText("Quarterly notes")).toBeVisible()
      expect(screen.queryByRole("button", { name: "Download" })).toBeNull()
      const choose = async (name: string) => {
        await user.click(screen.getByRole("button", { name: "More actions" }))
        await user.click(await screen.findByRole("menuitem", { name }))
        await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
      }

      await choose("Download")
      expect(app.downloadFile).toHaveBeenCalledWith({
        contents: [{ type: "resource_link", uri: address, name: "notes.txt" }],
      })
      await choose("Full screen")
      expect(app.requestDisplayMode).toHaveBeenCalledWith({
        mode: "fullscreen",
      })
      await choose("Refresh")
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    } finally {
      vi.restoreAllMocks()
    }
  })

  it.each([
    ["without a length", {}, 3],
    ["with a length above the limit", { "content-length": "256" }, 0],
  ])(
    "stops reading a text file %s at the text limit and offers Download",
    async (_case, headers, reads) => {
      let pulled = 0
      const cancel = vi.fn()
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulled += 1
            controller.enqueue(new TextEncoder().encode("xxxx"))
          },
          cancel,
        },
        { highWaterMark: 0 }
      )
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(body, { headers }))
      )
      const address = "https://aos.test/files/notes.txt?pass=one"
      const view = props(notes)
      render(
        <ArtifactView
          {...view}
          context={{ ...files(address), ...PIP }}
          previewLimits={{ ...PREVIEW_LIMITS, text: 8 }}
        />
      )

      expect(
        await screen.findByText("This file is too large to preview.")
      ).toBeVisible()
      expect(pulled).toBe(reads)
      expect(cancel).toHaveBeenCalledOnce()
      expect(screen.queryByText(/xxxx/u)).toBeNull()
      await userEvent.click(screen.getByRole("button", { name: "Download" }))
      expect(view.app.downloadFile).toHaveBeenCalledWith({
        contents: [{ type: "resource_link", uri: address, name: "notes.txt" }],
      })
    }
  )

  it("says a file is not allowed when the proxy answers 403", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 403 }))
    )

    render(
      <ArtifactView
        {...props(notes)}
        context={{ ...files("https://aos.test/files/notes.txt"), ...PIP }}
      />
    )

    expect(
      await screen.findByText("Showing this file isn't allowed.")
    ).toBeVisible()
    expect(screen.queryByText("Can't reach this file.")).toBeNull()
  })

  it("fetches again once a renewed address follows a refused one, and downloads from the current address", async () => {
    const [first, second, third] = ["one", "two", "three"].map(
      (pass) => `https://aos.test/files/notes.txt?pass=${pass}`
    ) as [string, string, string]
    const fetched: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (address: string) => {
        fetched.push(address)
        return address === first
          ? new Response(null, { status: 401 })
          : new Response("Quarterly notes")
      })
    )
    const view = props(notes)
    const { rerender } = render(
      <ArtifactView {...view} context={{ ...files(first), ...PIP }} />
    )
    expect(await screen.findByText("Can't reach this file.")).toBeVisible()

    rerender(<ArtifactView {...view} context={{ ...files(second), ...PIP }} />)
    expect(await screen.findByText("Quarterly notes")).toBeVisible()
    rerender(<ArtifactView {...view} context={{ ...files(third), ...PIP }} />)
    await userEvent.click(screen.getByRole("button", { name: "Download" }))
    expect(view.app.downloadFile).toHaveBeenCalledWith({
      contents: [{ type: "resource_link", uri: third, name: "notes.txt" }],
    })
    expect(fetched).toEqual([first, second])

    await userEvent.click(screen.getByRole("button", { name: "Refresh" }))
    expect(await screen.findByText("Quarterly notes")).toBeVisible()
    expect(fetched).toEqual([first, second, third])
  })

  it("runs HTML's scripts only in an opaque origin, under a policy that reaches no network or frame", async () => {
    const html =
      "<head><script>parent.postMessage('ran', '*')</script></head><h1>Launch plan</h1>"
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(html))
    )
    // HTML keeps its own limit while text is held to 8 bytes.
    render(
      <ArtifactView
        {...props({ filename: "plan.html" })}
        context={{
          ...files("https://aos.test/files/plan.html?pass=one"),
          ...PIP,
        }}
        previewLimits={{ ...PREVIEW_LIMITS, text: 8 }}
      />
    )

    const frame = await screen.findByTitle("HTML preview")
    expect(frame.getAttribute("sandbox")?.split(/\s+/u)).toEqual([
      "allow-scripts",
    ])
    const document = new DOMParser().parseFromString(
      frame.getAttribute("srcdoc")!,
      "text/html"
    )
    // The policy leads the head, so it governs the file's first script.
    const policy = document.head.firstElementChild
    expect(policy?.getAttribute("http-equiv")).toBe("Content-Security-Policy")
    expect(policy?.getAttribute("content")).toContain("connect-src 'none'")
    expect(policy?.getAttribute("content")).toContain("frame-src 'none'")
    expect(document.querySelector("h1")?.textContent).toBe("Launch plan")
    expect(screen.queryByRole("heading", { name: "Launch plan" })).toBeNull()
  })

  it("zooms an image with Ctrl and the wheel and the zoom keys, leaving a plain wheel to scroll", async () => {
    showFile({ filename: "preview.png" }, "")
    const region = await screen.findByRole("region", { name: "Image preview" })
    expect(screen.getByText("100%")).toBeVisible()
    expect(fireEvent.wheel(region, { deltaY: -25 })).toBe(true)
    expect(screen.getByText("100%")).toBeVisible()

    expect(fireEvent.wheel(region, { deltaY: -25, ctrlKey: true })).toBe(false)
    expect(screen.getByText("128%")).toBeVisible()
    region.focus()
    await userEvent.keyboard("+")
    expect(screen.getByText("161%")).toBeVisible()
    await userEvent.keyboard("0")
    expect(screen.getByText("100%")).toBeVisible()
    expect(screen.getByRole("button", { name: "Fit to view" })).toBeDisabled()
    await userEvent.keyboard("-")
    expect(screen.getByText("100%")).toBeVisible()
  })

  it("asks to return to its message on Esc only from the side panel", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Quarterly notes"))
    )
    const address = "https://aos.test/files/notes.txt?pass=one"
    const view = props(notes)
    const { rerender } = render(
      <ArtifactView {...view} context={files(address)} />
    )
    expect(await screen.findByText("notes.txt")).toBeVisible()
    await userEvent.keyboard("{Escape}")
    expect(view.app.requestDisplayMode).not.toHaveBeenCalled()

    rerender(
      <ArtifactView
        {...view}
        context={{
          ...files(address),
          displayMode: "pip",
          availableDisplayModes: ["inline", "pip"],
        }}
      />
    )
    await userEvent.keyboard("{Escape}")
    expect(view.app.requestDisplayMode.mock.calls).toEqual([
      [{ mode: "inline" }],
    ])
  })
})

describe("stats view", () => {
  it("shows each metric with its comparison", () => {
    render(
      <StatsView
        {...props({
          title: "Launch metrics",
          stats: [
            {
              key: "sessions",
              label: "Sessions",
              value: 1284,
              format: { kind: "number", compact: true },
              diff: { value: 12.5, label: "vs. last week" },
              sparkline: { data: [880, 940, 1012, 1284] },
            },
          ],
        })}
      />
    )
    expect(screen.getByText("Sessions")).toBeVisible()
    expect(screen.getByText("vs. last week")).toBeVisible()
  })

  it("speaks percentages in the view's locale", () => {
    render(
      <StatsView
        {...props(
          {
            title: "Conversion",
            stats: [
              {
                key: "conversion",
                label: "Conversion rate",
                value: -0.1234,
                format: { kind: "percent", decimals: 2 },
              },
            ],
          },
          "he"
        )}
      />
    )
    expect(
      screen.getByLabelText(
        new Intl.NumberFormat("he-IL", {
          style: "percent",
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }).format(-0.1234)
      )
    ).toBeInTheDocument()
  })
})

describe("PDF sidebar", () => {
  type Outline = Awaited<ReturnType<PDFDocumentProxy["getOutline"]>>

  /** A five-page file whose "results" destination is its third page. */
  function pdf(outline: Outline) {
    return {
      numPages: 5,
      // No page ever draws; the sidebar's turns show in the page count.
      getPage: () => new Promise(() => {}),
      getOutline: async () => outline,
      getDestination: async (name: string) =>
        name === "results" ? [{ num: 7, gen: 0 }, { name: "XYZ" }] : null,
      getPageIndex: async ({ num }: { num: number }) => (num === 7 ? 2 : 0),
    } as unknown as PDFDocumentProxy
  }

  function entry(title: string, dest: unknown, items: unknown[] = []) {
    return { title, dest, items } as NonNullable<Outline>[number]
  }

  function showPages(outline: Outline) {
    render(
      <PdfPages
        pdf={pdf(outline)}
        labels={VIEW_LABELS.en.artifact}
        room={{ width: 800, height: 600 }}
      />
    )
  }

  it("opens on the toggle and turns to the page an outline entry or a page leads to", async () => {
    const user = userEvent.setup()
    showPages([
      entry("Summary", [0, { name: "Fit" }], [entry("Results", "results")]),
    ])
    const toggle = screen.getByRole("button", { name: "Sidebar" })
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByRole("navigation", { name: "Sidebar" })).toBeNull()

    await user.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "true")
    await user.click(await screen.findByRole("button", { name: "Results" }))
    expect(screen.getByText("Page 3 of 5")).toBeVisible()

    await user.click(screen.getByRole("tab", { name: "Pages" }))
    expect(screen.getByRole("button", { name: "Page 3" })).toHaveAttribute(
      "aria-current",
      "page"
    )
    await user.click(screen.getByRole("button", { name: "Page 5" }))
    expect(screen.getByText("Page 5 of 5")).toBeVisible()
  })

  it("turns pages by key from the view's controls, but leaves Space to a button and arrows to the sidebar", async () => {
    const user = userEvent.setup()
    showPages([])
    // jsdom lays nothing out, so every page is already at its edge.
    await user.click(screen.getByRole("button", { name: "Next page" }))
    await user.keyboard("{ArrowDown}")
    expect(screen.getByText("Page 3 of 5")).toBeVisible()
    act(() => screen.getByRole("button", { name: "Previous page" }).focus())
    await user.keyboard(" ")
    expect(screen.getByText("Page 2 of 5")).toBeVisible()
    await user.keyboard("{End}")
    expect(screen.getByText("Page 5 of 5")).toBeVisible()

    await user.click(screen.getByRole("button", { name: "Sidebar" }))
    await user.click(await screen.findByRole("tab", { name: "Pages" }))
    await user.click(screen.getByRole("button", { name: "Page 3" }))
    await user.keyboard("{ArrowDown}")
    expect(screen.getByText("Page 3 of 5")).toBeVisible()
  })

  /** One finger across the page, from `from` to `to` px along it. */
  function swipe(from: number, to: number) {
    const page = screen.getByRole("region", { name: "PDF preview" })
    fireEvent.touchStart(page, { touches: [{ clientX: from, clientY: 100 }] })
    fireEvent.touchEnd(page, {
      touches: [],
      changedTouches: [{ clientX: to, clientY: 110 }],
    })
  }

  it.each([
    ["leftward in LTR", "ltr", "", "Page 3 of 5"],
    ["leftward in RTL", "rtl", "", "Page 1 of 5"],
    ["while zoomed", "ltr", "+", "Page 2 of 5"],
  ])(
    "turns the page on a swipe %s as the reading direction leads",
    async (_case, dir, keys, expected) => {
      document.documentElement.dir = dir
      try {
        const user = userEvent.setup()
        showPages([])
        await user.click(screen.getByRole("button", { name: "Next page" }))
        if (keys) await user.keyboard(keys)
        swipe(300, 200)
        expect(screen.getByText(expected)).toBeVisible()
      } finally {
        document.documentElement.dir = ""
      }
    }
  )

  it("offers no Outline tab for a file without an outline", async () => {
    showPages([])
    await userEvent.click(screen.getByRole("button", { name: "Sidebar" }))
    expect(await screen.findByRole("tab", { name: "Pages" })).toBeVisible()
    expect(screen.queryByRole("tab", { name: "Outline" })).toBeNull()
  })
})

describe("zoom pane keys", () => {
  /** Content 300px tall and as wide as its 100px box, scrolled `top` down it. */
  const box = (top: number) =>
    ({
      scrollTop: top,
      scrollHeight: 300,
      clientHeight: 100,
      scrollLeft: 0,
      scrollWidth: 100,
      clientWidth: 100,
    }) as Element

  it.each([
    ["ArrowDown", false, 100, "ltr", { scroll: { top: 40, left: 0 } }],
    ["ArrowDown", false, 200, "ltr", { turn: "next" }],
    ["PageDown", false, 100, "ltr", { scroll: { top: 60, left: 0 } }],
    [" ", false, 200, "ltr", { turn: "next" }],
    [" ", true, 0, "ltr", { turn: "previous" }],
    ["PageUp", false, 100, "ltr", { scroll: { top: -60, left: 0 } }],
    ["ArrowUp", false, 0, "ltr", { turn: "previous" }],
    ["ArrowRight", false, 100, "ltr", { turn: "next" }],
    ["ArrowRight", false, 100, "rtl", { turn: "previous" }],
    ["Home", false, 100, "ltr", { turn: "first" }],
    ["End", false, 100, "ltr", { turn: "last" }],
    ["a", false, 200, "ltr", undefined],
  ])("%s (shift %s) at %ipx in %s", (key, shiftKey, top, dir, expected) => {
    document.documentElement.dir = dir
    try {
      expect(keyAction({ key, shiftKey }, box(top))).toEqual(expected)
    } finally {
      document.documentElement.dir = ""
    }
  })
})
