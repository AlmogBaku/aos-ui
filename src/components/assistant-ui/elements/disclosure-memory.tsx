"use client"

import { useAuiState } from "@assistant-ui/react"
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react"

type DisclosureMemory = Map<string, boolean>

const DisclosureMemoryContext = createContext<DisclosureMemory | null>(null)

/**
 * Remembers which disclosures the reader opened or closed for as long as this
 * thread view lives. A virtualized thread unmounts a message scrolled out of
 * the window; its folds come back as the reader left them. Nothing is stored:
 * a new key, such as another Session, starts fresh.
 */
export function DisclosureMemoryProvider({
  scope,
  children,
}: {
  /** The thread the memory belongs to; a different thread gets a new one. */
  scope: string | undefined
  children: ReactNode
}) {
  const [memory, setMemory] = useState(() => ({
    scope,
    entries: new Map<string, boolean>(),
  }))
  if (memory.scope !== scope) setMemory({ scope, entries: new Map() })
  return (
    <DisclosureMemoryContext.Provider value={memory.entries}>
      {children}
    </DisclosureMemoryContext.Provider>
  )
}

/**
 * The reader's own choice for one disclosure in the current message, or
 * `undefined` until they make one, so each caller keeps its automatic open
 * state (a streaming preview, a pending approval) as the fallback. `key` must
 * be stable within the message: a part index or a tool call id.
 */
export function useRememberedDisclosure(key: string) {
  const memory = useContext(DisclosureMemoryContext)
  const messageId = useAuiState((state) => state.message.id)
  const entry = `${messageId}\u0000${key}`
  const [chosen, setChosen] = useState<boolean | undefined>(() =>
    memory?.get(entry)
  )
  useEffect(() => {
    if (chosen !== undefined) memory?.set(entry, chosen)
  }, [chosen, entry, memory])
  return [chosen, setChosen] as const
}
