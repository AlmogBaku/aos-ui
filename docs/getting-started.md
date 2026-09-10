# Get started with AOS

This tutorial runs AOS in fixture mode and introduces the workspace without requiring an AI runtime, model account, or credentials.

## Before you begin

Install [Bun](https://bun.sh/) and use a current desktop browser. Clone the repository if you have not already:

```bash
git clone https://github.com/AlmogBaku/aos-ui.git
cd aos-ui
```

## Start the fixture

Install dependencies and start Vite with the fixture runtime selected:

```bash
bun install
AOS_UI_RUNTIME_MODE=fixture bun run dev
```

Open <http://localhost:3000>. You should see Aster selected with the **Market brief** Session open.

> [!NOTE]
> Fixture data is deterministic and exists only for evaluation and browser testing. It never falls back into a misconfigured real deployment, and it does not offer Agent creation.

## Tour the workspace

1. Select another Agent in the left rail. The Session list changes with the Agent because every Session has exactly one owner.
2. Return to Aster and open a different Session tab. The conversation, Todos, and published Outputs change together.
3. Inspect the active Plan and Todo list. Plans belong to the message that produced them; Todos belong to the Session.
4. Open a published Output in the inspector. Close it to return to the Agent details.
5. Open Activity from the bell. Activity keeps notification history and unread state without becoming the source of truth for runtime work.
6. Open settings to switch appearance or language. Hebrew changes the workspace to RTL while preserving the same Agent and Session route.
7. Press `Ctrl`/`Cmd`+`K` to open the command palette. The keyboard reference in settings lists the current shortcuts.

On a narrow viewport, use the Agent and Session drawer instead of the desktop rails and tab strip.

## Stop the development server

Return to the terminal and press `Ctrl+C`.

## Connect real work

Install, authenticate, and start one runtime independently, then attach AOS to it. AOS does not own the runtime process or its data:

- [OpenCode](runtimes/opencode.md)
- [Hermes](runtimes/hermes.md)
- [Generic AG-UI](runtimes/ag-ui.md)

Compare them first in the [runtime capability matrix](runtime-capabilities.md). For container hosting, continue to [Deployment](deployment.md).
