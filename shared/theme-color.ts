/**
 * The installed window's title bar is browser chrome painted outside the page,
 * so no CSS rule can reach it: the only inputs are the `theme-color` meta tags
 * and the web app manifest, both of which take a literal color and cannot
 * resolve a custom property. This module keeps `src/app/globals.css` the single
 * source of truth anyway, by reading the token at build time and converting it
 * to the sRGB hex those two consumers require.
 */

const TITLE_BAR_TOKEN = "--sidebar"

/** OKLab to linear sRGB, per Björn Ottosson's reference matrices. */
function oklabToLinearSrgb(lightness: number, a: number, b: number) {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
}

function encodeGamma(channel: number) {
  const linear = Math.min(Math.max(channel, 0), 1)
  const encoded =
    linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055
  return Math.round(encoded * 255)
}

/** `oklch(0.975 0.003 265)` to `#f6f7f9`. Hue is in degrees. */
export function oklchToHex(lightness: number, chroma: number, hue: number) {
  const radians = (hue * Math.PI) / 180
  const channels = oklabToLinearSrgb(
    lightness,
    chroma * Math.cos(radians),
    chroma * Math.sin(radians)
  )
  return `#${channels
    .map((channel) => encodeGamma(channel).toString(16).padStart(2, "0"))
    .join("")}`
}

function readBlock(css: string, selector: string) {
  const start = css.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`theme color: no \`${selector}\` block`)
  const end = css.indexOf("\n}", start)
  if (end < 0)
    throw new Error(`theme color: unterminated \`${selector}\` block`)
  return css.slice(start, end)
}

function readTitleBarToken(css: string, selector: string) {
  const block = readBlock(css, selector)
  const declaration = new RegExp(
    `${TITLE_BAR_TOKEN}:\\s*oklch\\(\\s*([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)\\s*\\)`
  ).exec(block)
  if (!declaration)
    throw new Error(
      `theme color: \`${selector}\` has no \`${TITLE_BAR_TOKEN}: oklch(...)\``
    )
  return oklchToHex(
    Number(declaration[1]),
    Number(declaration[2]),
    Number(declaration[3])
  )
}

/**
 * The title-bar color for each theme, derived from `--sidebar`: the surface the
 * title bar meets at both top corners of an installed window. Throws rather
 * than guessing, so a renamed or reformatted token fails the build instead of
 * shipping a mismatched window.
 */
export function readTitleBarColors(globalsCss: string) {
  return {
    light: readTitleBarToken(globalsCss, ":root"),
    dark: readTitleBarToken(globalsCss, ".dark"),
  }
}
