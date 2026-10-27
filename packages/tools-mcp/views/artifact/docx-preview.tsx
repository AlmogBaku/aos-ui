import { useEffect, useMemo, useRef, useState } from "react"

import { DOCX_RENDERER_FILE } from "../../../../shared/presentation/views"
import type { ViewLabels } from "../locale"
import { Status } from "../ui/status"
import type { ViewApp } from "../view"
import { DOCX_FAILED, DOCX_PAGE, docxPolicy } from "./docx-frame"
import {
  AGENT_LINK,
  agentMessage,
  SandboxFrame,
  standInsScript,
  withPolicy,
  ZOOM_SCRIPT,
} from "./html-preview"
import { officeScript } from "./office-script"

/** What the Word frame may ask: to open a link, or to say it failed. */
const DOCX_MESSAGES = [AGENT_LINK, DOCX_FAILED] as const

/** A nonce no document can guess: 16 random bytes, as base64. */
function drawNonce() {
  return btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))
  )
}

/**
 * A Word document drawn as its pages by docx-preview, in a frame of its own
 * that runs only its own scripts and reaches nothing. The renderer's script
 * comes from the server; the file's bytes go to the frame once, as it first
 * loads, and a link it opens goes to `openLink`. A renderer that cannot be
 * read, or a document it cannot draw, shows no preview.
 */
export function DocxPreview({
  blob,
  read,
  openLink,
  labels,
  height,
}: {
  blob: Blob
  read: ViewApp["readServerResource"]
  openLink: ViewApp["openLink"]
  labels: ViewLabels["artifact"]
  height: number
}) {
  const [renderer, setRenderer] = useState<string>()
  const [failed, setFailed] = useState(false)
  // Drawn once, so a render never rebuilds the frame's page and reloads it.
  const [nonce] = useState(drawNonce)
  const frame = useRef<HTMLIFrameElement>(null)
  const posted = useRef(false)
  useEffect(() => {
    let current = true
    officeScript(read, DOCX_RENDERER_FILE).then(
      (script) => {
        if (current) setRenderer(script)
      },
      () => {
        if (current) setFailed(true)
      }
    )
    return () => {
      current = false
    }
  }, [read])
  useEffect(() => {
    const relay = (event: MessageEvent) => {
      const message = agentMessage(
        event,
        frame.current?.contentWindow,
        DOCX_MESSAGES
      )
      if (message?.type === AGENT_LINK)
        void openLink({ url: message.url }).catch(() => undefined)
      else if (message?.type === DOCX_FAILED) setFailed(true)
    }
    window.addEventListener("message", relay)
    return () => window.removeEventListener("message", relay)
  }, [openLink])
  const html = useMemo(
    () =>
      renderer === undefined
        ? undefined
        : withPolicy(
            DOCX_PAGE,
            docxPolicy(nonce),
            [ZOOM_SCRIPT, standInsScript(undefined), renderer],
            nonce
          ),
    [nonce, renderer]
  )
  const send = () => {
    if (posted.current) return
    posted.current = true
    void blob.arrayBuffer().then((bytes) =>
      frame.current?.contentWindow?.postMessage({ bytes }, "*", [bytes])
    )
  }

  if (failed) return <Status>{labels.noPreview}</Status>
  if (html === undefined) return <Status>{labels.loading}</Status>
  return (
    <div style={{ height }}>
      <SandboxFrame
        frame={frame}
        html={html}
        title={labels.documentTitle}
        onLoad={send}
      />
    </div>
  )
}
