import { set_cptable } from "xlsx"
import * as cptable from "xlsx/dist/cpexcel"

import { readWorkbook, type SheetLimits } from "./sheet-workbook"

/**
 * The spreadsheet worker, built as one classic script the artifact view
 * starts from a blob URL. With the old Windows code pages, a Hebrew `.xls`
 * decodes. It answers a workbook's bytes with its sheets, or with why they
 * could not be read.
 */
set_cptable(cptable)

self.onmessage = ({
  data,
}: MessageEvent<{ bytes: ArrayBuffer; limits: SheetLimits }>) => {
  try {
    self.postMessage({ workbook: readWorkbook(data.bytes, data.limits) })
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
