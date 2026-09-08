import {
  keyboardEventSafetyReason,
  type KeyboardEventLike,
} from "@/lib/keyboard"

export type ComposerEnterState = {
  readonly isRunning: boolean
  readonly hasQueue: boolean
  readonly isEmpty: boolean
}

export type ComposerEnterEvent = {
  readonly key: string
  readonly shiftKey?: boolean
  readonly isComposing?: boolean
  readonly keyCode?: number
  readonly defaultPrevented?: boolean
  readonly nativeEvent?: {
    readonly isComposing?: boolean
    /** Chromium/WebKit expose this during an IME keypress. */
    readonly keyCode?: number
  }
}

export type ComposerEnterAction = "send" | "newline" | "noop"

export type VisualLineBoundary = "first" | "last"

export type VisualLineBoundaryRequest = {
  readonly value: string
  readonly selectionStart: number
  readonly selectionEnd: number
  readonly boundary: VisualLineBoundary
}

export function isCollapsedCaretAtVisualLineBoundary(
  request: VisualLineBoundaryRequest & {
    readonly measure?: (request: VisualLineBoundaryRequest) => boolean
  }
): boolean {
  const { value, selectionStart, selectionEnd, boundary, measure } = request
  if (selectionStart !== selectionEnd) return false
  if (measure) return measure({ value, selectionStart, selectionEnd, boundary })
  if (boundary === "first")
    return !value.slice(0, selectionStart).includes("\n")
  return !value.slice(selectionEnd).includes("\n")
}

/**
 * Measures a textarea caret against a hidden copy of the rendered textarea.
 * The newline-only fallback above is retained for non-layout environments
 * (SSR and jsdom), while browsers use wrapped line geometry.
 */
export function measureTextareaVisualLineBoundary(
  textarea: HTMLTextAreaElement,
  request: VisualLineBoundaryRequest
): boolean {
  if (typeof document === "undefined") {
    return isCollapsedCaretAtVisualLineBoundary(request)
  }

  const width = textarea.clientWidth || textarea.getBoundingClientRect().width
  if (!width) return isCollapsedCaretAtVisualLineBoundary(request)

  const computed = getComputedStyle(textarea)
  const mirror = document.createElement("div")
  const copiedStyles = [
    "boxSizing",
    "font",
    "fontFamily",
    "fontSize",
    "fontStyle",
    "fontWeight",
    "letterSpacing",
    "lineHeight",
    "padding",
    "tabSize",
    "textIndent",
    "textRendering",
    "textTransform",
    "wordBreak",
    "wordSpacing",
  ] as const
  for (const property of copiedStyles) {
    mirror.style[property] = computed[property]
  }
  mirror.style.position = "absolute"
  mirror.style.visibility = "hidden"
  mirror.style.pointerEvents = "none"
  mirror.style.whiteSpace = "pre-wrap"
  mirror.style.overflowWrap = "break-word"
  mirror.style.width = `${width}px`
  mirror.style.direction = computed.direction

  const lineTop = (position: number) => {
    mirror.replaceChildren()
    const before = document.createTextNode(request.value.slice(0, position))
    const marker = document.createElement("span")
    marker.textContent = "\u200b"
    const after = document.createTextNode(request.value.slice(position))
    mirror.append(before, marker, after)
    document.body.append(mirror)
    const top = marker.getBoundingClientRect().top
    mirror.remove()
    return top
  }

  const positionTop = lineTop(request.selectionStart)
  const boundaryPosition =
    request.boundary === "first" ? 0 : request.value.length
  const boundaryTop = lineTop(boundaryPosition)
  return Math.abs(positionTop - boundaryTop) < 1
}

export function resolveComposerEnterAction(
  event: ComposerEnterEvent,
  state: ComposerEnterState
): ComposerEnterAction {
  if (
    event.key !== "Enter" ||
    keyboardEventSafetyReason(event as KeyboardEventLike)
  ) {
    return "noop"
  }
  if (event.shiftKey) return "newline"
  if (state.isEmpty || (state.isRunning && !state.hasQueue)) return "noop"
  return "send"
}
