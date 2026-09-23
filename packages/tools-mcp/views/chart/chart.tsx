"use client"

import { useMemo, useCallback, memo } from "react"
import {
  BarChart,
  LineChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts"

import {
  cn,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  type ChartConfig,
} from "./_adapter"
import type { ChartProps } from "./schema"

const DEFAULT_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
]

export const Chart = memo(function Chart({
  id,
  type,
  data,
  xKey,
  series,
  colors,
  showLegend = false,
  showGrid = true,
  className,
  onDataPointClick,
}: ChartProps) {
  const palette = colors?.length ? colors : DEFAULT_COLORS

  const seriesColors = useMemo(
    () =>
      series.map(
        (seriesItem, index) =>
          seriesItem.color ?? palette[index % palette.length]
      ),
    [series, palette]
  )

  const chartConfig: ChartConfig = useMemo(
    () =>
      Object.fromEntries(
        series.map((seriesItem, index) => [
          seriesItem.key,
          {
            label: seriesItem.label,
            color: seriesColors[index],
          },
        ])
      ),
    [series, seriesColors]
  )

  const handleDataPointClick = useCallback(
    (
      seriesKey: string,
      seriesLabel: string,
      payload: Record<string, unknown>,
      index: number
    ) => {
      onDataPointClick?.({
        seriesKey,
        seriesLabel,
        xValue: payload[xKey],
        yValue: payload[seriesKey],
        index,
        payload,
      })
    },
    [onDataPointClick, xKey]
  )

  const ChartComponent = type === "bar" ? BarChart : LineChart

  // The view's own card is the host's: the chart draws flat, with no frame or
  // heading of its own.
  return (
    <ChartContainer
      config={chartConfig}
      className={cn("aspect-auto h-64 w-full", className)}
      data-tool-ui-id={id}
    >
      <ChartComponent data={data} accessibilityLayer>
        {showGrid && <CartesianGrid vertical={false} />}
        <XAxis
          dataKey={xKey}
          tickLine={false}
          tickMargin={10}
          axisLine={false}
        />
        <YAxis width="auto" tickLine={false} axisLine={false} tickMargin={8} />
        <ChartTooltip content={<ChartTooltipContent />} />
        {showLegend && (
          <ChartLegend itemSorter={null} content={<ChartLegendContent />} />
        )}

        {type === "bar" &&
          series.map((s, i) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              fill={seriesColors[i]}
              radius={4}
              onClick={(data) => {
                const point = data as typeof data & { index?: number }
                handleDataPointClick(
                  s.key,
                  s.label,
                  point.payload,
                  point.index ?? 0
                )
              }}
              cursor={onDataPointClick ? "pointer" : undefined}
            />
          ))}

        {type === "line" &&
          series.map((s, i) => (
            <Line
              key={s.key}
              dataKey={s.key}
              type="monotone"
              stroke={seriesColors[i]}
              strokeWidth={2}
              dot={{ r: 4, cursor: onDataPointClick ? "pointer" : undefined }}
              activeDot={{
                r: 6,
                cursor: onDataPointClick ? "pointer" : undefined,
                // Recharts provides the rendered point at runtime, while its
                // public active-dot type only exposes SVG dot attributes.
                onClick: ((dotData: {
                  payload?: Record<string, unknown>
                  index?: number
                }) => {
                  if (!dotData.payload) return
                  handleDataPointClick(
                    s.key,
                    s.label,
                    dotData.payload,
                    dotData.index ?? 0
                  )
                }) as never,
              }}
            />
          ))}
      </ChartComponent>
    </ChartContainer>
  )
})
