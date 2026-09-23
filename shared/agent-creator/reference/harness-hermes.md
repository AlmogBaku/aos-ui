# Create an Agent on Hermes

A Hermes Agent is a **profile**: its own directory under
`~/.hermes/profiles/<id>/` with `config.yaml`, `.env`, `SOUL.md`, and
`skills/`. Drive every change through the `hermes` CLI; never hand-edit
`config.yaml` or `cron/jobs.json`.

1. Check the id is free: `hermes profile list`. Ids are lowercase letters,
   digits, and hyphens.
2. Create the profile without copying anything from the creator:

   ```bash
   hermes profile create <id> --no-alias --description "<one-sentence purpose>"
   ```

   Never pass `--clone`, `--clone-all`, or `--clone-from`.

3. Write the confirmed instructions to `~/.hermes/profiles/<id>/SOUL.md`,
   replacing the seeded default. Persona and instructions belong there; Hermes
   reads no other persona file.
4. Link each approved skill; never copy it:

   ```bash
   ln -s <skill-dir> ~/.hermes/profiles/<id>/skills/<skill-name>
   ```

5. Set only operator-approved configuration, through the CLI:

   ```bash
   hermes -p <id> config get <dotted.key>      # the key must exist
   hermes -p <id> config set <dotted.key> <value>
   ```

   Change `model.default` only when the operator named a model.

6. Verify: `hermes profile show <id>` and `hermes -p <id> skills list`.

A new profile is visible in AOS by default. `hermes profile create` tells a
running gateway to serve it; if AOS does not list it within a minute, tell the
operator to restart the Hermes gateway.
