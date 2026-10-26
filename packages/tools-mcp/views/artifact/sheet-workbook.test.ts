import { describe, expect, it } from "vitest"
import { CFB, utils, write } from "xlsx"

import { readWorkbook } from "./sheet-workbook"

/**
 * A synthetic workbook as `bookType` writes it: "Leads", with a formatted
 * date and percentage and a formula saved with its value, a hidden "Notes",
 * and "Summary". An `.xlsx` is saved with "Summary" as its active sheet, which
 * SheetJS's writer never saves itself, so the test sets it in `workbook.xml`.
 */
function workbook(bookType: "xlsx" | "xls") {
  const book = utils.book_new()
  const leads = utils.aoa_to_sheet(
    [
      ["Lead", "Signed", "Win rate", "Seats"],
      ["Acme", new Date(Date.UTC(2026, 9, 1)), 0.25, 12],
      ["Total", "", "", 0],
    ],
    { cellDates: true }
  )
  leads.B2!.z = "yyyy-mm-dd"
  leads.C2!.z = "0%"
  leads.D3 = { t: "n", f: "D2*2", v: 24 }
  utils.book_append_sheet(book, leads, "Leads")
  utils.book_append_sheet(book, utils.aoa_to_sheet([["internal"]]), "Notes")
  utils.book_append_sheet(book, utils.aoa_to_sheet([["Total", 24]]), "Summary")
  book.Workbook = { Sheets: [{ Hidden: 0 }, { Hidden: 1 }, { Hidden: 0 }] }
  const bytes = new Uint8Array(write(book, { type: "array", bookType }))
  if (bookType === "xls") return bytes
  const zip = CFB.read(bytes, { type: "array" })
  const part = CFB.find(zip, "/xl/workbook.xml")
  const xml = new TextDecoder().decode(part.content)
  part.content = new TextEncoder().encode(
    xml.replace(
      "<sheets>",
      '<bookViews><workbookView activeTab="2"/></bookViews><sheets>'
    )
  )
  return new Uint8Array(CFB.write(zip, { fileType: "zip", type: "array" }))
}

describe("readWorkbook", () => {
  // SheetJS reads no active sheet from an `.xls`, which opens on its first.
  it.each([
    ["xlsx", 1],
    ["xls", 0],
  ] as const)(
    "reads an .%s's visible sheets as Excel shows their cells, and the sheet it was saved on (%s)",
    (bookType, active) => {
      const { sheets, active: opened } = readWorkbook(workbook(bookType), {
        rows: 500,
        columns: 100,
      })

      expect(sheets.map(({ name }) => name)).toEqual(["Leads", "Summary"])
      expect(sheets[0]).toEqual({
        name: "Leads",
        columns: ["A", "B", "C", "D"],
        rows: [
          { number: 1, cells: ["Lead", "Signed", "Win rate", "Seats"] },
          { number: 2, cells: ["Acme", "2026-10-01", "25%", "12"] },
          { number: 3, cells: ["Total", "", "", "24"] },
        ],
        truncated: false,
      })
      expect(opened).toBe(active)
    }
  )

  it.each(["xlsx", "xls"] as const)(
    "shows an .%s's rows and columns up to the limits, from A1, and says it holds more",
    (bookType) => {
      const [leads, summary] = readWorkbook(workbook(bookType), {
        rows: 2,
        columns: 2,
      }).sheets

      expect(leads).toEqual({
        name: "Leads",
        columns: ["A", "B"],
        rows: [
          { number: 1, cells: ["Lead", "Signed"] },
          { number: 2, cells: ["Acme", "2026-10-01"] },
        ],
        truncated: true,
      })
      expect(summary?.truncated).toBe(false)
    }
  )

  it("reads a sheet with no cells as one with no rows", () => {
    const book = utils.book_new()
    utils.book_append_sheet(book, utils.aoa_to_sheet([]), "Empty")

    expect(
      readWorkbook(write(book, { type: "array", bookType: "xlsx" }), {
        rows: 500,
        columns: 100,
      }).sheets
    ).toEqual([{ name: "Empty", columns: [], rows: [], truncated: false }])
  })

  it("refuses a file whose zip is broken", () => {
    expect(() =>
      readWorkbook(new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3]), {
        rows: 500,
        columns: 100,
      })
    ).toThrow()
  })
})
