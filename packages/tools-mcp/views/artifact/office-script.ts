import { OFFICE_RESOURCE_URI } from "../../../../shared/presentation/views"
import type { ViewApp } from "../view"
import { bytesOf } from "./file"

const scripts = new Map<string, Promise<string>>()

/**
 * The text of the Office script `file`, read from the `aos-ui` server once
 * per page and shared by every preview; a read that fails is tried again the
 * next time one is needed.
 */
export function officeScript(
  read: ViewApp["readServerResource"],
  file: string
): Promise<string> {
  let script = scripts.get(file)
  if (!script) {
    script = read({ uri: `${OFFICE_RESOURCE_URI}${file}` }).then((result) =>
      new TextDecoder().decode(bytesOf(result))
    )
    scripts.set(file, script)
    script.catch(() => scripts.delete(file))
  }
  return script
}
