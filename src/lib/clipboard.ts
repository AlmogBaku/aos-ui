import { markdownToHtml } from "@/lib/markdown-html"

type ClipboardContent = { text: string; html: string }

function copyWithSelection({ text, html }: ClipboardContent) {
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
  // The copy event is the only way the selection path can add an HTML flavor.
  const writeFlavors = (event: ClipboardEvent) => {
    if (!event.clipboardData) return
    event.clipboardData.setData("text/plain", text)
    event.clipboardData.setData("text/html", html)
    event.preventDefault()
  }
  document.addEventListener("copy", writeFlavors)

  try {
    if (!document.execCommand("copy")) {
      throw new Error("The browser rejected the copy command")
    }
  } finally {
    document.removeEventListener("copy", writeFlavors)
    textarea.remove()
    activeElement?.focus({ preventScroll: true })
  }
}

async function writeWithClipboardApi({ text, html }: ClipboardContent) {
  if (typeof ClipboardItem === "undefined") {
    await navigator.clipboard.writeText(text)
    return
  }
  await navigator.clipboard.write([
    new ClipboardItem({
      "text/plain": new Blob([text], { type: "text/plain" }),
      "text/html": new Blob([html], { type: "text/html" }),
    }),
  ])
}

async function copyToClipboard(content: ClipboardContent) {
  if (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    typeof navigator !== "undefined" &&
    navigator.clipboard
  ) {
    try {
      await writeWithClipboardApi(content)
      return
    } catch {
      // Some browsers expose the Clipboard API while denying access. The
      // selection fallback still works in environments that support it.
    }
  }

  copyWithSelection(content)
}

/**
 * Copies markdown the way a native selection copy does: the source as plain
 * text beside a rendered HTML flavor. A lone plain-text flavor that reads like
 * a URL (`ok: …`) is pasted percent-encoded into fields on macOS.
 */
export function copyMarkdownToClipboard(markdown: string) {
  return copyToClipboard({ text: markdown, html: markdownToHtml(markdown) })
}
