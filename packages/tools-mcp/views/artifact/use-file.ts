import { useEffect, useState } from "react"

import type { ViewApp } from "../view"
import { loadFile, type FileState, type PreviewLimits } from "./file"

const LOADING: FileState = { status: "loading" }

/**
 * One read of the file; each is its own object, so Refresh reads again. It
 * remembers the file's revision it read, so a new revision reads again.
 */
type Request = { address: string; revision: string | undefined }

/**
 * The file at `address`, read through the page with `read` once it is known,
 * again on `refresh`, again when the page reports a new `revision` of it,
 * since a later call showed the file and it may have changed, and again when
 * a renewed address follows one that could not reach it. A renewal alone
 * never reloads a preview that already shows.
 */
export function useFile(
  read: ViewApp["readServerResource"],
  address: string | undefined,
  filename: string,
  mimeType: string | undefined,
  limits: PreviewLimits,
  revision?: string
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
      request.revision !== revision ||
      (state.status === "unreachable" && request.address !== address))
  )
    setRequest({ address, revision })

  useEffect(() => {
    if (!request) return
    // A read the view no longer waits for, as once it unmounts, is cancelled.
    const controller = new AbortController()
    void loadFile(
      read,
      request.address,
      { filename, mimeType },
      limits,
      controller.signal
    ).then((next) => {
      if (!controller.signal.aborted) setOutcome({ request, state: next })
    })
    return () => controller.abort()
  }, [read, request, filename, mimeType, limits])

  return {
    state,
    refresh: () => {
      if (address !== undefined) setRequest({ address, revision })
    },
  }
}
