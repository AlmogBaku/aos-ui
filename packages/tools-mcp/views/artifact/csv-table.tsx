import { useMemo, type CSSProperties } from "react"

/** The most rows a CSV preview lays out; Download carries the rest. */
const MAX_ROWS = 500

/**
 * RFC 4180 rows: quoted fields may hold commas, line breaks, and doubled
 * quotes. Reading stops one row past `maxRows`, which marks it truncated.
 */
export function parseCsv(input: string, maxRows = MAX_ROWS) {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let quoted = false
  const finishRow = () => {
    row.push(field)
    rows.push(row)
    row = []
    field = ""
  }
  for (let index = 0; index < input.length && rows.length <= maxRows; index++) {
    const character = input[index]!
    if (quoted) {
      if (character !== '"') field += character
      else if (input[index + 1] === '"') {
        field += '"'
        index += 1
      } else quoted = false
    } else if (character === '"' && field.length === 0) quoted = true
    else if (character === ",") {
      row.push(field)
      field = ""
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && input[index + 1] === "\n") index += 1
      finishRow()
    } else field += character
  }
  if (rows.length <= maxRows && (field.length > 0 || row.length > 0))
    finishRow()
  return { rows: rows.slice(0, maxRows), truncated: rows.length > maxRows }
}

/**
 * Rows of text as a table in a box of its own that scrolls, under a sticky
 * row naming the columns. With `rowHeaders`, each row leads with its own name,
 * which stays in view as the table scrolls sideways. `note` follows the table.
 */
export function DataTable({
  header,
  rows,
  rowHeaders,
  label,
  note,
  style,
}: {
  header: readonly string[] | undefined
  rows: readonly (readonly string[])[]
  rowHeaders?: readonly string[]
  label: string
  note?: string | undefined
  style: CSSProperties
}) {
  return (
    <div
      tabIndex={0}
      role="region"
      aria-label={label}
      style={style}
      className="overflow-auto rounded-md border outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <table className="w-full border-collapse text-xs tabular-nums">
        {header ? (
          <thead className="sticky top-0 z-10 bg-muted">
            <tr>
              {rowHeaders ? (
                <td className="sticky start-0 border-b bg-muted" />
              ) : null}
              {header.map((cell, index) => (
                <th
                  key={index}
                  scope="col"
                  dir="auto"
                  className="border-b px-3 py-2 text-start font-medium"
                >
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
        ) : null}
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-b last:border-b-0">
              {rowHeaders ? (
                <th
                  scope="row"
                  className="sticky start-0 bg-muted px-3 py-2 text-end font-medium text-muted-foreground"
                >
                  {rowHeaders[rowIndex]}
                </th>
              ) : null}
              {row.map((cell, cellIndex) => (
                <td
                  key={cellIndex}
                  dir="auto"
                  className="px-3 py-2 text-start align-top whitespace-pre-wrap"
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {note ? (
        <p className="m-0 border-t p-3 text-xs text-muted-foreground">
          {note}
        </p>
      ) : null}
    </div>
  )
}

/** A CSV file as a table whose first row names the columns. */
export function CsvTable({
  text,
  label,
  truncatedLabel,
  style,
}: {
  text: string
  label: string
  truncatedLabel: (rows: number) => string
  style: CSSProperties
}) {
  const { rows, truncated } = useMemo(() => parseCsv(text), [text])
  const [header, ...body] = rows
  return (
    <DataTable
      header={header}
      rows={body}
      label={label}
      note={truncated ? truncatedLabel(MAX_ROWS) : undefined}
      style={style}
    />
  )
}
