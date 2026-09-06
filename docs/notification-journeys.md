# Notification journeys (V1)

Activity is the notification inbox; provider state remains authoritative for work.
Browser tests mock Notification and document focus/visibility at their browser
boundaries. They do not observe host OS toasts.

| Journey | Expected result | Automated coverage |
| --- | --- | --- |
| Exact selected, visible, focused Session completes | Read Activity; no notice or OS delivery | Notification Playwright suite; policy/component tests |
| Another Session/Agent completes in foreground | Unread navigation markers; one coalesced notice | Notification Playwright suite |
| Tab hidden | One generic eligible notification | Notification Playwright suite |
| Window/app unfocused while document remains visible | Same background delivery policy | Separate notification Playwright case |
| Notification clicked | Close, focus, validate, open exact owning Agent/Session | Notification Playwright suite; stale-click component tests |
| Question/permission; failure | Attention/failure Activity and urgent notice; background categories apply | Notification Playwright suite; browser coordinator tests |
| Answer/withdraw request; cancel/retry run | Resolve without follow-up alert; cancel inline; distinct retry lifecycle | Fixture/OpenCode adapter and store tests |
| Agent ready/activation failure | Scoped completion/failure category | Fixture/OpenCode adapter and policy tests |
| Unknown or deleted target | Reject unknown arrivals; retained deleted target becomes unavailable without stale navigation | Playwright unknown target; coordinator/component deleted-target tests |
| Denied/unsupported permission | Activity works; no repeated prompt | Notification Playwright suite |
| Reload/hydrate | History remains; no OS replay or automatic permission prompt | Notification Playwright suite |
| Two loaded tabs | Synchronized read/preferences; one elected delivery; focused exact peer suppresses | Deterministic browser-tabs/leader tests; manual OS gate below |
| Desktop/mobile, English/Hebrew | Bell placement; drawer focus, Escape, restoration, inert background; RTL and reduced motion | Playwright; workspace-shell/Activity component tests (including accessible 9+ count) |
| All tabs closed | No new delivery | Architectural limit; manual OS gate |

Run browser coverage with `bunx playwright test e2e/notifications.desktop.workspace.spec.ts --workers=1`.
Run delivery/ownership coverage with `bunx vitest run lib/notifications components/workspace/browser-activity.test.tsx components/workspace/activity.test.tsx --maxWorkers=2`.

## Manual host OS gate

In a supported desktop browser, enable notifications from Activity settings,
start a delayed fixture run, switch to another website, observe exactly one
generic OS notification, click it, and confirm the correct Agent/Session.
Repeat while switching to another app with AOS still visible, then for
question/permission, failure, Hebrew, denied permission, and two loaded tabs.
Check OS notification settings/Do Not Disturb if no toast appears. Close all
AOS tabs to confirm there is no closed-app delivery. Host OS presentation,
real browser permission UI, and OS click activation require human observation;
automated mock delivery does not establish those outcomes.
