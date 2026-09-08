"use client"

import { lazy, Suspense, useState } from "react"
import type { ChartPayload } from "./payloads/chart"

import { Button } from "@/components/ui/button"

import { ToolChrome } from "./common"
import { LazyVisualBoundary } from "./lazy-boundary"
import { normalizeRichToolState } from "./lifecycle"
import { useToolUiLocale } from "./locale"
import type { RichToolPart } from "./types"

const LegacyPieChartVisual = lazy(() =>
  import("./chart-visual").then((module) => ({ default: module.ChartVisual }))
)
const RegistryChart = lazy(() =>
  import("./chart/index").then((module) => ({ default: module.Chart }))
)

export function ChartTool({
  part,
  payload,
}: {
  part: RichToolPart
  payload: ChartPayload
}) {
  const [showData, setShowData] = useState(false)
  const state = normalizeRichToolState(part)
  const { labels } = useToolUiLocale()
  const chart = payload.result

  return (
    <ToolChrome title={payload.args.title} state={state}>
      {chart ? (
        <>
          <LazyVisualBoundary fallbackLabel={labels.chart.unavailable}>
            <Suspense
              fallback={
                <p className="text-sm text-muted-foreground" role="status">
                  {labels.chart.loading}
                </p>
              }
            >
              {chart.type === "pie" ? (
                <LegacyPieChartVisual chart={chart} />
              ) : (
                <RegistryChart
                  id={part.toolCallId}
                  className="min-w-0"
                  type={chart.type}
                  title={payload.args.title}
                  data={chart.data}
                  xKey={chart.xKey}
                  series={chart.series}
                  showLegend
                />
              )}
            </Suspense>
          </LazyVisualBoundary>
          <div className="flex flex-col gap-2">
            <div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-expanded={showData}
                aria-controls={`${part.toolCallId}-chart-data`}
                onClick={() => setShowData((current) => !current)}
              >
                {showData ? labels.chart.hideData : labels.chart.showData}
              </Button>
            </div>
            {showData ? (
              <div
                id={`${part.toolCallId}-chart-data`}
                className="overflow-x-auto"
              >
                <table
                  className="w-full border-collapse text-start text-sm tabular-nums"
                  aria-label={labels.chart.dataLabel(payload.args.title)}
                >
                  <thead>
                    <tr className="border-b border-border">
                      <th
                        scope="col"
                        className="px-2 py-1.5 font-medium"
                        dir="ltr"
                      >
                        {chart.xKey}
                      </th>
                      {chart.series.map((series) => (
                        <th
                          key={series.key}
                          scope="col"
                          className="px-2 py-1.5 font-medium"
                        >
                          <bdi dir="auto">{series.label}</bdi>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {chart.data.map((row, index) => (
                      <tr
                        key={`${String(row[chart.xKey])}-${index}`}
                        className="border-b border-border last:border-0"
                      >
                        <th scope="row" className="px-2 py-1.5 font-normal">
                          <bdi dir="auto">{String(row[chart.xKey])}</bdi>
                        </th>
                        {chart.series.map((series) => (
                          <td key={series.key} className="px-2 py-1.5">
                            <bdi dir="ltr">{String(row[series.key])}</bdi>
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">{labels.chart.waiting}</p>
      )}
    </ToolChrome>
  )
}
