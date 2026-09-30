import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

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

  it("prefers a valid tool input", () => {
    expect(presentationValue(render_chartSchema, chart, undefined)).toEqual(
      parsedChart
    )
  })

  it("falls back to the result's structured value", () => {
    expect(
      presentationValue(render_chartSchema, undefined, {
        content: [],
        structuredContent: { ok: true, value: chart },
      })
    ).toEqual(parsedChart)
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

  it.each([
    ["without a length", {}, 3],
    ["with a length above the limit", { "content-length": "256" }, 0],
  ])(
    "stops reading a file %s at the limit and offers Download",
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
        <ArtifactView {...view} context={files(address)} previewLimit={8} />
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
    render(
      <ArtifactView
        {...props({ filename: "plan.html" })}
        context={files("https://aos.test/files/plan.html?pass=one")}
      />
    )

    const frame = await screen.findByTitle("HTML preview")
    expect(frame).toHaveAttribute("sandbox", "")
    expect(frame).toHaveAttribute("srcdoc", html)
    expect(screen.queryByRole("heading", { name: "Launch plan" })).toBeNull()
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
