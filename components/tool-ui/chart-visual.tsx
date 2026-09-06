import type { ChartPayload } from "./payloads/chart"

const pieColors = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
]

function pointOnCircle(cx: number, cy: number, radius: number, angle: number) {
  const radians = ((angle - 90) * Math.PI) / 180
  return {
    x: cx + radius * Math.cos(radians),
    y: cy + radius * Math.sin(radians),
  }
}

function pieSlicePath(
  cx: number,
  cy: number,
  radius: number,
  startAngle: number,
  endAngle: number
) {
  const start = pointOnCircle(cx, cy, radius, endAngle)
  const end = pointOnCircle(cx, cy, radius, startAngle)
  const largeArc = endAngle - startAngle > 180 ? 1 : 0
  return `M ${cx} ${cy} L ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArc} 0 ${end.x} ${end.y} Z`
}

export function ChartVisual({
  chart,
}: {
  chart: NonNullable<ChartPayload["result"]>
}) {
  const width = 640
  const height = 220
  const padding = 24
  const values = chart.data.flatMap((row) =>
    chart.series.map((series) => Number(row[series.key]))
  )
  const min = Math.min(0, ...values)
  const max = Math.max(1, ...values)
  const range = max - min || 1
  const plotWidth = width - padding * 2
  const plotHeight = height - padding * 2

  if (chart.type === "pie") {
    const series = chart.series[0]
    const total = chart.data.reduce(
      (sum, row) => sum + Number(row[series.key]),
      0
    )
    return (
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="aspect-[16/6] w-full rounded-lg bg-muted/30"
        aria-hidden="true"
        data-testid="chart-visual-pie"
      >
        {chart.data.map((row, index) => {
          const startValue = chart.data
            .slice(0, index)
            .reduce((sum, previous) => sum + Number(previous[series.key]), 0)
          const startAngle = (startValue / total) * 360
          const nextAngle = startAngle + (Number(row[series.key]) / total) * 360
          const path = pieSlicePath(
            width / 2,
            height / 2,
            88,
            startAngle,
            nextAngle
          )
          return (
            <path
              key={`${String(row[chart.xKey])}-${index}`}
              d={path}
              fill={pieColors[index % pieColors.length]}
              stroke="var(--background)"
              strokeWidth="2"
            />
          )
        })}
      </svg>
    )
  }

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="aspect-[16/6] w-full rounded-lg bg-muted/30"
      aria-hidden="true"
      data-testid="chart-visual"
    >
      <path
        d={`M ${padding} ${height - padding} H ${width - padding}`}
        fill="none"
        stroke="currentColor"
        className="text-border"
      />
      {chart.series.map((series, seriesIndex) => {
        const points = chart.data
          .map((row, index) => {
            const x =
              padding +
              (chart.data.length === 1
                ? plotWidth / 2
                : (index / (chart.data.length - 1)) * plotWidth)
            const y =
              padding +
              (1 - (Number(row[series.key]) - min) / range) * plotHeight
            return `${x},${y}`
          })
          .join(" ")

        return (
          <polyline
            key={series.key}
            points={points}
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={
              seriesIndex === 0 ? "text-primary" : "text-muted-foreground"
            }
          />
        )
      })}
    </svg>
  )
}
