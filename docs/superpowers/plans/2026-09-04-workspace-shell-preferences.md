# Workspace Shell Preferences Implementation Plan

> **For the implementing agent:** REQUIRED SKILLS: use `executing-plans`, `test-driven-development`, `shadcn`, `vercel-react-best-practices`, `vercel-composition-patterns`, `impeccable`, `agent-browser`, and `verification-before-completion`. Read each selected `SKILL.md` completely before changing code.

**Goal:** Add a persistent collapsible desktop inspector, first-class Light/System/Dark appearance controls, and a safe EN/HE locale switch without disturbing the locked spacious macOS-native workspace design.

**Architecture:** Keep preference state local to the shell. `next-themes` owns appearance persistence and system following; one small workspace preference component renders shadcn controls in the Agent rail footer. Desktop inspector visibility is independent from the existing mobile focus drawer and persists through one guarded local-storage key. Locale switching replaces only the locale URL segment and relies on the existing localized route.

**Tech stack:** Next.js 16.2.6 App Router, React 19, `next-themes` 0.4.6, Tailwind v4 semantic tokens, shadcn/Base UI, Lucide, Vitest, Testing Library, Playwright.

**Design reference:** `docs/superpowers/specs/2026-09-04-agent-workspace-completion-design.md`

---

## Task 1: Make locale replacement correct and test-first

**Files:**

- Modify: `lib/i18n/routing.ts`
- Modify: `lib/i18n/i18n.test.ts`

- [ ] Read `node_modules/next/dist/docs/01-app/01-getting-started/04-linking-and-navigating.md` and the installed `next/navigation` type declarations before implementing client navigation.

- [ ] Add failing tests for `/en -> /he`, `/he/session -> /en/session`, `/ -> /he`, a pathname without a locale, trailing slashes, and the invariant that no result contains two locale prefixes.

- [ ] Add `replaceLocaleInPathname(pathname, locale)`. Normalize one leading slash; replace the first segment only when it is a supported locale; otherwise prefix once. Do not accept an arbitrary locale string.

- [ ] Keep `localizePathname` for server/proxy callers but implement it through the same segment-safe helper if semantics permit.

- [ ] Run `bun test lib/i18n/i18n.test.ts`.

- [ ] Commit:

```bash
git add lib/i18n/routing.ts lib/i18n/i18n.test.ts
git diff --cached --check
git commit -m "fix: replace workspace locale paths safely"
```

## Task 2: Establish real semantic light and dark themes

**Files:**

- Modify: `components/theme-provider.tsx`
- Create: `components/theme-provider.test.tsx`
- Modify: `app/[locale]/layout.tsx`
- Modify: `app/globals.css`

- [ ] Add failing provider tests for System default, explicit Light/Dark selection persistence, live `prefers-color-scheme` changes while System is selected, explicit-mode immunity to OS changes, and the absence of the undocumented global `D` shortcut.

- [ ] Simplify `ThemeProvider` to `NextThemesProvider` with `attribute="class"`, `defaultTheme="system"`, `enableSystem`, and `disableTransitionOnChange`. Remove `ThemeHotkey` and `isTypingTarget` entirely.

- [ ] In the locale layout, remove the hardcoded `dark` class, add `suppressHydrationWarning` to `<html>`, and wrap the body content in `ThemeProvider`. Preserve font variables, locale `lang`, and locale `dir`.

- [ ] Split `app/globals.css`: use an Apple-like warm/light neutral `:root` palette with strong text contrast, and retain/refine the approved near-black palette under `.dark`. Keep the same semantic token names and introduce only shell shadow/scrim tokens needed to avoid dark-looking shadows in Light mode.

- [ ] Inspect all workspace-specific hardcoded foreground/background/shadow colors with `rg`. Move only mode-sensitive values to semantic tokens; preserve the locked spacing, radii, tabs, icon geometry, and AOS brand tint.

- [ ] Run `bun test components/theme-provider.test.tsx`, `bun run typecheck`, and `bun run lint`.

- [ ] Commit:

```bash
git add components/theme-provider.tsx components/theme-provider.test.tsx 'app/[locale]/layout.tsx' app/globals.css components/workspace/workspace-shell.module.css
git diff --cached --check
git commit -m "feat: add system-aware workspace themes"
```

## Task 3: Build the shadcn appearance and locale control

**Files:**

- Add through shadcn: `components/ui/toggle-group.tsx`
- Create: `components/workspace/workspace-preferences.tsx`
- Create: `components/workspace/workspace-preferences.test.tsx`
- Modify: `components/workspace/workspace-shell.tsx`
- Modify: `components/workspace/workspace-shell.module.css`
- Modify: `lib/i18n/dictionary.ts`
- Modify: `lib/i18n/en.ts`
- Modify: `lib/i18n/he.ts`

- [ ] If `toggle-group.tsx` is absent, run `bunx --bun shadcn@latest add toggle-group`, review the generated Base Nova component, and keep its API idiomatic rather than cloning it locally.

- [ ] Add typed dictionary keys for appearance label/Light/System/Dark and Switch to English/Hebrew. Add failing EN/HE component tests for the full accessible labels and destination-locale text.

- [ ] Implement `WorkspacePreferences` with a shadcn single-select `ToggleGroup` containing `Sun`, `Monitor`, and `Moon`. Ignore an empty change so one value remains selected. Before hydration, render stable controls without reading browser state; after mount, bind to `useTheme().theme`.

- [ ] Add one locale button showing the destination (`עב` in English, `EN` in Hebrew), with localized tooltip and accessible name. Build the target from `usePathname`, `replaceLocaleInPathname`, current search string, and current hash, then call `router.replace(target, { scroll: false })`.

