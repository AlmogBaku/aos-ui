import { useEffect, useState } from "react"

import { loadFile, type FileState } from "./file"

const LOADING: FileState = { status: "loading" }

/** One read of the file; each is its own object, so Refresh reads again. */
type Request = { address: string }

/**
 * The file at `address`, read once it is known, again on `refresh`, and again
 * when a renewed address follows one that could not reach it. A renewal never
 * reloads a preview that already shows.
 */
export function useFile(
  address: string | undefined,
  filename: string,
  mimeType: string | undefined,
  limit: number
) {
  const [request, setRequest] = useState<Request>()
  const [outcome, setOutcome] = useState<{
    request: Request
    state: FileState
  }>()
  const state =
    outcome !== undefined && outcome.request === request
      ? outcome.state
      : LOADING
  if (
    address !== undefined &&
    (request === undefined ||
      (state.status === "unreachable" && request.address !== address))
  )
    setRequest({ address })

  useEffect(() => {
    if (!request) return
    const controller = new AbortController()
    void loadFile(
      request.address,
      { filename, mimeType },
      limit,
      controller.signal
    ).then((next) => {
      if (!controller.signal.aborted) setOutcome({ request, state: next })
    })
    return () => controller.abort()
  }, [request, filename, mimeType, limit])

  return {
    state,
    refresh: () => {
      if (address !== undefined) setRequest({ address })
    },
  }
}
