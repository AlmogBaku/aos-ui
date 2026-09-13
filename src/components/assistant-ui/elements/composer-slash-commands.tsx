import {
  ComposerPrimitive,
  unstable_useTriggerPopoverScopeContext,
  type Unstable_DirectiveFormatter,
} from "@assistant-ui/react"
import { useLayoutEffect, useMemo, useRef, type RefObject } from "react"
import type { ComposerFeatureViewModel } from "@/components/assistant-ui/composer-features"

const plainCommandFormatter: Unstable_DirectiveFormatter = {
  serialize: (item) => `/${item.id}`,
  parse: (text) => [{ kind: "text", text }],
}

function KeepHighlightedCommandVisible({
  menuRef,
}: {
  menuRef: RefObject<HTMLDivElement | null>
}) {
  const { highlightedItemId } = unstable_useTriggerPopoverScopeContext()
  useLayoutEffect(() => {
    const menu = menuRef.current
    const option =
      highlightedItemId && menu?.ownerDocument.getElementById(highlightedItemId)
    if (!menu || !option) return
    const menuTop = menu.getBoundingClientRect().top + menu.clientTop
    const bounds = option.getBoundingClientRect()
    // Scroll only this menu; leave composer focus and conversation position alone.
    if (bounds.top < menuTop) menu.scrollTop += bounds.top - menuTop
    else if (bounds.bottom > menuTop + menu.clientHeight)
      menu.scrollTop += bounds.bottom - menuTop - menu.clientHeight
  }, [highlightedItemId, menuRef])
  return null
}

export function ComposerSlashCommands({
  commands,
  label,
}: {
  commands: ComposerFeatureViewModel["slashCommands"]
  label: string
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const adapter = useMemo(
    () => ({
      categories: () => [],
      categoryItems: () => [],
      search: (query: string) =>
        (commands ?? [])
          .filter((command) =>
            command.name.toLowerCase().includes(query.toLowerCase())
          )
          .map((command) => ({
            id: command.name,
            type: "command",
            label: `/${command.name}`,
            description: command.description,
          })),
    }),
    [commands]
  )
  if (!commands?.length) return null

  return (
    <ComposerPrimitive.Unstable_TriggerPopover
      ref={menuRef}
      char="/"
      adapter={adapter}
      matcher={(text, char, cursor) => {
        if (!text.startsWith(char) || cursor < 1) return null
        const query = text.slice(1, cursor)
        if (/\s/u.test(query) || !adapter.search(query).length) return null
        return { query, offset: 0, endOffset: cursor }
      }}
      aria-label={label}
      className="absolute inset-x-0 bottom-full z-20 mb-2 max-h-64 overflow-y-auto rounded-xl border bg-popover p-1 text-popover-foreground shadow-sm"
    >
      <KeepHighlightedCommandVisible menuRef={menuRef} />
      <ComposerPrimitive.Unstable_TriggerPopover.Directive
        formatter={plainCommandFormatter}
      />
      <ComposerPrimitive.Unstable_TriggerPopoverItems aria-label={label}>
        {(items) =>
          items.map((item, index) => (
            <ComposerPrimitive.Unstable_TriggerPopoverItem
              key={item.id}
              item={item}
              index={index}
              onMouseDown={(event) => event.preventDefault()}
              className="flex w-full flex-col gap-1 rounded-lg px-3 py-2 text-start text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring data-highlighted:bg-accent"
            >
              <span dir="auto" className="font-medium">
                {item.label}
              </span>
              {item.description && (
                <span dir="auto" className="text-muted-foreground">
                  {item.description}
                </span>
              )}
            </ComposerPrimitive.Unstable_TriggerPopoverItem>
          ))
        }
      </ComposerPrimitive.Unstable_TriggerPopoverItems>
    </ComposerPrimitive.Unstable_TriggerPopover>
  )
}
