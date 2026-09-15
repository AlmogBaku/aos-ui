# AOS Runtime Proxy Phases 2 and 3 — Recovery Status

Updated: 2026-09-15

## Current checkpoint

### Phase 2/3 implementation complete

- OpenCode and OpenClaw are both selected through the server-only runtime
  factory. OpenClaw final assembly is independently approved through
  `0be6e8d`; deployment boundaries are fixed through `e9bc89e`; maintained
  operator docs are committed at `861202f`.
- Final provider evidence: OpenCode focused gate 98/98; OpenClaw integration
  gate 161/161; proxy baseline 541/541; proxy/browser AOS E2E journey passed,
  including history, send, stream, Stop, and reconnect.
- `bun run typecheck`, `bun run lint`, `bun run build`,
  `bun run integrations:build`, and `bun run hermes:test` passed.
- Compose tests pass 12/12 and base, Hermes, OpenCode, and OpenClaw Compose
  configurations validate. The web and OpenCode images build; an isolated web
  container served health, runtime config, and the built application.
- Full repository tests reported 1,663 passing and 6 failures in concurrently
  modified user-owned UI/AOS browser files. Browser E2E reported 75 passing and
  2 failures on the same UI presentation work. Per user instruction these are
  another agent's work and are not Phase 2/3 proxy blockers.
- No Agent Browser or live OpenCode/OpenClaw target was used. Native live
  acceptance remains explicitly unclaimed.

- OpenCode is complete and integrated through central runtime selection at
  `00cee7c`. Its focused integration gate passes 98 tests plus proxy typecheck,
  ESLint, formatting, and diff checks.
- The complete proxy baseline at this checkpoint passes 43 files / 541 tests.
- OpenClaw CL2 is independently approved at `18ea903`. Its focused review
  passes 87 tests plus proxy typecheck, ESLint, and diff checks, including
  native `main` aliases and strict rejection of foreign non-main Sessions.
- The OpenClaw provider lead is integrating approved CL2 and completing the
  single adapter/factory assembly. This is the only provider implementation on
  the critical path.
- After OpenClaw assembly, main owns only: central OpenClaw selection, reviewed
  deployment candidate integration, maintained docs, browser import-boundary
  enforcement, and the single final stable-tree verification pass.
- Execution correction: do not reopen approved slices, create edge-case leaf
  agents, or repeatedly run broad suites. Keep one provider owner, review the
  assembled boundary once, and run shared verification at completed
  checkpoints only.

## Identity

- Integration worktree: `/home/anakin/projects/aos-ui/.worktrees/aos-runtime-proxy-hermes`
- Integration branch: `codex/aos-runtime-proxy-hermes`
- Approved plan: `docs/superpowers/plans/2026-09-14-aos-runtime-proxy-phases-2-3.md`
- Dirty repository root `main` is user-owned and must remain untouched.

## Completed

- On 2026-09-15 the main integration agent loaded both worktree-local AOS
  skills completely. `aos-runtime-adapter` governs all Phase 2/3 adapter,
  shared-seam, and provider-review work. `aos-deploy` was inspected only to
  preserve its boundary and is not activated because no live deployment was
  authorized. Assistant-ui skills are not substitutes for either AOS skill.
- P1 Hermes proxy and provider-neutral browser runtime were complete before
  this phase.
- D0 exact official-client checkpoint committed as
  `build(proxy): pin official runtime clients`.
- D0 RED: the construction test resolved OpenClaw `2026.8.1` instead of the
  required `2026.9.4`.
- D0 GREEN: focused probe passed 2 tests; full TypeScript typecheck and focused
  ESLint passed.
- Fresh pre-D0 baseline: 149 test files, 1419 tests passed.
- OC0 official OpenCode client facade committed as `5d3aaf8`; provider report
  records 6 focused tests plus proxy typecheck and focused lint passing.
- CL0 official OpenClaw Gateway facade committed as `d463cab`; provider report
  records 11 focused tests plus proxy typecheck, lint, and formatting passing.
- Plan skill gate clarified and committed as `f62dc6e`: the main owner, leads,
  and leaves must load the worktree-local AOS adapter skill; assistant-ui
  runtime skills are not substitutes.
- OC0 fix rounds resolved review findings and the frozen foundation is
  `0491481`; focused suite is 14 tests including official-client probes, with
  proxy typecheck passing. Independent re-review approved it.
- CL0 fix rounds resolved review findings and the frozen foundation is
  `5c4fadb`; focused suite is 21 tests including official-client probes, with
  proxy typecheck passing. Independent re-review approved it.
- OC1 workspace/history is approved at `9140603` after exact v2 history,
  invite single-flight, and honest unavailable-operation fixes.
- CL1 workspace/history is approved at `ca2c5ff` after pagination, bounded
  validation, disclosure, stable routing, and dirty-read fixes.
