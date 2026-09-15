# Get started with AOS

This tutorial attaches AOS UI to an independently operated agent harness, then introduces the workspace. AOS UI provides the operator interface; the harness provides agent execution, authentication, and durable data.

## Before you begin

For real work, you need:

- an authenticated AOS proxy connected to the harness selected by the
  deployment (Hermes is the primary and first-supported harness)
- any credentials required by that harness
- [Bun](https://bun.sh/)
- a current desktop browser

You can skip the harness and its credentials only when following the fixture preview later in this tutorial.

Clone the repository if you have not already:

```bash
git clone https://github.com/AlmogBaku/aos-ui.git
cd aos-ui
```

## Install AOS UI

Install the frontend dependencies:

```bash
bun install
```

## Connect your harness

Start and authenticate your harness independently, then choose **one**
connection guide. Begin with Hermes unless you specifically operate another
harness:

- [Run AOS with Hermes](runtimes/hermes.md)
- [Run OpenClaw behind the AOS proxy](runtimes/openclaw.md)
- [Run OpenCode behind the AOS proxy](runtimes/opencode.md)

Follow the local-development steps in that guide. When both the harness and AOS UI are running, open <http://localhost:3000>.

> [!IMPORTANT]
> AOS UI does not install or start the harness. Stopping AOS leaves the harness and its data running independently.

## Preview without a harness

If you only want to evaluate the interface, run the deterministic fixture instead:

```bash
AOS_UI_RUNTIME_MODE=fixture bun run dev
```

Open <http://localhost:3000>. You should see Aster selected with the **Market brief** Session open.

> [!NOTE]
> Fixture data is deterministic and exists only for evaluation and browser testing. It never falls back into a misconfigured real deployment, and it does not offer Agent creation.

## Tour the workspace

1. Select another Agent in the left rail. The Session list changes with the Agent because every Session has exactly one owner.
2. Return to Aster and inspect the recommendation, completed research subagent, investment chart, and Session Todo list in **Market brief**.
3. Open **Launch review** and inspect its Plan. Plans belong to the message that produced them; Todos belong to the Session.
4. Open Activity from the bell. Activity keeps notification history and unread state without becoming the source of truth for runtime work.
5. Open settings to switch appearance or language. Hebrew changes the workspace to RTL while preserving the same Agent and Session route.
6. Press `Ctrl`/`Cmd`+`K` to open the command palette. The keyboard reference in settings lists the current shortcuts.

On a narrow viewport, use the Agent and Session drawer instead of the desktop rails and tab strip.

## Stop the development server

Return to the terminal and press `Ctrl+C`.

Compare providers in the [runtime capability matrix](runtime-capabilities.md). For container hosting, continue to [Deployment](deployment.md).
