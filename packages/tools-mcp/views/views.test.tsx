import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import { PREVIEW_LIMITS } from "./artifact/file"
import { ArtifactView } from "./artifact-view"
import { ChartView } from "./chart-view"
import { VIEW_LABELS, viewLocale, type ViewLocale } from "./locale"
import { MapView } from "./map-view"
import { StatsView } from "./stats-view"
import { presentationValue, resultValue, type ViewApp } from "./view"
import { render_chartSchema } from "../../../shared/presentation/tools"

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

/** A page that grants every request a view sends it. */
function fakeApp() {
  return {
    readServerResource: vi.fn(async () => ({ contents: [] })),
    downloadFile: vi.fn(async () => ({})),
    openLink: vi.fn(async () => ({})),
    requestDisplayMode: vi.fn(async () => ({ mode: "inline" as const })),
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

  /** Shows one file the page grants, served with `body`. */
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
      <ArtifactView {...view} context={{ ...files(address), ...next }} />
    )
    const { rerender } = render(shown(context))
    return {
      app: view.app,
      rerender: (next: McpUiHostContext) => rerender(shown(next)),
    }
  }

  it.each([
    ["Markdown by its extension", { filename: "brief.md" }, "# Launch brief"],
    [
      "Markdown by its type",
      { filename: "brief", mimeType: "text/markdown" },
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

  it("shows an HTML file's source from the keyboard", async () => {
    const html = "<h1>Launch plan</h1>"
    showFile({ filename: "plan.html" }, html)
    await userEvent.click(await screen.findByRole("tab", { name: "Preview" }))
    await userEvent.keyboard("{ArrowRight}")
    const source = screen.getByRole("tab", { name: "Source" })
    expect(source).toHaveFocus()
    expect(source).toHaveAttribute("aria-selected", "true")
    expect(screen.getByRole("tabpanel")).toHaveTextContent(html)
    expect(screen.queryByTitle("HTML preview")).toBeNull()
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

  it("asks for the side panel on a press only when offered and not there", async () => {
    const offered: McpUiHostContext = {
      availableDisplayModes: ["inline", "pip"],
    }
    const { app, rerender } = showFile(
      { filename: "notes.txt" },
      "Quarterly notes"
    )
    await userEvent.click(await screen.findByText("Quarterly notes"))
    expect(app.requestDisplayMode).not.toHaveBeenCalled()

    rerender({ ...offered, displayMode: "pip" })
    await userEvent.click(screen.getByText("Quarterly notes"))
    expect(app.requestDisplayMode).not.toHaveBeenCalled()

    rerender({ ...offered, displayMode: "inline" })
    await userEvent.click(screen.getByText("Quarterly notes"))
    expect(app.requestDisplayMode.mock.calls).toEqual([[{ mode: "pip" }]])
  })

  it("keeps a press on a link or inside a selection from asking for the side panel", async () => {
    const { app } = showFile(
      { filename: "brief.md" },
      "Quarterly notes and [Roadmap](https://example.com/roadmap)",
      { availableDisplayModes: ["inline", "pip"], displayMode: "inline" }
    )
    await userEvent.click(await screen.findByRole("link", { name: "Roadmap" }))
    const text = screen.getByText(/Quarterly notes/u)
    window.getSelection()!.selectAllChildren(text)
    await userEvent.click(text)
    expect(app.requestDisplayMode).not.toHaveBeenCalled()
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
          context={files(address)}
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

  it("fetches again once a renewed address follows a refused one, and links the current address", async () => {
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
      <ArtifactView {...view} context={files(first)} />
    )
    expect(await screen.findByText("Can't reach this file.")).toBeVisible()

    rerender(<ArtifactView {...view} context={files(second)} />)
    expect(await screen.findByText("Quarterly notes")).toBeVisible()
    rerender(<ArtifactView {...view} context={files(third)} />)
    await userEvent.click(
      screen.getByRole("button", { name: "Open in new tab" })
    )
    expect(view.app.openLink).toHaveBeenCalledWith({ url: third })
    expect(fetched).toEqual([first, second])

    await userEvent.click(screen.getByRole("button", { name: "Refresh" }))
    expect(await screen.findByText("Quarterly notes")).toBeVisible()
    expect(fetched).toEqual([first, second, third])
  })

  it("shows HTML only in a frame that runs none of its scripts", async () => {
    const html =
      "<h1>Launch plan</h1><script>parent.postMessage('ran', '*')</script>"
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(html))
    )
    // HTML keeps its own limit while text is held to 8 bytes.
    render(
      <ArtifactView
        {...props({ filename: "plan.html" })}
        context={files("https://aos.test/files/plan.html?pass=one")}
        previewLimits={{ ...PREVIEW_LIMITS, text: 8 }}
      />
    )

    const frame = await screen.findByTitle("HTML preview")
    expect(frame).toHaveAttribute("sandbox", "")
    expect(frame).toHaveAttribute("srcdoc", html)
    expect(screen.queryByRole("heading", { name: "Launch plan" })).toBeNull()
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
    expect(await screen.findByText("Quarterly notes")).toBeVisible()
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
