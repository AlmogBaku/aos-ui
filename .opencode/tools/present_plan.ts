import { tool } from "@opencode-ai/plugin"

/** A message-scoped, display-only plan artifact. It never creates todos. */
export default tool({
  description:
    "Present a concise, message-scoped plan in the AOS conversation. Use when the user asks for a plan or strategy. This is not execution state: do not use it for task tracking, and do not create Todos through this tool.",
  args: {
    id: tool.schema.string().min(1).describe("A stable plan identifier"),
    title: tool.schema.string().min(1),
    steps: tool.schema
      .array(
        tool.schema.object({
          id: tool.schema.string().min(1),
          label: tool.schema.string().min(1),
          status: tool.schema.enum([
            "pending",
            "active",
            "completed",
            "failed",
          ]),
        })
      )
      .min(1),
  },
  async execute(args) {
    return `Plan ready for display: ${args.title}`
  },
})
