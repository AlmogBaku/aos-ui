import { tool } from "@opencode-ai/plugin"

/** A display-only bridge to AOS's accessible map tool UI. */
export default tool({
  description:
    "Render a small location map in the AOS conversation. Use only when the user explicitly asks for a map or location visualization and the locations are known. Supply coordinates as structured values, never map code or HTML. Do not invent real-world locations or coordinates.",
  args: {
    title: tool.schema.string().min(1).describe("A concise map title"),
    locations: tool.schema
      .array(
        tool.schema.object({
          id: tool.schema.string().min(1),
          label: tool.schema.string().min(1),
          latitude: tool.schema.number().min(-90).max(90),
          longitude: tool.schema.number().min(-180).max(180),
        })
      )
      .min(1),
  },
  async execute(args) {
    return `Map ready for display: ${args.title}`
  },
})
