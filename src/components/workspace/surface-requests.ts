/**
 * A workspace surface something outside it, such as a slash command, asks to
 * show. The surface that owns the control answers; nothing answers a request
 * no mounted surface can serve.
 */
export type WorkspaceSurfaceRequest =
  | "openModel"
  | "focusContext"
  | "openPalette"
  | "openKeyboardReference"
  | "closeActiveTab"
  | "toggleVoice"

export type WorkspaceSurfaceRequests = {
  readonly request: (kind: WorkspaceSurfaceRequest) => void
  /** Returns the unsubscribe. */
  readonly subscribe: (
    listener: (kind: WorkspaceSurfaceRequest) => void
  ) => () => void
}

export function createSurfaceRequests(): WorkspaceSurfaceRequests {
  const listeners = new Set<(kind: WorkspaceSurfaceRequest) => void>()
  return {
    request: (kind) => {
      for (const listener of listeners) listener(kind)
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
