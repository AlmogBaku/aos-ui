# Create an Agent on OpenClaw

An OpenClaw Agent is an id with its own workspace. Drive `openclaw.json` only
through `openclaw config set` and `openclaw config validate`; its schema is
strict, and one unknown key stops the Gateway.

1. Check the id is free: `openclaw agents list --json`. `main`, `openclaw`, and
   `crestodian` are reserved.
2. Create the Agent with the CLI:

   ```bash
   openclaw agents add <id> --workspace ~/.openclaw/workspace-<id> --non-interactive
   ```

   Use this command rather than an Agent-side creation tool: OpenClaw records
   an Agent another Agent created as delegated, and AOS keeps delegated Agents
   out of the roster.

3. Write the confirmed instructions to the workspace's `SOUL.md`. Write its name
   (and any emoji) to the workspace's `IDENTITY.md`, then apply it:

   ```bash
   openclaw agents set-identity --agent <id> --from-identity
   ```

   OpenClaw reads only its own bootstrap files (`AGENTS.md`, `SOUL.md`,
   `USER.md`, `IDENTITY.md`, `TOOLS.md`); do not invent others.

4. Copy each approved skill directory into the workspace. OpenClaw ignores a
   workspace skill whose real path leaves the workspace, so a link does not
   load:

   ```bash
   mkdir -p ~/.openclaw/workspace-<id>/skills
   cp -R <skill-dir> ~/.openclaw/workspace-<id>/skills/<skill-name>
   ```

5. Set only operator-approved configuration, then validate:

   ```bash
   openclaw config set <dot.path> <value>
   openclaw config validate
   ```

   Pass `--model <id>` to `agents add` only when the operator named a model.

6. Verify: `openclaw agents list --json` and
   `openclaw skills list --agent <id> --json`.
