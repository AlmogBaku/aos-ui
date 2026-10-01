import { Menu } from "@base-ui/react/menu"
import { EllipsisVertical } from "lucide-react"
import type { ReactNode } from "react"

import { ICON_BUTTON_CLASS } from "./icon-button"

/** One action a menu offers, named by its label and shown with its icon. */
export type MenuAction = {
  label: string
  icon: ReactNode
  onSelect: () => void
}

/**
 * A compact button that opens a menu of `actions`, for the ones a narrow view
 * has no room to show; Base UI gives the menu its keyboard and focus.
 */
export function MenuButton({
  label,
  actions,
}: {
  label: string
  actions: readonly MenuAction[]
}) {
  return (
    <Menu.Root>
      <Menu.Trigger
        className={ICON_BUTTON_CLASS}
        aria-label={label}
        title={label}
      >
        <EllipsisVertical />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={4} align="end" className="z-20">
          <Menu.Popup className="min-w-44 rounded-md bg-card p-1 text-sm text-card-foreground shadow-md ring-1 ring-border outline-none">
            {actions.map((action) => (
              <Menu.Item
                key={action.label}
                onClick={action.onSelect}
                className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 outline-none select-none data-highlighted:bg-muted *:[svg]:size-4 *:[svg]:text-muted-foreground [@media(pointer:coarse)]:min-h-11"
              >
                {action.icon}
                {action.label}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}
