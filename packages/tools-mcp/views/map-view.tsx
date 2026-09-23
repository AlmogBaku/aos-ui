import type { z } from "zod"

import type { render_mapSchema } from "../../../shared/presentation/tools"
import { Disclosure } from "./disclosure"
import { GeoMap } from "./geo-map/geo-map"
import type { ViewProps } from "./view"

export function MapView({
  value: map,
  labels,
  locale,
}: ViewProps<z.infer<typeof render_mapSchema>>) {
  return (
    <div className="flex flex-col gap-3 p-3">
      <GeoMap
        title={map.title}
        locations={map.locations}
        locale={locale}
        loadingLabel={labels.map.loading}
      />
      <Disclosure
        show={labels.map.showLocations}
        hide={labels.map.hideLocations}
      >
        <ul
          className="flex flex-col gap-1 text-sm tabular-nums"
          aria-label={labels.map.locationsLabel(map.title)}
        >
          {map.locations.map((location) => (
            <li key={location.id}>
              <bdi dir="auto">{location.label}</bdi>
              {" — "}
              <bdi dir="ltr">
                {location.latitude}, {location.longitude}
              </bdi>
            </li>
          ))}
        </ul>
      </Disclosure>
    </div>
  )
}
