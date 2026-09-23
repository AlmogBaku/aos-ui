import type { z } from "zod"

import type { render_chartSchema } from "../../../shared/presentation/tools"
import { Chart } from "./chart/chart"
import { PieChart } from "./chart/pie"
import { Disclosure } from "./disclosure"
import { INTL_LOCALE } from "./locale"
import { ViewTitle } from "./ui/view-title"
import type { ViewProps } from "./view"

type ChartValue = z.infer<typeof render_chartSchema>

const cell = "px-2 py-1.5 first:ps-0 last:pe-0"

export function ChartView({
  value: chart,
  labels,
  locale,
}: ViewProps<ChartValue>) {
  return (
    <div className="flex flex-col gap-3 p-1">
      <ViewTitle title={chart.title} />
      {chart.type === "pie" ? (
        <PieChart chart={chart} locale={INTL_LOCALE[locale]} />
      ) : (
        <Chart
          id="chart"
          type={chart.type}
          data={chart.data}
          xKey={chart.xKey}
          series={chart.series}
          showLegend
        />
      )}
      <Disclosure show={labels.chart.showData} hide={labels.chart.hideData}>
        <div className="overflow-x-auto">
          <table
            className="w-full border-collapse text-sm tabular-nums"
            aria-label={labels.chart.dataLabel(chart.title)}
          >
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground">
                <th scope="col" className={`${cell} text-start font-medium`}>
                  <bdi dir="auto">{chart.xKey}</bdi>
                </th>
                {chart.series.map((series) => (
                  <th
                    key={series.key}
                    scope="col"
                    className={`${cell} text-end font-medium`}
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
                  <th scope="row" className={`${cell} text-start font-normal`}>
                    <bdi dir="auto">{String(row[chart.xKey])}</bdi>
                  </th>
                  {chart.series.map((series) => (
                    <td key={series.key} className={`${cell} text-end`}>
                      <bdi dir="ltr">{String(row[series.key])}</bdi>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Disclosure>
    </div>
  )
}
