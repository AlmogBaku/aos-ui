import { createContext, useContext } from "react"

/** Providers may own workspace failure presentation, including native sign-in. */
export const RuntimeErrorContext = createContext<
  ((error: Error) => void) | undefined
>(undefined)

export const useRuntimeErrorReporter = () => useContext(RuntimeErrorContext)
