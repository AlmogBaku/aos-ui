import { Check, Copy } from "lucide-react"
import { useState } from "react"

import type { ViewLabels } from "../locale"
import { IconButton } from "../ui/icon-button"

/**
 * The older copy path, through a selection, for a frame whose page does not
 * delegate the Clipboard API to it. It returns focus to where it was.
 */
function copyBySelection(text: string) {
  const focused = document.activeElement
  const field = document.createElement("textarea")
  field.value = text
  field.readOnly = true
  field.style.position = "fixed"
  field.style.opacity = "0"
  document.body.append(field)
  field.select()
  try {
    if (!document.execCommand("copy")) throw new Error("Copy was refused")
  } finally {
    field.remove()
    if (focused instanceof HTMLElement) focused.focus()
  }
}

/** Copies the file's text; its label and a status line say how that went. */
export function CopyButton({
  text,
  labels,
}: {
  text: string
  labels: ViewLabels["artifact"]
}) {
  const [outcome, setOutcome] = useState<"copied" | "copyFailed">()
  // A page without the clipboard has no `navigator.clipboard` at all.
  const copy = () =>
    Promise.resolve(text)
      .then((value) => navigator.clipboard.writeText(value))
      .catch(() => copyBySelection(text))
      .then(
        () => setOutcome("copied"),
        () => setOutcome("copyFailed")
      )
  return (
    <>
      <IconButton
        label={outcome ? labels[outcome] : labels.copy}
        onClick={() => void copy()}
      >
        {outcome === "copied" ? <Check /> : <Copy />}
      </IconButton>
      <span className="sr-only" role="status">
        {outcome ? labels[outcome] : null}
      </span>
    </>
  )
}
