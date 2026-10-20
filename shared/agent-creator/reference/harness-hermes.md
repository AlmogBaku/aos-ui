# Create an Agent on Hermes

A Hermes Agent is a **profile**: its own directory under
`~/.hermes/profiles/<id>/` with `config.yaml`, `.env`, `SOUL.md`, and
`skills/`. Drive every change through the `hermes` CLI; never hand-edit
`config.yaml` or `cron/jobs.json`.

Pass every user-supplied value in single quotes, writing each `'` inside it
as `'\''`.

1. Name this Session after the confirmed Agent name. Skip this step when
   `$HERMES_SESSION_ID` is empty:

   ```bash
   if [ -n "$HERMES_SESSION_ID" ]; then
     hermes sessions rename -- "$HERMES_SESSION_ID" '<name>'
   fi
   ```

2. Check the id is free: `hermes profile list`. Ids are lowercase letters,
   digits, and hyphens.
3. Create the profile without copying anything from the creator:

   ```bash
   hermes profile create <id> --no-alias --description '<one-sentence purpose>'
   ```

   Never pass `--clone`, `--clone-all`, or `--clone-from`.

   Give it the AOS UI tools, which a profile never inherits, at the address your
   own profile uses:

   ```bash
   hermes -p <id> config set mcp_servers.aos-ui.url "$(hermes config get mcp_servers.aos-ui.url)"
   hermes -p <id> mcp test aos-ui    # must list present_artifact
   ```

   If your own profile has no `aos-ui` server, skip these two and tell the
   operator the new Agent will have no charts, maps, stats, or Artifacts.

   Copy your own AOS note in either case. It tells the Agent what AOS renders
   and how to show files there, including in a Session begun elsewhere:

   ```bash
   hermes -p <id> config set platform_hints.aos-ui.append "$(hermes config get platform_hints.aos-ui.append)"
   ```

   If your own profile prints no note, tell the operator the new Agent has none.

4. Stamp the profile with this Session's id, so AOS retires the draft. Skip
   this step when `$HERMES_SESSION_ID` is empty. No `hermes` command sets it:
   edit `~/.hermes/profiles/<id>/profile.yaml` (not `config.yaml`) with your
   file tool, keeping every key already there, so that it holds:

   ```yaml
   ui_meta:
     aos:
       creatorSessionId: <the value of $HERMES_SESSION_ID>
   _ui_meta_revisions:
     aos: <one more than before, or 1 if absent>
   ```

   Raising the revision makes Hermes refuse an icon write AOS prepared before
   yours, which would otherwise erase the stamp. Read the file back to check
   both keys.

5. Write the confirmed instructions to `~/.hermes/profiles/<id>/SOUL.md`,
   replacing the seeded default. Persona and instructions belong there; Hermes
   reads no other persona file.
6. Link each approved skill; never copy it:

   ```bash
   ln -s <skill-dir> ~/.hermes/profiles/<id>/skills/<skill-name>
   ```

7. Set only operator-approved configuration, through the CLI:

   ```bash
   hermes -p <id> config get <dotted.key>      # the key must exist
   hermes -p <id> config set <dotted.key> <value>
   ```

   Change `model.default` only when the operator named a model.

8. Leave tool progress on, which AOS needs: with `display.tool_progress` set
   to `off`, Hermes streams no tool calls live, and they appear in AOS only
   after a reload. It defaults to `all`; set it back only if it was changed:

   ```bash
   hermes -p <id> config set display.tool_progress all
   ```

9. Verify: `hermes profile show <id>`, `hermes -p <id> skills list`, and
   `hermes -p <id> config get display.tool_progress`, which prints `all` or
   nothing.

A new profile is visible in AOS by default. `hermes profile create` tells a
running gateway to serve it; if AOS does not list it within a minute, tell the
operator to restart the Hermes gateway.
