import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"

import { ChartView } from "./chart-view"
import { VIEW_LABELS, viewLocale, type ViewLocale } from "./locale"
import { MapView } from "./map-view"
import { StatsView } from "./stats-view"
import { presentationValue, resultValue } from "./view"
import { render_chartSchema } from "../../../shared/presentation/tools"

afterEach(cleanup)

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

function props<T>(value: T, locale: ViewLocale = "en") {
  return { value, locale, labels: VIEW_LABELS[locale] }
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