- [ ] Place the composition in the Agent rail footer beneath Manage Agents. Reuse the same Agents panel inside the mobile focus drawer, so no duplicate preference implementation is needed.

- [ ] Use logical CSS properties, the existing restrained icon-button treatment, and a 44px effective touch target. Do not add a toolbar card or new visual container.

- [ ] Add tests that System is initially selected, the selected theme updates, empty selection is ignored, locale path/query/hash are preserved, and RTL labels/icons remain correct.

- [ ] Run `bun test components/workspace/workspace-preferences.test.tsx components/workspace/workspace-shell.test.tsx`.

- [ ] Commit:

```bash
git add components/ui/toggle-group.tsx components/workspace/workspace-preferences.tsx components/workspace/workspace-preferences.test.tsx components/workspace/workspace-shell.tsx components/workspace/workspace-shell.module.css lib/i18n/dictionary.ts lib/i18n/en.ts lib/i18n/he.ts
git diff --cached --check
git commit -m "feat: add workspace appearance and locale controls"
```

## Task 4: Add persistent desktop inspector collapse

**Files:**

- Modify: `components/workspace/workspace-shell.tsx`
- Modify: `components/workspace/workspace-shell.module.css`
- Modify: `components/workspace/workspace-shell.test.tsx`
- Modify: `lib/i18n/dictionary.ts`
- Modify: `lib/i18n/en.ts`
- Modify: `lib/i18n/he.ts`

- [ ] Add failing tests for the open default, changing Show/Hide Agent details label, `aria-expanded`, `aria-controls`, hidden desktop aside, persisted closed state, corrupt/unavailable storage fallback, focus retention, RTL icon mirroring, and independence from the mobile drawer.

- [ ] Add `desktopInspectorOpen`, defaulting to `true`. Hydrate it in an effect from `aos_ui:workspace:inspector-open`; accept only literal `true`/`false`; catch reads/writes and retain the safe default.

- [ ] Add a fixed inspector toggle after the scrollable Session tabs at the inline end of the tab bar. Use `PanelRightClose` when open and `PanelRightOpen` when closed, mirroring only this direction-sensitive glyph in Hebrew.

- [ ] Give the toggle localized changing labels, `aria-expanded`, and `aria-controls="workspace-agent-inspector"`. Give the desktop aside that ID and the `hidden` attribute when closed. Keep focus on the button after activation.

- [ ] Put `data-inspector-open` on the shell and change the desktop grid from three columns to two when closed. Let the existing flexible conversation column occupy the released width; do not animate layout under reduced motion.

- [ ] Do not couple `desktopInspectorOpen` to `inspectorDrawerOpen`. The mobile trigger, focus trap, Escape behavior, scrim, and trigger-focus restoration remain unchanged.

- [ ] Run `bun test components/workspace/workspace-shell.test.tsx` and `bun run typecheck && bun run lint`.

- [ ] Commit:

```bash
git add components/workspace/workspace-shell.tsx components/workspace/workspace-shell.module.css components/workspace/workspace-shell.test.tsx lib/i18n/dictionary.ts lib/i18n/en.ts lib/i18n/he.ts
git diff --cached --check
git commit -m "feat: make agent inspector collapsible"
```

## Task 5: Verify visual, responsive, locale, and persistence behavior

**Files:**

- Modify: `e2e/desktop.workspace.spec.ts`
- Modify: `e2e/mobile.workspace.spec.ts`
- Create: `e2e/preferences.workspace.spec.ts`
- Modify: `README.md`

- [ ] Add Playwright assertions that collapsing expands the conversation, reload preserves the choice, reopening restores the pane, and the selected Agent/Session never changes.

- [ ] Test `colorScheme: "light"` and `"dark"` with System selected, then prove an explicit theme overrides the emulated OS and survives reload. Assert semantic text/background contrast on representative shell surfaces rather than snapshotting every pixel.

- [ ] Test EN to HE and HE to EN with a query and hash. Assert one locale segment, document `lang`/`dir`, localized labels, preserved Agent/Session, and mirrored direction-sensitive icons.

- [ ] At a mobile viewport, prove Agent details still opens as a focus-managed drawer and preferences are reachable and keyboard/touch accessible through the Agents drawer.

- [ ] Run:

```bash
bun test lib/i18n components/theme-provider.test.tsx components/workspace
bunx playwright test e2e/preferences.workspace.spec.ts e2e/desktop.workspace.spec.ts e2e/mobile.workspace.spec.ts
bun run typecheck
bun run lint
bun run build
```

- [ ] Start one fixture dev server with a recorded PID and cleanup trap. Use `agent-browser` for EN Light, EN Dark, HE System, and a narrow viewport. Confirm contrast, spacing, focus, rounded shell, tabs, icons, and no theme flash or hydration warning. Stop the server before finishing.

- [ ] Document System default, theme persistence, locale routes, and inspector persistence in `README.md`.

- [ ] Commit:

```bash
git add e2e/desktop.workspace.spec.ts e2e/mobile.workspace.spec.ts e2e/preferences.workspace.spec.ts README.md
git diff --cached --check
git commit -m "test: verify workspace preferences"
```

## Definition of done

- Light/System/Dark work, persist, and follow OS semantics without a flash or hidden shortcut.
- EN/HE switching replaces the locale safely and preserves workspace context.
- Desktop inspector collapse is persistent, keyboard accessible, and independent from mobile drawers.
- The conversation expands cleanly; the locked rounded, spacious, shadcn/macOS visual direction remains intact.
- Inspector content remains identity/status/description/sessions only.
- Unit, component, Playwright, production build, and `agent-browser` checks pass in both directions and themes.
