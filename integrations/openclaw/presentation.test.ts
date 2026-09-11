import { describe, expect, it } from "vitest"

import { createPresentationTools } from "./presentation.js"

describe("presentation tools", () => {
  it("uses the shared semantic chart schema and returns inspectable details", async () => {
    const tools = createPresentationTools()
    const result = await tools.render_chart.execute("call-1", {
      title: "Revenue",
      type: "bar",
      xKey: "month",
      series: [{ key: "amount", label: "Amount" }],
      data: [{ month: "Sep", amount: 42 }],
    })

    expect(result.details).toMatchObject({
      ok: true,
      type: "aos.presentation",
      presentation: { kind: "render_chart", value: { title: "Revenue" } },
    })
    expect(result.content[0]).toMatchObject({ type: "text" })
    expect(result.content[0]?.text).toContain('"amount": 42')
  })

  it("rejects a semantically invalid pie chart", async () => {
    const tools = createPresentationTools()
    await expect(
      tools.render_chart.execute("call-2", {
        title: "Empty pie",
        type: "pie",
        xKey: "label",
        series: [{ key: "value" }],
        data: [{ label: "none", value: 0 }],
      })
    ).rejects.toThrow()
  })
})
