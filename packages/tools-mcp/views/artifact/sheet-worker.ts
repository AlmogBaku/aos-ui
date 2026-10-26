import { SHEET_WORKER_FILE } from "../../../../shared/presentation/views"
import type { ViewApp } from "../view"
import { officeScript } from "./office-script"
import type { SheetLimits, Workbook } from "./sheet-workbook"

/**
 * The sheets of the workbook in `file`, each up to `limits`, read off the page
 * by a worker of its own, started from the server's script, which ends once it
 * answers or `signal` aborts. The file's bytes are read afresh for each
 * worker, which takes them over. A workbook that cannot be read, or a worker
 * that fails, rejects.
 */
export async function readSheets(
  read: ViewApp["readServerResource"],
  file: Blob,
  limits: SheetLimits,
  signal: AbortSignal
): Promise<Workbook> {
  const [script, bytes] = await Promise.all([
    officeScript(read, SHEET_WORKER_FILE),
    file.arrayBuffer(),
  ])
  signal.throwIfAborted()
  const address = URL.createObjectURL(
    new Blob([script], { type: "text/javascript" })
  )
  const worker = new Worker(address)
  try {
    return await new Promise<Workbook>((resolve, reject) => {
      const fail = () => reject(new Error("The workbook could not be read"))
      worker.addEventListener(
        "message",
        ({ data }: MessageEvent<{ workbook?: Workbook }>) =>
          data.workbook ? resolve(data.workbook) : fail(),
        { once: true }
      )
      worker.addEventListener("error", fail, { once: true })
      worker.addEventListener("messageerror", fail, { once: true })
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      })
      worker.postMessage({ bytes, limits }, [bytes])
    })
  } finally {
    worker.terminate()
    URL.revokeObjectURL(address)
  }
}
