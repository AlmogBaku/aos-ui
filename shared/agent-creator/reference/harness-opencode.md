# Create an Agent on OpenCode

An OpenCode Agent is one Markdown file, `.opencode/agents/<id>.md`, in the
worktree OpenCode serves. The creator may write only new files in that
directory.

1. Check the id is free: list `.opencode/agents/`. Ids are lowercase letters,
   digits, and hyphens; `build`, `plan`, `general`, and `explore` are built in.
2. Write exactly one new file, `.opencode/agents/<id>.md`. The frontmatter holds
   the description, `mode: primary`, and least-privilege permissions; the body
   holds the confirmed instructions:

   ```markdown
   ---
   description: <one-sentence purpose>
   mode: primary
   permission:
     "*": deny
     read: allow
     glob: allow
     grep: allow
     list: allow
     question: allow
     skill:
       "*": deny
       <skill-name>: allow
   ---

   <confirmed instructions>
   ```

   Add `model: <provider/model>` only when the operator named a model. Grant
   `edit`, `bash`, or `webfetch` only when the confirmed definition needs them.

3. Never write any other file, and never change an existing one.

OpenCode lists the Agent once it reads the file; if AOS does not show it, tell
the operator to restart the OpenCode server.
