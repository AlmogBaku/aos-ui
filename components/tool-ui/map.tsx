"use client"

import { lazy, Suspense, useState } from "react"
import type { MapPayload } from "./payloads/map"

import { Button } from "@/components/ui/button"

import { ToolChrome } from "./common"
import { LazyVisualBoundary } from "./lazy-boundary"
import { normalizeRichToolState } from "./lifecycle"
import { useToolUiLocale } from "./locale"
import type { RichToolPart } from "./types"

const RegistryGeoMap = lazy(() =>
  import("./geo-map/index").then((module) => ({ default: module.GeoMap }))
)

export function MapTool({
  part,
  payload,
}: {
  part: RichToolPart
  payload: MapPayload
}) {
  const [showLocations, setShowLocations] = useState(false)
  const state = normalizeRichToolState(part)
  const map = payload.result
  const { labels } = useToolUiLocale()

  return (
    <ToolChrome title={payload.args.title} state={state}>
      {map ? (
        <>
          <LazyVisualBoundary fallbackLabel={labels.map.unavailable}>
            <Suspense
              fallback={
                <p className="text-sm text-muted-foreground" role="status">
                  {labels.map.loading}
                </p>
              }
            >
              <RegistryGeoMap
                id={part.toolCallId}
                title={payload.args.title}
                markers={map.locations.map((location) => ({
                  id: location.id,
                  label: location.label,
                  lat: location.latitude,
                  lng: location.longitude,
                }))}
                viewport={{ mode: "fit", target: "markers" }}
              />
            </Suspense>
          </LazyVisualBoundary>
          <div className="flex flex-col gap-2">
            <div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-expanded={showLocations}
                aria-controls={`${part.toolCallId}-map-locations`}
                onClick={() => setShowLocations((current) => !current)}
              >
                {showLocations
                  ? labels.map.hideLocations
                  : labels.map.showLocations}
              </Button>
            </div>
            {showLocations ? (
              <ul
                id={`${part.toolCallId}-map-locations`}
                className="flex flex-col gap-1 text-sm tabular-nums"
                aria-label={labels.map.locationsLabel(payload.args.title)}
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
            ) : null}
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">{labels.map.waiting}</p>
      )}
    </ToolChrome>
  )
}
