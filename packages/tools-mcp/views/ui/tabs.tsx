import { useId, useRef, type KeyboardEvent, type ReactNode } from "react"

import { Toolbar } from "./toolbar"

const TAB_CLASS =
  "shrink-0 cursor-pointer rounded-sm px-3 py-1 whitespace-nowrap text-xs font-medium text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-selected:bg-background aria-selected:text-foreground motion-reduce:transition-none [@media(pointer:coarse)]:min-h-11"

/**
 * A row of tabs over one panel showing the selected tab. The arrow keys move
 * to the neighbouring tab in reading order, mirrored in RTL, wrapping, and
 * Home and End to the first and last; only the selected tab is in the Tab
 * order. With `toolbar`, the tabs sit among the view's header controls; more
 * tabs than fit scroll sideways.
 */
export function Tabs<Name extends string>({
  label,
  tabs,
  selected,
  onSelect,
  className,
  toolbar = false,
  children,
}: {
  label: string
  tabs: readonly { name: Name; label: string }[]
  selected: Name
  onSelect: (name: Name) => void
  className?: string
  toolbar?: boolean
  children: ReactNode
}) {
  const id = useId()
  const buttons = useRef<Partial<Record<Name, HTMLButtonElement | null>>>({})
  const move = (event: KeyboardEvent) => {
    const at = tabs.findIndex((tab) => tab.name === selected)
    const forward = document.documentElement.dir === "rtl" ? -1 : 1
    const keys: Partial<Record<string, number>> = {
      ArrowLeft: at - forward,
      ArrowRight: at + forward,
      Home: 0,
      End: tabs.length - 1,
    }
    const to = keys[event.key]
    if (to === undefined) return
    event.preventDefault()
    const next = tabs[(to + tabs.length) % tabs.length]!.name
    onSelect(next)
    buttons.current[next]?.focus()
  }
  const list = (
    <div
      role="tablist"
      aria-label={label}
      className="inline-flex w-fit max-w-full gap-1 overflow-x-auto rounded-md bg-muted p-1"
      onKeyDown={move}
    >
      {tabs.map((tab) => (
        <button
          key={tab.name}
          ref={(button) => {
            buttons.current[tab.name] = button
          }}
          id={`${id}-${tab.name}`}
          type="button"
          role="tab"
          aria-selected={tab.name === selected}
          aria-controls={`${id}-panel`}
          tabIndex={tab.name === selected ? 0 : -1}
          className={TAB_CLASS}
          onClick={() => onSelect(tab.name)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
  return (
    <>
      {toolbar ? <Toolbar>{list}</Toolbar> : list}
      <div
        id={`${id}-panel`}
        role="tabpanel"
        aria-labelledby={`${id}-${selected}`}
        className={className}
      >
        {children}
      </div>
    </>
  )
}
