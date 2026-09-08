const FORBIDDEN_ELEMENTS = new Set([
  "animate",
  "animatemotion",
  "animatetransform",
  "audio",
  "embed",
  "feimage",
  "foreignobject",
  "iframe",
  "image",
  "link",
  "meta",
  "object",
  "script",
  "set",
  "source",
  "video",
])

const URL_ATTRIBUTES = new Set([
  "action",
  "base",
  "data",
  "formaction",
  "href",
  "poster",
  "src",
  "srcset",
])

function isFragmentReference(value: string): boolean {
  return /^#[A-Za-z_][\w:.-]*$/.test(value.trim())
}

function hasUnsafeCssResource(value: string): boolean {
  if (
    /@import|\\|(?:https?|data|blob|file):|\/\/|(?:-webkit-)?image-set\s*\(/i.test(
      value
    )
  ) {
    return true
  }

  for (const match of value.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
    if (!isFragmentReference(match[2] ?? "")) return true
  }
  return false
}

/**
 * Mermaid applies its own label sanitization, but its returned SVG is still an
 * HTML injection boundary. This second pass strips active content and every
 * resource reference that could leave the page while retaining local marker,
 * clip-path, and gradient references used by static diagrams.
 */
export function sanitizeMermaidSvg(svgSource: string): string {
  const document = new DOMParser().parseFromString(svgSource, "image/svg+xml")
  const svg = document.documentElement

  if (
    svg.localName.toLowerCase() !== "svg" ||
    document.querySelector("parsererror")
  ) {
    throw new Error("Mermaid did not return valid SVG")
  }

  for (const element of Array.from(svg.querySelectorAll("*"))) {
    const elementName = element.localName.toLowerCase()
    if (FORBIDDEN_ELEMENTS.has(elementName)) {
      element.remove()
      continue
    }

    if (
      elementName === "style" &&
      hasUnsafeCssResource(element.textContent ?? "")
    ) {
      element.remove()
      continue
    }

    for (const attribute of Array.from(element.attributes)) {
      const attributeName = attribute.localName.toLowerCase()
      const value = attribute.value

      if (
        attributeName.startsWith("on") ||
        attributeName === "target" ||
        (attributeName === "style" && hasUnsafeCssResource(value)) ||
        hasUnsafeCssResource(value)
      ) {
        element.removeAttributeNode(attribute)
        continue
      }

      if (URL_ATTRIBUTES.has(attributeName)) {
        const mayUseLocalReference =
          attributeName === "href" &&
          elementName !== "a" &&
          isFragmentReference(value)
        if (!mayUseLocalReference) element.removeAttributeNode(attribute)
      }
    }
  }

  for (const attribute of Array.from(svg.attributes)) {
    const attributeName = attribute.localName.toLowerCase()
    if (
      attributeName.startsWith("on") ||
      attributeName === "target" ||
      URL_ATTRIBUTES.has(attributeName) ||
      hasUnsafeCssResource(attribute.value)
    ) {
      svg.removeAttributeNode(attribute)
    }
  }

  svg.setAttribute("aria-hidden", "true")
  svg.setAttribute("focusable", "false")
  return new XMLSerializer().serializeToString(svg)
}
