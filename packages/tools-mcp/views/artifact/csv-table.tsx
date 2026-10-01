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
    <div
      tabIndex={0}
      role="region"
      aria-label={label}
      style={style}
      className="overflow-auto rounded-md border outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <table className="w-full border-collapse text-xs tabular-nums">
        {header ? (
          <thead className="sticky top-0 bg-muted">
            <tr>
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
          {body.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-b last:border-b-0">
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
      {truncated ? (
        <p className="m-0 border-t p-3 text-xs text-muted-foreground">
          {truncatedLabel(MAX_ROWS)}
        </p>
      ) : null}
    </div>
  )
}
