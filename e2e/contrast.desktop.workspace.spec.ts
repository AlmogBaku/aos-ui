import { expect, test, type Page } from "./test"

type SrgbColor = {
  red: number
  green: number
  blue: number
  alpha: number
}

type ContrastSample = {
  foreground: string
  background: string
  ratio: number
}

function encodeSrgbChannel(linearChannel: number) {
  const encoded =
    255 *
    (linearChannel <= 0.0031308
      ? 12.92 * linearChannel
      : 1.055 * linearChannel ** (1 / 2.4) - 0.055)
  return Math.min(255, Math.max(0, encoded))
}

function contrastRatio(foreground: SrgbColor, background: SrgbColor) {
  const composite = (channel: keyof Omit<SrgbColor, "alpha">) =>
    foreground[channel] * foreground.alpha +
    background[channel] * (1 - foreground.alpha)
  const luminance = (color: Pick<SrgbColor, "red" | "green" | "blue">) => {
    const linear = (channel: number) => {
      const srgb = channel / 255
      return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
    }
    return (
      0.2126 * linear(color.red) +
      0.7152 * linear(color.green) +
      0.0722 * linear(color.blue)
    )
  }
  const foregroundLuminance = luminance({
    red: composite("red"),
    green: composite("green"),
    blue: composite("blue"),
  })
  const backgroundLuminance = luminance(background)
  return (
    (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
  )
}

function parseSrgbColor(value: string): SrgbColor {
  const rgbaMatch = value.match(/^rgba?\((.+)\)$/)
  if (rgbaMatch) {
    const [channels, alpha = "1"] = rgbaMatch[1].split("/")
    const parts = channels
      .trim()
      .split(/[\s,]+/)
      .map(Number)
    return {
      red: parts[0],
      green: parts[1],
      blue: parts[2],
      alpha: Number(alpha.trim()),
    }
  }

  const oklchMatch = value.match(/^oklch\((.+)\)$/)
  if (oklchMatch) {
    const [coordinates, alpha = "1"] = oklchMatch[1].split("/")
    const [lightness, chroma, hue] = coordinates.trim().split(/\s+/).map(Number)
    const radians = (hue * Math.PI) / 180
    const a = chroma * Math.cos(radians)
    const b = chroma * Math.sin(radians)
    const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
    const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
    const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3
    const linear = {
      red: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      green: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      blue: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    }
    return {
      red: encodeSrgbChannel(linear.red),
      green: encodeSrgbChannel(linear.green),
      blue: encodeSrgbChannel(linear.blue),
      alpha: Number(alpha.trim()),
    }
  }

  const oklabMatch = value.match(/^oklab\((.+)\)$/)
  if (oklabMatch) {
    const [coordinates, alpha = "1"] = oklabMatch[1].split("/")
    const [lightness, a, b] = coordinates.trim().split(/\s+/).map(Number)
    const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
    const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
    const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3
    const linear = {
      red: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      green: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      blue: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    }
    return {
      red: encodeSrgbChannel(linear.red),
      green: encodeSrgbChannel(linear.green),
      blue: encodeSrgbChannel(linear.blue),
      alpha: Number(alpha.trim()),
    }
  }

  const labMatch = value.match(/^lab\((.+)\)$/)
  if (labMatch) {
    const [coordinates, alpha = "1"] = labMatch[1].split("/")
    const [lightness, a, b] = coordinates.trim().split(/\s+/).map(Number)
    const f = (coordinate: number) => {
      const delta = 6 / 29
      return coordinate > delta
        ? coordinate ** 3
        : 3 * delta ** 2 * (coordinate - 4 / 29)
    }
    const fy = (lightness + 16) / 116
    const xyzD50 = {
      x: 0.96422 * f(fy + a / 500),
      y: f(fy),
      z: 0.82521 * f(fy - b / 200),
    }
    const xyzD65 = {
      x: 0.9555766 * xyzD50.x - 0.0230393 * xyzD50.y + 0.0631636 * xyzD50.z,
      y: -0.0282895 * xyzD50.x + 1.0099416 * xyzD50.y + 0.0210077 * xyzD50.z,
      z: 0.0122982 * xyzD50.x - 0.020483 * xyzD50.y + 1.3299098 * xyzD50.z,
    }
    const linear = {
      red: 3.2404542 * xyzD65.x - 1.5371385 * xyzD65.y - 0.4985314 * xyzD65.z,
      green: -0.969266 * xyzD65.x + 1.8760108 * xyzD65.y + 0.041556 * xyzD65.z,
      blue: 0.0556434 * xyzD65.x - 0.2040259 * xyzD65.y + 1.0572252 * xyzD65.z,
    }
    return {
      red: encodeSrgbChannel(linear.red),
      green: encodeSrgbChannel(linear.green),
      blue: encodeSrgbChannel(linear.blue),
      alpha: Number(alpha.trim()),
    }
  }

  throw new Error(`Unsupported computed CSS color: ${value}`)
}

async function openWorkspace(page: Page, theme: "light" | "dark") {
  await page.goto("/en")
  await expect(page.getByRole("tablist")).toBeVisible()
  if (theme === "dark") {
    await page.getByRole("button", { name: "Dark" }).click()
    await expect(page.locator("html")).toHaveClass(/dark/)
  }
}

async function readContrastSamples(page: Page): Promise<ContrastSample[]> {
  return page
    .evaluate(() => {
      const parse = (value: string) => value
      const background = document.querySelector<HTMLElement>(
        '[data-slot="aui_composer-shell"]'
      )
      const composer = document.querySelector<HTMLElement>(
        ".aui-composer-input"
      )
      const send = document.querySelector<HTMLElement>(
        '[aria-label="Send message"]'
      )
      if (!background || !composer || !send) {
        throw new Error("Expected composer and send action to render")
      }
      return [
        {
          foreground: parse(getComputedStyle(send).color),
          background: parse(getComputedStyle(send).backgroundColor),
        },
        {
          foreground: parse(getComputedStyle(composer, "::placeholder").color),
          background: parse(getComputedStyle(background).backgroundColor),
        },
      ]
    })
    .then((samples) =>
      samples.map((sample) => ({
        ...sample,
        ratio: contrastRatio(
          parseSrgbColor(sample.foreground),
          parseSrgbColor(sample.background)
        ),
      }))
    )
}

for (const theme of ["light", "dark"] as const) {
  test(`primary action meets normal-text contrast in ${theme} mode`, async ({
    page,
  }) => {
    await openWorkspace(page, theme)

    const [primaryAction] = await readContrastSamples(page)

    expect(primaryAction.ratio).toBeGreaterThanOrEqual(4.5)
  })

  test(`composer placeholder meets normal-text contrast in ${theme} mode`, async ({
    page,
  }) => {
    await openWorkspace(page, theme)

    const [, composerPlaceholder] = await readContrastSamples(page)

    expect(composerPlaceholder.ratio).toBeGreaterThanOrEqual(4.5)
  })
}
