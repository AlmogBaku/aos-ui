/** The in-app cue for activity that needs the operator. */
export interface ActivitySoundPort {
  play(): void
  stop(): void
}

type SoundElement = {
  currentTime: number
  play(): Promise<void> | void
  pause(): void
}

export const URGENT_SOUND_SRC = "/sounds/urgent.wav"

function createAudioElement(): SoundElement | null {
  if (typeof document === "undefined") return null
  const audio = document.createElement("audio")
  audio.preload = "auto"
  audio.src = URGENT_SOUND_SRC
  return audio
}

/**
 * Browsers refuse audio until the page has been interacted with, and a refusal
 * must stay silent rather than surface as an error.
 */
export function createActivitySoundPort(
  injected?: SoundElement
): ActivitySoundPort {
  let element = injected
  let gestured = false
  const note = () => {
    gestured = true
  }
  const detach: (() => void)[] = []
  try {
    for (const type of ["pointerdown", "keydown"] as const) {
      window.addEventListener(type, note, { once: true, passive: true })
      detach.push(() => window.removeEventListener(type, note))
    }
  } catch {
    /* Without a window the cue simply never plays. */
  }
  const activated = () => {
    if (gestured) return true
    try {
      return (
        (
          navigator as Navigator & {
            userActivation?: { hasBeenActive: boolean }
          }
        ).userActivation?.hasBeenActive === true
      )
    } catch {
      return false
    }
  }
  return {
    play() {
      if (!activated()) return
      try {
        element ??= createAudioElement() ?? undefined
        if (!element) return
        element.currentTime = 0
        void Promise.resolve(element.play()).catch(() => {})
      } catch {
        /* A blocked or detached element never breaks the workspace. */
      }
    },
    /** A stopped cue also stops waiting for the gesture that would arm it. */
    stop() {
      for (const remove of detach.splice(0)) {
        try {
          remove()
        } catch {}
      }
      gestured = false
      try {
        element?.pause()
      } catch {}
    },
  }
}
