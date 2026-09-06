import type { MapPayload } from "./payloads/map"

export function MapVisual({
  locations,
}: {
  locations: NonNullable<MapPayload["result"]>["locations"]
}) {
  return (
    <div
      className="relative aspect-[16/7] w-full overflow-hidden rounded-lg border border-border bg-muted/30"
      aria-hidden="true"
      data-testid="map-visual"
    >
      {locations.map((location) => (
        <span
          key={location.id}
          className="absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary ring-2 ring-background"
          style={{
            insetInlineStart: `${((location.longitude + 180) / 360) * 100}%`,
            top: `${((90 - location.latitude) / 180) * 100}%`,
          }}
        />
      ))}
    </div>
  )
}
