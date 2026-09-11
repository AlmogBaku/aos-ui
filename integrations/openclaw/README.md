# AOS UI OpenClaw plugin

Native OpenClaw tools for AOS UI structured presentations, workspace artifacts,
cross-Agent root Session handoff, and approval-gated Agent creation.

The package pins the experimental OpenClaw SDK version it was tested against.
Build the package before installing it into OpenClaw:

```bash
bun install
bun run test
bun run build
```

Set `creatorAgentId` in the plugin configuration when the dedicated creator is
not named `agent-builder`. The creator Agent must already exist. `create_agent`
always requires a one-time native approval and refuses to overwrite an existing
Agent.

`present_artifact` currently performs the full workspace path, symlink,
sensitivity, regular-file, MIME, and size checks, then returns a text-only
fallback. OpenClaw 2026.9.4 does not expose a documented plugin API that can
register a local file and return an `artifacts.download` ID, so the plugin does
not fabricate a provider artifact reference.
