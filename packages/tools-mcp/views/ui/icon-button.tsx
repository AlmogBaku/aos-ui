import type { ReactNode } from "react"

/** A compact button that shows only its icon; its label names it to everyone. */
export function IconButton({
  label,
  onClick,
  disabled,
  pressed,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  pressed?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      className="inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors outline-none *:size-4 hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent aria-pressed:bg-muted aria-pressed:text-foreground motion-reduce:transition-none [@media(pointer:coarse)]:size-11"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  )
}
