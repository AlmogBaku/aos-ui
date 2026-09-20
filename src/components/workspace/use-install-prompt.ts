"use client"

import { useEffect, useState } from "react"

type InstallPromptEvent = Event & { prompt(): Promise<unknown> }

/** iOS and iPadOS install from the share sheet, which no API can raise. */
function needsHomeScreenHint() {
  if (typeof navigator === "undefined" || typeof window === "undefined")
    return false
  const agent = navigator.userAgent
  const ios =
    /iPad|iPhone|iPod/.test(agent) ||
    (agent.includes("Macintosh") && navigator.maxTouchPoints > 1)
  if (!ios) return false
  const standalone = (navigator as Navigator & { standalone?: boolean })
    .standalone
  return standalone === false || !("Notification" in window)
}

/** Chromium volunteers `beforeinstallprompt`; nothing else can be installed. */
export function useInstallPrompt() {
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null)
  const [iosInstallHint] = useState(needsHomeScreenHint)
  useEffect(() => {
    const capture = (event: Event) => {
      event.preventDefault()
      setPrompt(event as InstallPromptEvent)
    }
    window.addEventListener("beforeinstallprompt", capture)
    return () => window.removeEventListener("beforeinstallprompt", capture)
  }, [])
  return {
    installable: prompt !== null,
    iosInstallHint,
    /** Call directly from the click event; the prompt is a one-shot gesture. */
    install() {
      setPrompt(null)
      try {
        void prompt?.prompt().catch(() => {})
      } catch {
        /* A withdrawn prompt leaves the workspace unchanged. */
      }
    },
  }
}
