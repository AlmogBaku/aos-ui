// The generated Agent icon pool: 34 robot silhouettes × 8 muted tones. Order
// is part of the contract: allocation breaks ties by pool order, and saved
// tokens name entries by slug. Append only; never reorder or rename.

/** One filled shape of a silhouette, drawn on a 48 × 48 view box. */
export type SilhouetteShape =
  | { kind: "rect"; x: number; y: number; width: number; height: number }
  | { kind: "circle"; cx: number; cy: number; r: number }
  | { kind: "path"; d: string; evenOdd?: true }

export interface Silhouette {
  readonly slug: string
  readonly shapes: readonly SilhouetteShape[]
  /** Centre of the pair sensor in view box units. */
  readonly sensor: { readonly x: number; readonly y: number }
  /** The sensor sits on a cut-out, so it takes the shape colour. */
  readonly hollow: boolean
}

export interface Tone {
  readonly slug: string
  /** OKLCH lightness, chroma and hue of the tile background. */
  readonly l: number
  readonly c: number
  readonly h: number
}

/** A resolved icon: indices into `silhouettes` and `tones`. */
export type AvatarPair = readonly [silhouette: number, tone: number]

const rect = (
  x: number,
  y: number,
  width: number,
  height: number
): SilhouetteShape => ({ kind: "rect", x, y, width, height })
const path = (d: string): SilhouetteShape => ({ kind: "path", d })
const evenOdd = (d: string): SilhouetteShape => ({
  kind: "path",
  d,
  evenOdd: true,
})
const face = (
  slug: string,
  shapes: SilhouetteShape[],
  x: number,
  y: number,
  hollow = false
): Silhouette => ({ slug, shapes, sensor: { x, y }, hollow })

export const silhouettes: readonly Silhouette[] = [
  face("block", [rect(12, 12, 24, 24)], 24, 22),
  face("slab", [rect(17, 7, 14, 34)], 24, 17),
  face("plate", [rect(5, 17, 38, 14)], 24, 24),
  face("frame", [evenOdd("M9 9h30v30H9zM15 15v18h18V15z")], 24, 23, true),
  face("peak", [path("M24 7l18 33H6z")], 24, 30),
  face("drop", [path("M6 9h36L24 41z")], 24, 18),
  face("diamond", [path("M24 5l19 19-19 19L5 24z")], 24, 23),
  face(
    "hollow-diamond",
    [evenOdd("M24 4l20 20-20 20L4 24zM24 13l-11 11 11 11 11-11z")],
    24,
    24,
    true
  ),
  face("hexagon", [path("M15 12h18l9 12-9 12H15L6 24z")], 24, 23),
  face("hammer", [path("M6 10h36v13H31v17H17V23H6z")], 24, 16.5),
  face("arch", [path("M8 39V10h32v29H30V22H18v17z")], 24, 16),
  face("cup", [path("M8 10h10v17h12V10h10v28H8z")], 24, 32.5),
  face("plus", [path("M18 7h12v11h11v12H30v11H18V30H7V18h11z")], 24, 24),
  face("stack", [rect(9, 9, 30, 13), rect(9, 26, 30, 13)], 24, 15.5),
  face("hourglass", [path("M8 8h32L27 24l13 16H8l13-16z")], 24, 13),
  face("lean", [path("M18 12h24l-12 24H6z")], 24, 22),
  face("wedge", [path("M8 41V7l34 34z")], 19, 32),
  face("house", [path("M24 6l16 13v21H8V19z")], 24, 27),
  face("pillars", [rect(9, 9, 13, 30), rect(26, 9, 13, 30)], 24, 18),
  face(
    "hollow-hexagon",
    [
      evenOdd(
        "M14 10h20l10 14-10 14H14L4 24zM17.5 16l-5.5 8 5.5 8h13l5.5-8-5.5-8z"
      ),
    ],
    24,
    24,
    true
  ),
  face("bowl", [path("M9 10h30v13a15 15 0 0 1-30 0z")], 24, 18),
  face("disc", [{ kind: "circle", cx: 24, cy: 24, r: 15 }], 24, 22),
  face(
    "ring",
    [
      evenOdd(
        "M24 8a16 16 0 1 0 0 32a16 16 0 1 0 0-32zM24 15a9 9 0 1 1 0 18a9 9 0 1 1 0-18z"
      ),
    ],
    24,
    24,
    true
  ),
  face(
    "hollow-peak",
    [evenOdd("M24 5l20 36H4zM24 19l-8.5 15h17z")],
    24,
    37.5,
    true
  ),
  face(
    "split-disc",
    [path("M22.5 9a15 15 0 0 0 0 30zM25.5 9a15 15 0 0 1 0 30z")],
    24,
    22
  ),
  face("corner", [path("M9 9h12v18h18v12H9z")], 24, 33),
  face("steps", [path("M7 40V28h11V18h11V8h12v32z")], 24, 34),
  face("arrow", [path("M24 6l18 17H31v17H17V23H6z")], 24, 18),
  face(
    "window",
    [
      evenOdd(
        "M9 9h30v30H9zM13 13v9h9v-9zM26 13v9h9v-9zM13 26v9h9v-9zM26 26v9h9v-9z"
      ),
    ],
    24,
    17.5,
    true
  ),
  face("crop", [rect(11, 11, 26, 40)], 24, 22),
  face("chamfer-crop", [path("M17 10h14l7 7v34H10V17z")], 24, 23),
  face("spire-crop", [path("M24 7l14 12v32H10V19z")], 24, 26),
  face("arc-crop", [path("M10 51V24a14 14 0 0 1 28 0v27z")], 24, 25),
  face("slope-crop", [path("M10 17l28-7v41H10z")], 24, 24),
]

export const tones: readonly Tone[] = [
  { slug: "slate", l: 0.33, c: 0.012, h: 260 },
  { slug: "red", l: 0.42, c: 0.09, h: 25 },
  { slug: "amber", l: 0.47, c: 0.08, h: 65 },
  { slug: "green", l: 0.42, c: 0.07, h: 150 },
  { slug: "teal", l: 0.42, c: 0.06, h: 200 },
  { slug: "blue", l: 0.41, c: 0.08, h: 250 },
  { slug: "violet", l: 0.4, c: 0.09, h: 295 },
  { slug: "rose", l: 0.41, c: 0.08, h: 350 },
]

/** `${silhouetteSlug}/${toneSlug}`, for example `ring/blue`. */
export function avatarToken([silhouette, tone]: AvatarPair): string {
  return `${silhouettes[silhouette].slug}/${tones[tone].slug}`
}
