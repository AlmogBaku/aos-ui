"use client"

import { createRuntimeExtras } from "@assistant-ui/core/react"
import { useMemo } from "react"
import {
  createOpenCodeThreadState,
  type OpenCodeRuntimeExtras,
  type OpenCodeThreadState,
} from "@assistant-ui/react-opencode"

export const aosOpenCodeExtras =
  createRuntimeExtras<OpenCodeRuntimeExtras>("AOS OpenCode")

export const useAosOpenCodeRuntimeExtras = (): OpenCodeRuntimeExtras =>
  aosOpenCodeExtras.use()

export const useAosOpenCodeSession = () =>
  aosOpenCodeExtras.use((extras) => extras.session, null)

export const useAosOpenCodeQuestions = () => {
  const extras = aosOpenCodeExtras.use((value) => value, undefined)
  return useMemo(
    () => (extras ? Object.values(extras.questions) : []),
    [extras]
  )
}

export function useAosOpenCodeThreadState(): OpenCodeThreadState
export function useAosOpenCodeThreadState<T>(
  selector: (state: OpenCodeThreadState) => T
): T
export function useAosOpenCodeThreadState<T>(
  selector?: (state: OpenCodeThreadState) => T
) {
  const empty = createOpenCodeThreadState("")
  return aosOpenCodeExtras.use(
    (extras) => (selector ? selector(extras.state) : extras.state),
    selector ? selector(empty) : empty
  )
}