- Main added the demonstrated capability generalization in `11b03f9`: approval
  choices are provider-supported subsets and question cancellation preserves
  `native-empty-answer` versus `native-reject`.
- Main fixed the shared Stop boundary in `f6bff9f`: a definitely undispatched
  native Stop keeps the coordinator run active, while ambiguous dispatch still
  becomes uncertain. Focused coordinator/routes tests passed 30/30.
- OC3 interactions/content/capabilities is approved at `519527e` after strict
  rich-output validation, native attachment mapping, exact interaction
  reconciliation, and replay/uncertainty fencing. Focused tests passed 20/20.
- CL3 interactions/content/capabilities is approved at `3ed64ed` after exact
  question/approval reconciliation, terminal settlement, scoped receipt
  handling, and honest capability reporting.
- Main generalized demonstrated negotiated capability values in `0254850`
  (provider-dependent MIME policy and complete-request attachment limits) and
  `24295cc` (native cancel and complete-request answer-value limits). Affected
  protocol, guest projection, and browser tests passed 40/40.
- OC4 non-run assembly is committed at `9a42286`; it has one provider-local
  adapter/factory and no shared seam. Actual OC2 construction and invalidation
  streaming remain pending run approval.
- CL4 non-run assembly is committed at `b65241b`; actual CL2 construction and
  the CL3 bound-resume/capability handoff remain pending.
- Main added the demonstrated server-only staged-content seam in `0eedde1`:
  operator and guest routes pass the one-shot `ServerAttachmentStage` directly
  through `SessionCoordinator` to the selected native run engine. This lets
  OpenCode/OpenClaw use their real structured attachment inputs without a new
  public model or text-envelope emulation; focused core/app/guest tests passed
  53/53.
- Main added truthful unavailable model/context capability variants in
  `6bcfed7`; protocol, guest projection, browser client, and composer tests
  passed 41/41. Proxy typecheck remains intentionally red only at the central
  runtime factory until the OpenCode/OpenClaw factory cases land.
- Main generalized demonstrated idempotent Stop status rechecks in `2c033ee`;
  coordinator/Hermes/operator/guest focused tests passed 127/127. Hermes sends
  one native interrupt and later Stop calls perform authoritative status-only
  reconciliation.
- Main fixed guest projection of standard expiring AG-UI interrupts in
  `6243541`; `expiresAt` is validated but omitted with provider metadata, and
  the normalized permanent approval value remains filtered. Focused guest
  projection/route tests passed 36/36.
- CL3 content/interactions is independently approved through `5596137` after
  cold discovery, normalized approval choice mapping, and complete official
  question/approval validation. OpenClaw provider lead has integrated its
  provider-only sequence but is holding assembly for CL2 approval.
- Repository-only deployment candidate is `0050a67` plus fixes `3d477cc` and
  `7ba5058`: proxy-only overlays, mounted provider secrets, provider-neutral
  public config, Compose validation, and OpenCode image build passed. It is
  not yet integrated and no live deployment was attempted.
- Main added repeated authoritative refresh of recovered waiting executions in
  `4b6e915`; a provider `discover` result can replace the normalized waiting
  segment, while `undefined` clears it and permits a later new turn. Focused
  coordinator, route, and Hermes regressions passed 129/129.
- OpenClaw CL3 is complete through `25bde9c`: cold interaction discovery now
  requires a complete, exact-Session, non-truncated approval replay and a
  unique combined question/approval batch. The provider lead has integrated
  this sequence while holding CL2 for its final run/recovery fix.
- OpenCode OC2 is complete except for a Stop-acknowledgement/replacement race
  and the provider-local cold pending-interaction `discover` path. The prior
  candidate `4e358c1` is not approved; its tests did not cover acknowledgement
  arriving after the replacement projector existed.
- OpenClaw CL2 is implementing its final two corrections: refresh approval
  replay after an exact scoped live approval transition dirties discovery, and
  refresh/clear a coordinator-retained wait from authoritative native state.
- Strict private Hermes/OpenCode/OpenClaw runtime configuration is committed in
  `45ce84b` with the lint-safe username correction in `c3e3f62`; 22 focused
  tests, focused lint, and formatting pass. Proxy typecheck remains red only at
  the intentionally incomplete central selector.
- The demonstrated optional OpenClaw attachment policy gap is represented by
  the small shared capability union in `34ae6fb`. Protocol, guest projection,
  browser client/composer tests pass 42/42; shared/app typechecks and focused
  lint/format pass.
- OC2 is independently approved at `4bc3b6f`: Stop acknowledgement follows an
  exact replacement observation, and cold pending-interaction discovery uses
  ownership plus a complete authoritative batch behind a live SSE dirty-read
  fence. Its focused suite passes 130/130.
- CL2 `0e2ef73` closed its earlier recovery findings but remains unapproved for
  one exact official-client case: OpenClaw may return a logical subscription
  key plus a distinct canonical approval replay/event routing key. The final
  fix retains those identities separately and covers pre-ack canonical events.

