"use client"

import {
  ThreadListItemPrimitive,
  ThreadListItemRuntimeProvider,
  type ThreadListItemRuntime,
  type ThreadListRuntime,
} from "@assistant-ui/react"
import {
  createContext,
  forwardRef,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react"

type SessionItemContextValue = {
  primitive: boolean
  activate: () => void | Promise<unknown>
  onActionError?: (error: unknown) => void
}

const PrimitiveSessionItemContext =
  createContext<SessionItemContextValue | null>(null)

class SessionItemCallbackBridge {
  #onSwitch: () => void | Promise<unknown>
  #onActionError?: (error: unknown) => void

  constructor(
    onSwitch: () => void | Promise<unknown>,
    onActionError?: (error: unknown) => void
  ) {
    this.#onSwitch = onSwitch
    this.#onActionError = onActionError
  }

  update(
    onSwitch: () => void | Promise<unknown>,
    onActionError?: (error: unknown) => void
  ) {
    this.#onSwitch = onSwitch
    this.#onActionError = onActionError
  }

  activate = () => this.#onSwitch()
  reportActionError = (error: unknown) => this.#onActionError?.(error)
}

function decorateThreadItemRuntime(
  base: ThreadListItemRuntime,
  activate: () => void | Promise<unknown>,
  onActionError?: (error: unknown) => void
): ThreadListItemRuntime {
  const decorated: ThreadListItemRuntime = {
    path: base.path,
    getState: () => base.getState(),
    initialize: () => base.initialize(),
    generateTitle: () => base.generateTitle(),
    switchTo: async () => {
      try {
        await activate()
      } catch (error) {
        onActionError?.(error)
      }
    },
    rename: (newTitle) => base.rename(newTitle),
    updateCustom: (custom) => base.updateCustom(custom),
    archive: () => base.archive(),
    unarchive: () => base.unarchive(),
    delete: () => base.delete(),
    detach: () => base.detach(),
    subscribe: (callback) => base.subscribe(callback),
    unstable_on: (event, callback) => base.unstable_on(event, callback),
    __internal_getRuntime: () => decorated,
  }
  return decorated
}

export function SessionThreadListItem({
  runtime,
  threadId,
  onSwitch,
  onActionError,
  children,
  ...props
}: ComponentPropsWithoutRef<"div"> & {
  runtime?: ThreadListRuntime
  threadId: string
  onSwitch: () => void | Promise<unknown>
  onActionError?: (error: unknown) => void
  children: ReactNode
}) {
  const [callbackBridge] = useState(
    () => new SessionItemCallbackBridge(onSwitch, onActionError)
  )
  useLayoutEffect(() => {
    callbackBridge.update(onSwitch, onActionError)
  }, [callbackBridge, onActionError, onSwitch])
  const itemRuntime = useMemo(() => {
    if (!runtime) return null
    return decorateThreadItemRuntime(
      runtime.getItemById(threadId),
      callbackBridge.activate,
      callbackBridge.reportActionError
    )
  }, [callbackBridge, runtime, threadId])
  const contextValue = useMemo<SessionItemContextValue>(
    () => ({
      primitive: Boolean(itemRuntime),
      activate: callbackBridge.activate,
      onActionError: callbackBridge.reportActionError,
    }),
    [callbackBridge, itemRuntime]
  )

  if (!itemRuntime) {
    return (
      <PrimitiveSessionItemContext.Provider value={contextValue}>
        <div {...props}>{children}</div>
      </PrimitiveSessionItemContext.Provider>
    )
  }

  return (
    <ThreadListItemRuntimeProvider runtime={itemRuntime}>
      <PrimitiveSessionItemContext.Provider value={contextValue}>
        <ThreadListItemPrimitive.Root
          {...props}
          data-thread-list-primitive="true"
        >
          {children}
        </ThreadListItemPrimitive.Root>
      </PrimitiveSessionItemContext.Provider>
    </ThreadListItemRuntimeProvider>
  )
}

export const SessionThreadListTrigger = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<"button">
>((props, ref) => {
  const context = useContext(PrimitiveSessionItemContext)
  if (context?.primitive) {
    return <ThreadListItemPrimitive.Trigger {...props} ref={ref} />
  }
  return (
    <button
      {...props}
      ref={ref}
      type={props.type ?? "button"}
      onClick={(event) => {
        props.onClick?.(event)
        if (event.defaultPrevented || !context) return
        try {
          Promise.resolve(context.activate()).catch(context.onActionError)
        } catch (error) {
          context.onActionError?.(error)
        }
      }}
    />
  )
})

SessionThreadListTrigger.displayName = "SessionThreadListTrigger"

export function SessionThreadListTitle({ fallback }: { fallback: ReactNode }) {
  const context = useContext(PrimitiveSessionItemContext)
  return context?.primitive ? (
    <ThreadListItemPrimitive.Title fallback={fallback} />
  ) : (
    fallback
  )
}
