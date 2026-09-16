function copyTextWithSelection(text: string) {
  if (typeof document === "undefined" || !document.execCommand) {
    throw new Error("Clipboard access is unavailable")
  }

  const activeElement =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined
  const textarea = document.createElement("textarea")
  textarea.value = text
  textarea.readOnly = true
  textarea.style.position = "fixed"
  textarea.style.insetBlockStart = "0"
  textarea.style.insetInlineStart = "-9999px"
  textarea.style.opacity = "0"
  document.body.append(textarea)
  textarea.focus({ preventScroll: true })
  textarea.select()
  textarea.setSelectionRange(0, text.length)

  try {
    if (!document.execCommand("copy")) {
      throw new Error("The browser rejected the copy command")
    }
  } finally {
    textarea.remove()
    activeElement?.focus({ preventScroll: true })
  }
}

export async function copyTextToClipboard(text: string) {
  if (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    typeof navigator !== "undefined" &&
    navigator.clipboard?.writeText
  ) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // Some browsers expose the Clipboard API while denying access. The
      // selection fallback still works in environments that support it.
    }
  }

  copyTextWithSelection(text)
}
