import type { z } from "zod"

import type { render_statsSchema } from "../../../shared/presentation/tools"
import { INTL_LOCALE } from "./locale"
import { StatsDisplay } from "./stats-display/stats-display"
import type { ViewProps } from "./view"

export function StatsView({
  value,
  locale,
}: ViewProps<z.infer<typeof render_statsSchema>>) {
  return (
    <div className="p-1">
      <StatsDisplay
        id="stats"
        title={value.title}
        description={value.description}
        stats={value.stats}
        locale={INTL_LOCALE[locale]}
      />
    </div>
  )
}
