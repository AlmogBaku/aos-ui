import type { z } from "zod"

import type { render_chartSchema } from "../../../../shared/presentation/tools"

const pieColors = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
]

const SIZE = 160
const CENTER = SIZE / 2
const RADIUS = CENTER - 2

function pointOnCircle(angle: number) {
  const radians = ((angle - 90) * Math.PI) / 180
  return {
    x: CENTER + RADIUS * Math.cos(radians),
    y: CENTER + RADIUS * Math.sin(radians),
  }
}

function pieSlicePath(startAngle: number, endAngle: number) {
  const start = pointOnCircle(endAngle)
  const end = pointOnCircle(startAngle)
  const largeArc = endAngle - startAngle > 180 ? 1 : 0
  return `M ${CENTER} ${CENTER} L ${start.x} ${start.y} A ${RADIUS} ${RADIUS} 0 ${largeArc} 0 ${end.x} ${end.y} Z`
}

/**
 * A single-series pie with a legend that names every slice, its value and its
 * share; Recharts' cartesian charts cover line and bar.
 */
export function PieChart({
  chart,
  locale,
}: {
  chart: z.infer<typeof render_chartSchema>
  locale: string
}) {
  const series = chart.series[0]
  const values = chart.data.map((row) => Number(row[series.key]))
  const total = values.reduce((sum, value) => sum + value, 0)
  const number = new Intl.NumberFormat(locale)
  const percent = new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: 1,
  })
  const slices = chart.data.map((row, index) => {
    const before = values.slice(0, index).reduce((sum, value) => sum + value, 0)
    return {
      key: `${String(row[chart.xKey])}-${index}`,
      label: String(row[chart.xKey]),
      value: values[index],
      color: pieColors[index % pieColors.length],
      startAngle: (before / total) * 360,
      endAngle: ((before + values[index]) / total) * 360,
    }
  })
  return (
    <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
      <svg
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="size-40 shrink-0"
        aria-hidden="true"
      >
        {slices.map((slice) =>
          slice.value === total ? (
            <circle
              key={slice.key}
              cx={CENTER}
              cy={CENTER}
              r={RADIUS}
              fill={slice.color}
            />
          ) : slice.value > 0 ? (
            <path
              key={slice.key}
              d={pieSlicePath(slice.startAngle, slice.endAngle)}
              fill={slice.color}
              stroke="var(--background)"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
          ) : null
        )}
      </svg>
      <ul className="m-0 flex max-w-xs min-w-48 flex-1 list-none flex-col gap-2 p-0 text-sm">
        {slices.map((slice) => (
          <li key={slice.key} className="flex items-center gap-2">
            <span
              className="size-2.5 shrink-0 rounded-xs"
              style={{ backgroundColor: slice.color }}
              aria-hidden="true"
            />
            <bdi dir="auto" className="min-w-0 flex-1 truncate">
              {slice.label}
            </bdi>
            <span className="text-foreground tabular-nums">
              {number.format(slice.value)}
            </span>
            <span className="w-12 text-end text-muted-foreground tabular-nums">
              {percent.format(slice.value / total)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
