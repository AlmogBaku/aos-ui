import maplibregl, {
  type LayerSpecification,
  type StyleSpecification,
} from "maplibre-gl"
import "maplibre-gl/dist/maplibre-gl.css"
import { useEffect, useRef, useState, useSyncExternalStore } from "react"

import type { ViewLocale } from "../locale"
import styles from "./geo-map-theme.module.css"

export type GeoMapLocation = {
  id: string
  label: string
  latitude: number
  longitude: number
}

type Theme = "light" | "dark"

/** OpenFreeMap vector styles: free, keyless, and served from one host. */
const STYLE_URLS: Record<Theme, string> = {
  light: "https://tiles.openfreemap.org/styles/positron",
  dark: "https://tiles.openfreemap.org/styles/dark",
}

const SINGLE_LOCATION_ZOOM = 10
/** Clear of the title overlay at the top and the attribution at the bottom. */
const FIT_PADDING = { top: 72, bottom: 40, left: 40, right: 40 }

/** MapLibre's control labels, keyed by its UI string ids. */
const CONTROL_LABELS: Record<ViewLocale, Record<string, string>> = {
  en: {
    "NavigationControl.ZoomIn": "Zoom in",
    "NavigationControl.ZoomOut": "Zoom out",
    "AttributionControl.ToggleAttribution": "Map credits",
  },
  he: {
    "NavigationControl.ZoomIn": "התקרבות",
    "NavigationControl.ZoomOut": "התרחקות",
    "AttributionControl.ToggleAttribution": "קרדיטים למפה",
  },
}

const CONTROL_SELECTORS: Record<string, string> = {
  "NavigationControl.ZoomIn": ".maplibregl-ctrl-zoom-in",
  "NavigationControl.ZoomOut": ".maplibregl-ctrl-zoom-out",
  "AttributionControl.ToggleAttribution": ".maplibregl-ctrl-attrib-button",
}

const MARKER_CLASS =
  "block size-4 cursor-pointer rounded-full border-2 border-background bg-primary shadow-md outline-none focus-visible:ring-2 focus-visible:ring-ring"

/** The view document's theme, which the host sets as `data-theme`. */
function readTheme(): Theme {
  const theme = document.documentElement.getAttribute("data-theme")
  if (theme === "dark" || theme === "light") return theme
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light"
}

function subscribeTheme(onChange: () => void) {
  const media = window.matchMedia?.("(prefers-color-scheme: dark)")
  media?.addEventListener("change", onChange)
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  })
  return () => {
    media?.removeEventListener("change", onChange)
    observer.disconnect()
  }
}

/**
 * Labels in their Latin form only. Shaping a right-to-left script needs
 * MapLibre's RTL text plugin, a remote script the sandbox does not load, so a
 * Hebrew or Arabic name would otherwise render reversed.
 */
function latinLabels(
  _previous: StyleSpecification | undefined,
  next: StyleSpecification
): StyleSpecification {
  const latin = ["coalesce", ["get", "name:latin"], ["get", "name"]]
  return {
    ...next,
    layers: next.layers.map((layer): LayerSpecification => {
      if (layer.type !== "symbol") return layer
      const field = layer.layout?.["text-field"]
      if (!JSON.stringify(field ?? null).includes("name:nonlatin")) return layer
      return {
        ...layer,
        layout: { ...layer.layout, "text-field": latin },
      } as LayerSpecification
    }),
  }
}

/** Relabels the controls when the host's locale arrives after the map. */
function labelControls(element: HTMLElement, locale: ViewLocale) {
  for (const [id, label] of Object.entries(CONTROL_LABELS[locale])) {
    const control = element.querySelector(CONTROL_SELECTORS[id] ?? "")
    control?.setAttribute("aria-label", label)
    control?.setAttribute("title", label)
  }
}

/**
 * MapLibre's compact attribution, collapsed and as plain text. MapLibre
 * expands it the first time it turns compact, so that first expansion is
 * undone; and its credits are links to a new tab, which the sandbox cannot
 * open, so each is unwrapped to its text. It turns compact on a resize, which
 * `load` forces once the credits have arrived.
 */
