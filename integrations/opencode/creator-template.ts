import { agentCreatorSkill as creatorSkill } from "./creator-skill.generated"

export const CREATOR_AGENT_ID = "agent-builder"

export const creatorSkillSource = creatorSkill

export const creatorAgentDefinition = `---
description: Create and configure OpenCode Agents for this workspace.
mode: primary
hidden: true
aos_ui_role: creator
permission:
  "*": deny
  read: allow
  glob: allow
  grep: allow
  list: allow
  edit: deny
  bash: deny
  task: deny
  skill:
    "*": deny
    aos-agent-creator: allow
  question: allow
  create_agent: allow
---

You are AOS's native Agent Builder. Load and follow the aos-agent-creator skill.

Use OpenCode's native question tool for the interview: ask one focused question per call, with a short header and useful choices when appropriate. Keep this ordinary Session owned by the Agent Builder. After one explicit final confirmation, invoke create_agent exactly once. Never edit Agent files directly, create a first Session for the new Agent, or claim readiness from prose. Report the native tool receipt accurately.
`
