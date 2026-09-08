const regionSelector =
  "[data-keyboard-region], [data-keyboard-transcript], [data-keyboard-composer]"

function hasHiddenLayoutAncestor(element: HTMLElement) {
  let candidate: HTMLElement | null = element.parentElement
  while (candidate) {
    const style = window.getComputedStyle(candidate)
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse"
    ) {
      return true
    }
    candidate = candidate.parentElement
  }
  return false
}

function isExcluded(element: HTMLElement) {
  const style =
    typeof window === "undefined" ? null : window.getComputedStyle(element)
  const rects = element.getClientRects()
  const rect = element.getBoundingClientRect()
  return Boolean(
    (element as HTMLElement & { inert?: boolean }).inert ||
    element.closest("[hidden], [inert]") ||
    element.hidden ||
    element.getAttribute("aria-hidden") === "true" ||
    element.closest('[aria-hidden="true"]') ||
    element.matches(":disabled") ||
    element.hasAttribute("disabled") ||
    element.getAttribute("aria-disabled") === "true" ||
    element.closest("fieldset[disabled]") ||
    style?.display === "none" ||
    style?.visibility === "hidden" ||
    style?.visibility === "collapse" ||
    (typeof window !== "undefined" && hasHiddenLayoutAncestor(element)) ||
    (rects.length > 0 && (rect.width <= 0 || rect.height <= 0))
  )
}

const focusableSelector =
  "button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])"

function focusTarget(region: HTMLElement): HTMLElement | null {
  if (isExcluded(region)) return null
  if (region.hasAttribute("tabindex")) return region
  return (
    [...region.querySelectorAll<HTMLElement>(focusableSelector)].find(
      (element) => !isExcluded(element)
    ) ?? null
  )
}

/** Add the provider-neutral markers used by F6 to currently mounted slots. */
export function annotateKeyboardRegions(root: ParentNode) {
  const transcript = root.querySelector<HTMLElement>(
    '[data-slot="aui_thread-viewport"]'
  )
  transcript?.setAttribute("data-keyboard-region", "transcript")
  transcript?.setAttribute("data-keyboard-transcript", "true")
  if (transcript && !transcript.hasAttribute("tabindex")) {
    transcript.tabIndex = -1
  }
  const composer = root.querySelector<HTMLElement>(
    '[data-slot="aui_composer-shell"]'
  )
  composer?.setAttribute("data-keyboard-region", "composer")
  composer?.setAttribute("data-keyboard-composer", "true")
}

/** Keep markers correct when Assistant UI mounts or remounts its slots later. */
export function observeKeyboardRegions(root: HTMLElement) {
  annotateKeyboardRegions(root)
  if (typeof MutationObserver === "undefined") return () => undefined
  const observer = new MutationObserver(() => annotateKeyboardRegions(root))
  observer.observe(root, { childList: true, subtree: true })
  return () => observer.disconnect()
}

export function getVisibleFocusRegions(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(regionSelector)].filter(
    (element, index, elements) =>
      focusTarget(element) !== null &&
      (element.hasAttribute("data-keyboard-transcript") ||
        element.hasAttribute("data-keyboard-composer") ||
        !element.querySelector(regionSelector)) &&
      elements.indexOf(element) === index
  )
}

type Focusable = HTMLElement & { focus: () => void }

function lastDescendant(
  region: HTMLElement,
  remembered: WeakMap<HTMLElement, HTMLElement>
) {
  const target = remembered.get(region)
  if (
    target &&
    region.contains(target) &&
    !isExcluded(target) &&
    (target === region || target.matches(focusableSelector))
  )
    return target
  return focusTarget(region) ?? region
}

export function createFocusRegionCoordinator() {
  const remembered = new WeakMap<HTMLElement, HTMLElement>()

  function remember(region: HTMLElement) {
    const active = document.activeElement
    if (active instanceof HTMLElement && region.contains(active)) {
      remembered.set(region, active)
    }
  }

  function focusAt(
    root: ParentNode,
    current: HTMLElement | null,
    delta: 1 | -1
  ) {
    const regions = getVisibleFocusRegions(root)
    if (regions.length === 0) return false
    const inferred =
      current ??
      (document.activeElement instanceof HTMLElement
        ? document.activeElement.closest<HTMLElement>(regionSelector)
        : null)
    const currentIndex = inferred ? regions.indexOf(inferred) : -1
    const nextIndex =
      currentIndex < 0
        ? delta === 1
          ? 0
          : regions.length - 1
        : (currentIndex + delta + regions.length) % regions.length
    if (inferred) remember(inferred)
    const target = regions[nextIndex]
    if (!target) return false
    const candidate = lastDescendant(target, remembered) as Focusable
    candidate.focus()
    const active = document.activeElement
    if (
      active === candidate ||
      (active instanceof HTMLElement && target.contains(active))
    )
      return true
    if (candidate !== target && !isExcluded(target)) {
      ;(target as Focusable).focus()
      const fallbackActive = document.activeElement
      if (
        fallbackActive === target ||
        (fallbackActive instanceof HTMLElement &&
          target.contains(fallbackActive))
      )
        return true
    }
    return false
  }

  return {
    remember,
    focusNext: (root: ParentNode, current?: HTMLElement | null) =>
      focusAt(root, current ?? null, 1),
    focusPrevious: (root: ParentNode, current?: HTMLElement | null) =>
      focusAt(root, current ?? null, -1),
  }
}