function settleAttribution(map: maplibregl.Map, element: HTMLElement) {
  const details = element.querySelector(".maplibregl-ctrl-attrib")
  if (!details) return () => {}
  const collapse = new MutationObserver(() => {
    if (!details.classList.contains("maplibregl-compact")) return
    collapse.disconnect()
    details.classList.remove("maplibregl-compact-show")
    details.removeAttribute("open")
  })
  collapse.observe(details, { attributes: true, attributeFilter: ["class"] })
  const unwrap = () => {
    for (const link of details.querySelectorAll("a"))
      link.replaceWith(link.textContent ?? "")
  }
  const plain = new MutationObserver(unwrap)
  plain.observe(details, { childList: true, subtree: true })
  map.once("load", () => map.resize())
  return () => {
    collapse.disconnect()
    plain.disconnect()
  }
}

function markerElement(label: string) {
  const element = document.createElement("div")
  element.className = MARKER_CLASS
  element.setAttribute("role", "button")
  element.setAttribute("aria-label", label)
  return element
}

function popupContent(label: string) {
  const text = document.createElement("p")
  text.dir = "auto"
  text.className = "text-sm font-semibold text-foreground"
  text.textContent = label
  return text
}

function frame(map: maplibregl.Map, locations: readonly GeoMapLocation[]) {
  const [first, ...rest] = locations
  if (!first) return
  if (rest.length === 0) {
    map.jumpTo({
      center: [first.longitude, first.latitude],
      zoom: SINGLE_LOCATION_ZOOM,
    })
    return
  }
  const bounds = new maplibregl.LngLatBounds()
  for (const location of locations)
    bounds.extend([location.longitude, location.latitude])
  map.fitBounds(bounds, { padding: FIT_PADDING, animate: false })
}

/**
 * The locations on an OpenFreeMap basemap, fitted to their bounds. Each marker
 * is keyboard-focusable and opens its label; the view's location list stays
 * the textual alternative.
 */
export function GeoMap({
  title,
  locations,
  locale,
  loadingLabel,
}: {
  title: string
  locations: readonly GeoMapLocation[]
  locale: ViewLocale
  loadingLabel: string
}) {
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const theme = useSyncExternalStore(subscribeTheme, readTheme)
  const themeRef = useRef(theme)
  const localeRef = useRef(locale)
  const [ready, setReady] = useState(false)
  const locationsKey = JSON.stringify(locations)

  useEffect(() => {
    const element = container.current
    if (!element) return
    const current: readonly GeoMapLocation[] = JSON.parse(locationsKey)
    let map: maplibregl.Map
    try {
      map = new maplibregl.Map({
        container: element,
        attributionControl: { compact: true },
        locale: CONTROL_LABELS[localeRef.current],
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
      })
    } catch {
      // No WebGL: the location list remains the way to read the map.
      return
    }
    map.setStyle(STYLE_URLS[themeRef.current], { transformStyle: latinLabels })
    map.touchZoomRotate.disableRotation()
    map.addControl(
      new maplibregl.NavigationControl({ showCompass: false }),
      "top-right"
    )
    const releaseAttribution = settleAttribution(map, element)
    for (const location of current) {
      new maplibregl.Marker({ element: markerElement(location.label) })
        .setLngLat([location.longitude, location.latitude])
        .setPopup(
          new maplibregl.Popup({ offset: 12, maxWidth: "18rem" }).setDOMContent(
            popupContent(location.label)
          )
        )
        .addTo(map)
    }
    frame(map, current)
    map.once("load", () => setReady(true))
    mapRef.current = map
    return () => {
      mapRef.current = null
      releaseAttribution()
      map.remove()
    }
  }, [locationsKey])

  useEffect(() => {
    localeRef.current = locale
    if (container.current) labelControls(container.current, locale)
  }, [locale])

  useEffect(() => {
    if (themeRef.current === theme) return
    themeRef.current = theme
    mapRef.current?.setStyle(STYLE_URLS[theme], { transformStyle: latinLabels })
  }, [theme])

  return (
    // A fixed height: the map canvas has no intrinsic size to grow from.
    <div
      className={`relative h-80 w-full overflow-hidden rounded-lg border bg-muted ${styles.root}`}
      role="region"
      aria-label={title}
    >
      <div ref={container} className="size-full" />
      <p className="pointer-events-none absolute start-3 top-3 z-10 max-w-3/4 rounded-lg border border-border bg-background/80 px-3 py-2 text-sm leading-tight font-semibold text-foreground shadow-sm backdrop-blur-md">
        {title}
      </p>
      {!ready && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          {loadingLabel}
        </div>
      )}
    </div>
  )
}
