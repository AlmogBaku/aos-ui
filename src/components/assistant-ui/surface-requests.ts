/**
 * A workspace surface something outside it, such as a slash command, asks to
 * show. The surface that owns the control answers; nothing answers a request
 * no mounted surface can serve. `notice` is a command's answer, which the
 * composer shows when the command ran from the palette; `revealMessage`
 * brings a message the thread may not have mounted yet into view.
 */
export type WorkspaceSurfaceRequest =
  | "openModel"
  | "focusContext"
  | "openPalette"
  | "openKeyboardReference"
  | "closeActiveTab"
  | "toggleVoice"
  | {
      readonly kind: "notice"
      readonly notice: string
      readonly tone: "info" | "error"
    }
  | { readonly kind: "revealMessage"; readonly messageId: string }

export type WorkspaceSurfaceRequests = {
  readonly request: (request: WorkspaceSurfaceRequest) => void
  /** Returns the unsubscribe. */
  readonly subscribe: (
    listener: (request: WorkspaceSurfaceRequest) => void
  ) => () => void
}

export function createSurfaceRequests(): WorkspaceSurfaceRequests {
  const listeners = new Set<(request: WorkspaceSurfaceRequest) => void>()
  return {
    request: (request) => {
      for (const listener of listeners) listener(request)
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
