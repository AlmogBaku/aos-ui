import { tool } from "@opencode-ai/plugin"

/**
 * A display-only bridge to AOS's chart tool UI.
 *
 * The structured arguments are retained in the OpenCode tool-call part, which
 * lets the client render them safely. This tool never executes generated code
 * or writes files.
 */
export default tool({
  description:
    "Render a line, bar, or pie chart in the AOS conversation. Use when the user explicitly asks for a chart, graph, or visualization. Supply the data as structured values, not code. For a pie chart, supply exactly one numeric series. Do not invent factual data: if no data is given, make a clearly titled illustrative example.",
  args: {
    title: tool.schema.string().min(1).describe("A concise chart title"),
    type: tool.schema.enum(["line", "bar", "pie"]),
    xKey: tool.schema
      .string()
      .min(1)
      .describe("The category or horizontal-axis field name"),
    series: tool.schema
      .array(
        tool.schema.object({
          key: tool.schema.string().min(1),
          label: tool.schema.string().min(1),
        })
      )
      .min(1),
    data: tool.schema
      .array(
        tool.schema.record(
          tool.schema.string(),
          tool.schema.union([tool.schema.string(), tool.schema.number()])
        )
      )
      .min(1),
  },
  async execute(args) {
    return `Chart ready for display: ${args.title}`
  },
})