## Active owners

| Role | Agent task | Worktree | State |
| --- | --- | --- | --- |
| main integration owner | `/root` | `aos-runtime-proxy-hermes` | coordinating |
| OpenCode provider lead | `/root/opencode_foundation` | `aos-runtime-proxy-opencode-v2` | holding partial assembly; designing the minimal cold-interaction binding |
| OpenClaw provider lead | `/root/openclaw_foundation` | `aos-runtime-proxy-openclaw-v2` | CL4/CL3 assembled; holding for corrected CL2 |
| OpenCode data | `/root/opencode_data` | `aos-opencode-data-v2` | OC1 approved at `9140603` |
| OpenCode runs | `/root/opencode_runs` | `aos-opencode-runs-v2` | final Stop race plus cold interaction discovery |
| OpenCode content | `/root/opencode_content_fix4` | `aos-opencode-content-v2` | OC3 approved at `519527e` |
| OpenClaw data | `/root/openclaw_data` | `aos-openclaw-data-v2` | CL1 approved at `ca2c5ff` |
| OpenClaw runs | `/root/openclaw_runs` | `aos-openclaw-runs-v2` | final live-approval and waiting-refresh corrections |
| OpenClaw content | `/root/openclaw_content_fix4` | `aos-openclaw-content-v2` | CL3 complete at `25bde9c` |

## Next dependency edge

1. Finish and approve the final CL2 logical-versus-canonical Session routing
   correction.
2. Complete OC4 assembly from approved OC2 while CL2 finishes.
3. Resume the OpenClaw provider lead to integrate approved CL2 into
   `adapter.ts` and `factory.ts`.
4. Main cherry-picks provider assembly into the integration worktree and lands
   shared config/factory/deployment serially: OpenCode first, OpenClaw second.

## Rulings

- `OpenClaw mode: "backend"` remains: the pinned official client's README
  identifies `gateway-client` / `backend` as the normal Node-client default.
  The current approved plan requires fixed pre-provisioned device credentials
  but does not require a browser/UI pairing mode.
- The OpenClaw wrapper may retain the official client's generic RPC seam for
  simplicity. Each provider operation module must validate its exact native
  request and result before conversion; the generic transport method itself
  is never exposed outside the server-side adapter package.
- OpenClaw cold recovery does not widen the shared reconnect contract or add
  proxy state. After restart it adopts only a unique exact native run reported
  by authoritative Agent-and-Session history/active-run data, suppresses the
  already-loaded cumulative prefix, and projects only buffered/live suffix.
  Missing or ambiguous native identity fails closed. CL3 tombstones bind only
  retained-runtime interrupt response dispatch and idempotency.
- A fresh normalized recovered run ID is coordinator identity, not a claim
  about an unavailable provider-native run identity. OpenCode cold pending
  interaction recovery therefore requires only authoritative Agent/Session
  ownership and a complete exact-Session question-plus-permission read. It
  must not invent or demand a native prompt-interval association that the
  pinned API does not expose. Identified AOS-run reconnect continues through
  the existing durable admission/cursor recovery path.
- Keep the remaining execution coarse-grained: each provider run owner closes
  its complete remaining lifecycle, one finished slice receives one review,
  and repository-wide verification runs only after all writers stop. Do not
  create extra agents or interfaces for individual edge cases.

## Main integration work in progress

- Private runtime-config tests now cover the exact OpenCode and OpenClaw
  variants and are green (22 tests).
- `packages/proxy/config.ts` contains the strict discriminated union locally.
- `tsconfig.proxy` is intentionally red only because the central runtime
  factory has no OpenCode/OpenClaw factory cases yet. Do not weaken the union;
  complete the factory after provider assembly.

## Verification validity

- Baseline suite predates D0 and is not final evidence.
- D0 focused tests/typecheck/lint are valid for the dependency checkpoint.
- No provider, integration, E2E, image, or live-native acceptance has run yet.
- Run expensive repository-wide checks only after all writers are idle.

## Constraints still in force

- Every provider lead, leaf, and provider reviewer must load the worktree-local
  `.agents/skills/aos-runtime-adapter/SKILL.md` plus its required normative
  documents before editing or approving work. Every handoff must explicitly
  report the skill-required native evidence, mapping, verification, and honest
  unavailable capabilities; inherited context is insufficient.
- `.agents/skills/aos-deploy/SKILL.md` is conditional on a separately approved
  live deployment and is not activated by repository Compose work.
- No shared contract edits by provider or leaf agents.
- One selected `RuntimeInstance` is shared across operator and guest listeners.
- No browser-native provider code, ACP, second SPI, DB, or speculative replay
  infrastructure.
- No Agent Browser and no live target without explicit approval.
- Do not touch `.agents/ADRs/`.
