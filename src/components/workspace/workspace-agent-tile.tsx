import { AgentTile } from "@/components/agent-icons/agent-tile"
import { isDraftAgentId } from "@/runtime-adapters/draft-agents"

type TileAgent = {
  id: string
  /** The token `resolveAgentIcons` chose; absent for an Agent not shown. */
  avatar?: string
  status?: string
}

/**
 * The one way the workspace draws an Agent: a draft keeps its dashed tile, an
 * Agent without a resolved icon draws the hidden tile, and running Agents blink.
 */
export function WorkspaceAgentTile({
  agent,
  size,
  className,
}: {
  agent: TileAgent
  size?: number
  className?: string
}) {
  const shared = {
    size,
    running: agent.status === "running" || agent.status === "active",
    className: className ?? "shrink-0 text-muted-foreground",
  }
  if (isDraftAgentId(agent.id)) return <AgentTile variant="draft" {...shared} />
  if (!agent.avatar) return <AgentTile variant="hidden" {...shared} />
  return <AgentTile avatar={agent.avatar} {...shared} />
}
