import { useEffect, useRef } from "react"

import { AosReconciler } from "./aos-reconciliation"

/** Defers disposal across React StrictMode's development-only effect replay. */
export function useAosReconcilerLifecycle(reconciler: AosReconciler) {
  const mounted = useRef(new Set<AosReconciler>())
  const cleanupTimers = useRef(
    new Map<AosReconciler, ReturnType<typeof setTimeout>>()
  )

  useEffect(() => {
    const mountedReconcilers = mounted.current
    const timers = cleanupTimers.current
    const pending = timers.get(reconciler)
    if (pending !== undefined) clearTimeout(pending)
    timers.delete(reconciler)
    mountedReconcilers.add(reconciler)

    return () => {
      mountedReconcilers.delete(reconciler)
      timers.set(
        reconciler,
        setTimeout(() => {
          timers.delete(reconciler)
          if (!mountedReconcilers.has(reconciler)) reconciler.close()
        }, 0)
      )
    }
  }, [reconciler])
}
