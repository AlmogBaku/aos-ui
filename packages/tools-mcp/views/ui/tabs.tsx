import { useId, useRef, type KeyboardEvent, type ReactNode } from "react"

import { Toolbar } from "./toolbar"

const TAB_CLASS =
  "cursor-pointer rounded-sm px-3 py-1 text-xs font-medium text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-selected:bg-background aria-selected:text-foreground motion-reduce:transition-none [@media(pointer:coarse)]:min-h-11"

/**
 * A row of tabs over one panel showing the selected tab. The arrow keys move
 * to the neighbouring tab, wrapping, and Home and End to the first and last;
 * only the selected tab is in the Tab order. With two tabs, either arrow
 * reaches the other, so neither needs to mirror in RTL. With `toolbar`, the
 * tabs sit among the view's header controls.
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
    const keys: Partial<Record<string, number>> = {
      ArrowLeft: at - 1,
      ArrowRight: at + 1,
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
      className="inline-flex w-fit gap-1 rounded-md bg-muted p-1"
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
