"use client"

import { Menu } from "@base-ui/react/menu"
import { Ellipsis, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { Dictionary } from "@/lib/i18n/dictionary"
import type { WorkspaceSession } from "./workspace-shell"
import styles from "./workspace-shell.module.css"

export function SessionActions({
  session,
  dictionary,
  onClose,
  locale,
}: {
  session: WorkspaceSession
  dictionary: Dictionary
  onClose: () => void
  locale: "en" | "he"
}) {
  return (
    <Menu.Root>
      <Menu.Trigger
        render={<Button variant="ghost" className={styles.sessionAction} />}
        aria-label={`${dictionary.actions.sessionActions}: ${session.title}`}
      >
        <Ellipsis aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner
          sideOffset={6}
          align="end"
          className={styles.sessionMenuPositioner}
        >
          <Menu.Popup
            className={styles.sessionMenu}
            dir={locale === "he" ? "rtl" : "ltr"}
          >
            <Menu.Item className={styles.sessionMenuItem} onClick={onClose}>
              <X aria-hidden="true" />
              {dictionary.actions.closeTab}
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}
