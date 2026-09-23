import { useId, useState, type ReactNode } from "react"

/** The toggle that reveals a view's textual alternative below its visual. */
export function Disclosure({
  show,
  hide,
  children,
}: {
  show: string
  hide: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <div className="flex flex-col items-start gap-2">
      <button
        type="button"
        className="inline-flex cursor-pointer items-center gap-1 rounded-sm text-xs font-medium text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((current) => !current)}
      >
        {open ? hide : show}
        <svg
          viewBox="0 0 16 16"
          className={`size-3.5 transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m4 6 4 4 4-4" />
        </svg>
      </button>
      {open ? (
        <div id={id} className="w-full">
          {children}
        </div>
      ) : null}
    </div>
  )
}
