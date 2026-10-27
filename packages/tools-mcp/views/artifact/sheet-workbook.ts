import {
  read,
  utils,
  type CellObject,
  type WorkBook,
  type WorkSheet,
} from "xlsx"

/**
 * The most of each sheet the view lays out, counted from A1, as Excel
 * numbers rows and columns.
 */
export type SheetLimits = { rows: number; columns: number }

/** One row: its number, as Excel shows it, and each cell's text. */
export type SheetRow = { number: number; cells: string[] }

/**
 * One visible sheet: its name, the letters of the columns it shows, its rows,
 * and whether it holds more than the limits let it show.
 */
export type Sheet = {
  name: string
  columns: string[]
  rows: SheetRow[]
  truncated: boolean
}

/** A workbook's visible sheets, and the one it was saved on. */
export type Workbook = { sheets: Sheet[]; active: number }

/**
 * The sheet `workbook` was saved on, by its place among all its sheets.
 * SheetJS reads it from an `.xlsx`'s workbook view, which its types leave out,
 * and from no `.xls`.
 */
function savedTab(workbook: WorkBook) {
  const views = (workbook.Workbook as { WBView?: unknown } | undefined)?.WBView
  const tab = Array.isArray(views)
    ? Number((views[0] as { activeTab?: unknown } | undefined)?.activeTab)
    : Number.NaN
  return Number.isInteger(tab) ? tab : 0
}

/**
 * A cell as Excel shows it: its number format applied, a formula's value as
 * the file saved it, and an error as its code. A formula the file saved no
 * value for, as openpyxl writes them, shows as itself, since nothing here
 * recalculates it.
 */
function cellText(cell: CellObject | undefined) {
  if (cell === undefined) return ""
  // SheetJS's types promise a string, which a bare formula does not have.
  const shown: string | undefined = utils.format_cell(cell)
  return shown ?? (cell.f === undefined ? "" : `=${cell.f}`)
}

/** The rows of cells a sheet read in dense mode holds. */
type DenseSheet = WorkSheet & { "!data"?: (CellObject | undefined)[][] }

/** The part of `sheet`'s used range inside `limits`, each cell as Excel shows it. */
function sheetOf(name: string, sheet: DenseSheet, limits: SheetLimits): Sheet {
  const used = sheet["!ref"]
  if (!used) return { name, columns: [], rows: [], truncated: false }
  const range = utils.decode_range(used)
  // A sheet read only up to the row limit keeps its whole range here.
  const whole = utils.decode_range(sheet["!fullref"] ?? used)
  const end = {
    r: Math.min(range.e.r, limits.rows - 1),
    c: Math.min(range.e.c, limits.columns - 1),
  }
  const truncated = whole.e.r > end.r || whole.e.c > end.c
  if (end.r < range.s.r || end.c < range.s.c)
    return { name, columns: [], rows: [], truncated }
  const data = sheet["!data"] ?? []
  const columns = Array.from(
    { length: end.c - range.s.c + 1 },
    (_, index) => range.s.c + index
  )
  return {
    name,
    columns: columns.map((column) => utils.encode_col(column)),
    rows: Array.from({ length: end.r - range.s.r + 1 }, (_, index) => {
      const row = range.s.r + index
      return {
        number: row + 1,
        cells: columns.map((column) => cellText(data[row]?.[column])),
      }
    }),
    truncated,
  }
}

/**
 * The visible sheets of the workbook in `bytes`, each up to `limits`, and the
 * one it was saved on. SheetJS reads only the rows the limit lets show, and
 * throws for a broken zip or Excel 97 file; any other bytes it reads as text.
 */
export function readWorkbook(
  bytes: ArrayBuffer | Uint8Array,
  limits: SheetLimits
): Workbook {
  const workbook = read(bytes, {
    type: "array",
    dense: true,
    sheetRows: limits.rows,
  })
  const settings = workbook.Workbook?.Sheets ?? []
  const visible = workbook.SheetNames.flatMap((name, index) =>
    settings[index]?.Hidden ? [] : [{ name, index }]
  )
  const tab = savedTab(workbook)
  return {
    sheets: visible.map(({ name }) =>
      sheetOf(name, workbook.Sheets[name]!, limits)
    ),
    active: Math.max(
      0,
      visible.findIndex(({ index }) => index === tab)
    ),
  }
}
