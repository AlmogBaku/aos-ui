import { useEffect, useState } from "react"

import type { ViewLabels } from "../locale"
import { Status } from "../ui/status"
import { Tabs } from "../ui/tabs"
import type { ViewApp } from "../view"
import { DataTable } from "./csv-table"
import type { Room } from "./room"
import { readSheets } from "./sheet-worker"
import type { Sheet, SheetLimits, Workbook } from "./sheet-workbook"

type Labels = ViewLabels["artifact"]

type Read =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; workbook: Workbook }

/** One sheet as Excel lays it out: column letters across, row numbers down. */
function SheetGrid({
  sheet,
  label,
  labels,
  limits,
  height,
}: {
  sheet: Sheet
  label: string
  labels: Labels
  limits: SheetLimits
  height: number
}) {
  if (sheet.rows.length === 0)
    return <Status>{labels.sheetEmpty}</Status>
  return (
    <DataTable
      header={sheet.columns}
      rows={sheet.rows.map(({ cells }) => cells)}
      rowHeaders={sheet.rows.map(({ number }) => String(number))}
      label={label}
      note={
        sheet.truncated
          ? labels.sheetTruncated(limits.rows, limits.columns)
          : undefined
      }
      style={{ height }}
    />
  )
}

/**
 * A spreadsheet, read by the sheet worker up to `limits`, as a grid of the
 * sheet it was saved on; with more than one sheet, tabs among the view's
 * controls switch between them. A workbook that cannot be read shows no
 * preview.
 */
export function SheetPreview({
  blob,
  filename,
  read,
  labels,
  room,
  limits,
}: {
  blob: Blob
  filename: string
  read: ViewApp["readServerResource"]
  labels: Labels
  room: Room
  limits: SheetLimits
}) {
  const [state, setState] = useState<Read>({ status: "loading" })
  const [selected, setSelected] = useState<number>()
  useEffect(() => {
    const controller = new AbortController()
    readSheets(read, blob, limits, controller.signal).then(
      (workbook) => setState({ status: "ready", workbook }),
      () => {
        if (!controller.signal.aborted) setState({ status: "failed" })
      }
    )
    return () => controller.abort()
  }, [blob, limits, read])

  if (state.status === "loading") return <Status>{labels.loading}</Status>
  if (state.status === "failed") return <Status>{labels.noPreview}</Status>
  const { sheets, active } = state.workbook
  const index = selected ?? active
  const sheet = sheets[index]
  if (!sheet) return <Status>{labels.sheetEmpty}</Status>
  if (sheets.length === 1)
    return (
      <SheetGrid
        sheet={sheet}
        label={filename}
        labels={labels}
        limits={limits}
        height={room.height}
      />
    )
  return (
    <div className="flex flex-col" style={{ height: room.height }}>
      <Tabs
        toolbar
        label={labels.sheets}
        tabs={sheets.map(({ name }, at) => ({ name: String(at), label: name }))}
        selected={String(index)}
        onSelect={(name) => setSelected(Number(name))}
        className="min-h-0 flex-1"
      >
        <SheetGrid
          sheet={sheet}
          label={`${filename}: ${sheet.name}`}
          labels={labels}
          limits={limits}
          height={room.height}
        />
      </Tabs>
    </div>
  )
}
