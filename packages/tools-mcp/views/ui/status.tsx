import type { ReactNode } from "react"

/** One line saying where a view stands, announced as it changes. */
export function Status({ children }: { children: ReactNode }) {
  return (
    <p className="m-0 text-sm text-muted-foreground" role="status">
      {children}
    </p>
  )
}
