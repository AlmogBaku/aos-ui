import {
  AgentTile,
  type AgentTileProps,
  type AgentTileState,
} from "@/components/agent-icons/agent-tile"
import { isDraftAgentId } from "@/runtime-adapters/draft-agents"

type TileAgent = {
  id: string
  /** The token `resolveAgentIcons` chose; absent for an Agent not shown. */
  avatar?: string
  status?: string
}

/**
 * The one way the workspace draws an Agent: a draft keeps its dashed tile, an
 * Agent without a resolved icon draws the hidden tile, running Agents blink,
 * and an Agent waiting on the person looks around and hops.
 */
export function WorkspaceAgentTile({
  agent,
  size,
  lookToward,
  className,
}: {
  agent: TileAgent
  size?: number
  lookToward?: AgentTileProps["lookToward"]
  className?: string
}) {
  const shared = {
    size,
    state: tileState(agent.status),
    lookToward,
    className: className ?? "shrink-0 text-muted-foreground",
  }
  if (isDraftAgentId(agent.id)) return <AgentTile variant="draft" {...shared} />
  if (!agent.avatar) return <AgentTile variant="hidden" {...shared} />
  return <AgentTile avatar={agent.avatar} {...shared} />
}

function tileState(status?: string): AgentTileState | undefined {
  if (status === "attention") return "attention"
  if (status === "running" || status === "active") return "running"
  return undefined
}
