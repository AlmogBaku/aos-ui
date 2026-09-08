"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type PropsWithChildren,
} from "react"
import type { Locale } from "@/lib/i18n/config"
import { type VoiceMediaController, type VoiceMediaState } from "./voice-media"
import { EMPTY_MIC_LEVELS } from "./mic-level-meter"
import { voiceLabels } from "./voice-labels"

const VoiceContext = createContext<
  { media: VoiceMediaController; locale: Locale } | undefined
>(undefined)
const noSubscribe = () => () => {}

export function VoiceMediaProvider({
  media,
  locale,
  children,
}: PropsWithChildren<{ media: VoiceMediaController; locale: Locale }>) {
  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState === "hidden") media.handleHidden()
    }
    document.addEventListener("visibilitychange", hidden)
    return () => {
      document.removeEventListener("visibilitychange", hidden)
      media.dispose()
    }
  }, [media])
  const value = useMemo(() => ({ media, locale }), [media, locale])
  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>
}

export function useVoiceContext() {
  return useContext(VoiceContext)
}
export function useVoiceLabels() {
  return voiceLabels[useVoiceContext()?.locale ?? "en"]
}
export function useVoiceState<T>(
  selector: (state: VoiceMediaState | undefined) => T
): T {
  const media = useVoiceContext()?.media
  const snapshot = useCallback(
    () => selector(media?.getSnapshot()),
    [media, selector]
  )
  return useSyncExternalStore(
    media?.subscribe ?? noSubscribe,
    snapshot,
    snapshot
  )
}
export function useVoiceCaptureActive() {
  return useVoiceState((state) =>
    Boolean(state?.capture && state.capture.phase !== "idle")
  )
}

export function useVoiceMicLevels() {
  const media = useVoiceContext()?.media
  return useSyncExternalStore(
    media?.subscribeMicLevels ?? noSubscribe,
    media?.getMicLevelsSnapshot ?? (() => EMPTY_MIC_LEVELS),
    () => EMPTY_MIC_LEVELS
  )
}
