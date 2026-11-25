import {
  isPermissionGranted,
  onNotificationClicked,
  onNotificationReceived,
  registerForPushNotifications,
  requestPermission,
} from "@choochmeque/tauri-plugin-notifications-api";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { openUrl } from "@tauri-apps/plugin-opener";
import { connect, shellStatus, type ShellStatus } from "./shell";
import {
  buildReport,
  errText,
  loadState,
  MEASUREMENTS,
  onResultsChanged,
  saveState,
  setListenerHost,
  setResult,
  state,
  statusLabel,
} from "./state";
import * as T from "./tests";

const $ = <E extends HTMLElement>(id: string) => document.getElementById(id) as E;
const pageStartedMs = Date.now();
let status: ShellStatus | null = null;
let pushToken: string | null = null; // memory only: never saved, never in the report

// --- results table -----------------------------------------------------------

function renderResults(): void {
  const body = $("results").querySelector("tbody");
  if (!body) return;
  body.replaceChildren(
    ...MEASUREMENTS.map((m) => {
      const r = state.results[m.id];
      const tr = document.createElement("tr");
      const cls = r?.status === "pass" ? "pass" : r?.status === "fail" ? "fail" : r ? "na" : "";
      const cells = [m.id, m.name, statusLabel(r?.status), r ? `${r.detail}\n(launch #${r.launch}, ${r.at})` : ""];
      cells.forEach((text, i) => {
        const td = document.createElement("td");
        td.textContent = text;
        if (i === 2 && cls) td.className = cls;
        if (i === 3) td.className = "detail";
        tr.append(td);
      });
      return tr;
    }),
  );
}
onResultsChanged(renderResults);

function reportHeader(): string[] {
  const listener = T.ctx.origin ? T.ctx.origin : "not connected";
  return [
    `generated: ${new Date().toISOString()}`,
    `page: ${location.href} (origin ${JSON.stringify(location.origin)})`,
    `shell: os=${status?.os ?? "?"} arch=${status?.arch ?? "?"} tauri=${status?.tauriVersion ?? "?"} app=${status?.appVersion ?? "?"}`,
    `webview: ${navigator.userAgent}`,
    `language: ${navigator.language}`,
    `listener: ${listener}`,
    `launches recorded: ${state.launchCount}`,
  ];
}

async function copyText(text: string): Promise<string> {
  try {
    await navigator.clipboard.writeText(text);
    return "copied";
  } catch (e) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok ? "copied (fallback)" : `copy failed (${errText(e)}); use "Show results as text"`;
  }
}

// --- interactive cards -------------------------------------------------------

interface Card {
  el: HTMLElement;
  log: HTMLElement;
}

function card(title: string, text: string, buttons: Array<[string, () => unknown]>, withLog = false): Card {
  const el = document.createElement("div");
  el.className = "card";
  const h = document.createElement("h3");
  h.textContent = title;
  const p = document.createElement("p");
  p.textContent = text;
  const log = document.createElement("p");
  log.className = "muted";
  const row = document.createElement("div");
  row.className = "row";
  for (const [label, fn] of buttons) {
    const b = document.createElement("button");
    b.textContent = label;
    b.addEventListener("click", () => {
      void Promise.resolve()
        .then(fn)
        .catch((e) => (log.textContent = errText(e)));
    });
    row.append(b);
  }
  el.append(h, p, row);
  if (withLog) el.append(log);
  return { el, log };
}

function buildInteractive(): void {
  const root = $("interactive");
  const c6 = card(
    "6. Socket in the background",
    "Press 6a, wait for a tick or two, then leave the app for 60 s (iPhone: go to the home screen; Mac: minimise the window with Cmd+M). Come back and press 6b.",
    [
      ["6a. Open tick socket", () => T.t6Open((s) => (c6.log.textContent = s))],
      ["6b. I backgrounded the app for 60 s and came back", () => T.t6Check()],
    ],
    true,
  );
  const c9 = card(
    "9. Runtime grant after a restart",
    "Run this LAST of the network tests (it grants example.com until the app restarts). The app grants example.com for this run only, checks it works, then asks the process plugin to relaunch. The check runs by itself on the next launch; then mark how the relaunch went.",
    [
      ["9a. Grant example.com for this run, then restart", () => T.t9Grant((s) => (c9.log.textContent = s))],
      ["9r. The app reopened by itself", () => T.t9MarkRelaunch(true)],
      ["9r. I had to reopen it", () => T.t9MarkRelaunch(false)],
    ],
    true,
  );
  const c11 = card(
    "11. Microphone",
    "Press Record; it records 2 s. Then mark whether a permission prompt appeared. Repeat once in this launch and once after a restart.",
    [
      ["Record 2 s", () => T.t11Mic()],
      ["A prompt appeared", () => T.t11MarkPrompt("yes")],
      ["No prompt", () => T.t11MarkPrompt("no")],
    ],
  );
  const c15 = card(
    "15. Downloads",
    "Press a download button, look for a saved file (Mac: Downloads folder; iPhone: a share/save sheet or the Files app), then mark what happened. If the app navigates away, quit and reopen it; results are kept.",
    [
      ["Download via blob URL", () => T.t15Click("blob")],
      ["blob: file saved", () => T.t15Mark("blob", "file saved")],
      ["blob: nothing", () => T.t15Mark("blob", "nothing happened")],
      ["blob: other", () => T.t15Mark("blob", "something else happened")],
      ["Download via data URL", () => T.t15Click("data")],
      ["data: file saved", () => T.t15Mark("data", "file saved")],
      ["data: nothing", () => T.t15Mark("data", "nothing happened")],
      ["data: other", () => T.t15Mark("data", "something else happened")],
    ],
  );
  const c18 = card(
    "18. Deep link",
    `While the app is open, open ${T.EXPECTED_DEEP_LINK} (iPhone: type it into Safari's address bar; Mac: run  open '${T.EXPECTED_DEEP_LINK}'  in Terminal). Then quit the app fully and open the same link again. Both deliveries are recorded automatically.`,
    [],
  );
  const c19 = card("19. External link", "Press Open, then mark where https://example.com/ opened.", [
    ["Open https://example.com/", () => openUrl("https://example.com/").catch((e) => setResult("19", "fail", `openUrl failed: ${errText(e)}`))],
    ["Opened in the system browser", () => T.t19Mark("opened in the system browser")],
    ["Opened inside this app", () => T.t19Mark("opened inside this app")],
    ["Nothing happened", () => T.t19Mark("nothing happened")],
  ]);
  const c20 = card(
    "20. Push permission and APNs token",
    "Press Register and allow notifications. The token stays in memory only. Copy it to the clipboard for send-push.sh; never paste it into chat or a ticket.",
    [
      ["Register for push", () => registerPush(c20)],
      ["Copy full token to clipboard", async () => (c20.log.textContent = pushToken ? await copyText(pushToken) : "register first")],
    ],
    true,
  );
  const seen = document.createElement("input");
  seen.type = "text";
  seen.placeholder = "Type the notification text you saw (optional, no token)";
  const c21 = card(
    "21. Closed-app localized text",
    'Quit the app fully, run send-push.sh on the Mac, then look at the notification. Expected (English): title "Needs your input", body "Travel desk · Lisbon offsite: Which hotel?". In Hebrew the title is "נדרשת תשובה שלך". Reopen the app WITHOUT tapping the notification only if you want to mark this first; otherwise tap it (that is 22) and mark this afterwards.',
    [
      ["English text shown", () => markPushText("English text shown")],
      ["Hebrew text shown", () => markPushText("Hebrew text shown")],
      ["Raw key shown (push.input.body)", () => markPushText("raw key shown")],
      ["Nothing arrived", () => markPushText("nothing arrived")],
    ],
  );
  c21.el.append(seen);
  const c22 = card(
    "22. Tap from closed",
    "With the app quit, tap the notification from 21. The app records the payload it receives at launch.",
    [],
  );
  root.append(...[c6, c9, c11, c15, c18, c19, c20, c21, c22].map((c) => c.el));

  function markPushText(verdict: string): void {
    const text = seen.value.trim().slice(0, 200);
    state.pushText = { verdict, seen: text };
    const ok = verdict === "English text shown" || verdict === "Hebrew text shown";
    setResult("21", ok ? "pass" : "fail", `person: ${verdict}${text ? `; text seen: "${text}"` : ""}`);
  }
}

async function registerPush(c: Card): Promise<void> {
  const lines: string[] = [];
  try {
    lines.push(`isPermissionGranted before: ${JSON.stringify(await isPermissionGranted())}`);
  } catch (e) {
    lines.push(`isPermissionGranted failed: ${errText(e)}`);
  }
  try {
    lines.push(`requestPermission: ${JSON.stringify(await requestPermission())}`);
  } catch (e) {
    lines.push(`requestPermission failed: ${errText(e)}`);
  }
  try {
    const token = await registerForPushNotifications();
    pushToken = token;
    const hexOk = /^[0-9a-f]{64,}$/i.test(token);
    lines.push(`token received: length ${token.length}, starts ${token.slice(0, 4)}..., hex ${hexOk}`);
    setResult("20", hexOk ? "pass" : "fail", lines.join("\n"));
    c.log.textContent = `Token: ${token.length} chars, starts ${token.slice(0, 4)}. Use "Copy full token".`;
  } catch (e) {
    const t = errText(e);
    lines.push(`registerForPushNotifications failed: ${t}`);
    // The macOS backend refuses outside a bundled, signed app; that is a
    // could-not-measure for this build, not a verdict on push.
    setResult("20", /bundle/i.test(t) ? "n/a" : "fail", lines.join("\n"));
    c.log.textContent = t;
  }
}

function recordTap(data: { id?: number; data?: Record<string, string> | null }): void {
  const ms = status ? Date.now() - status.processStartedMs : Date.now() - pageStartedMs;
  state.pushTaps.push({ id: data.id ?? null, data: data.data ?? null, launch: state.launchCount, msAfterProcessStart: ms, at: new Date().toISOString() });
  const fields = data.data ?? {};
  const right = fields.agentId === "agent-1" && fields.sessionId === "session-1";
  const cold = ms < 15_000;
  const detail = `tap delivered ${Math.round(ms / 1000)} s after process start (launch #${state.launchCount}); id ${data.id ?? "none"}; agentId ${JSON.stringify(fields.agentId ?? null)}; sessionId ${JSON.stringify(fields.sessionId ?? null)}; other keys: ${Object.keys(fields).filter((k) => k !== "agentId" && k !== "sessionId").join(", ") || "none"}`;
  if (!right) return setResult("22", "fail", detail);
  setResult("22", cold ? "pass" : "n/a", cold ? detail : `${detail}\nthe app was already running; quit it fully and tap a fresh notification to measure the closed case`);
}

// --- run all ----------------------------------------------------------------

async function ensureConnected(): Promise<void> {
  const address = $<HTMLInputElement>("address").value.trim();
  if (T.ctx.origin && address.replace(/\/$/, "").toLowerCase() === T.ctx.origin) return;
  const origin = await connect(address);
  T.ctx.origin = origin;
  if (!T.ctx.granted.includes(origin)) T.ctx.granted.push(origin);
  setListenerHost(new URL(origin).hostname);
  $("connect-status").textContent = `Connected: http scope granted for ${origin} only.`;
}

async function runAll(): Promise<void> {
  const button = $<HTMLButtonElement>("run-all");
  button.disabled = true;
  try {
    await ensureConnected();
    T.t10Page();
    T.t17SafeArea();
    const steps: Array<[string, () => Promise<void>]> = [
      ["1", T.t1Upload],
      ["2", T.t2Stream],
      ["3", T.t3NoOrigin],
      ["4", T.t4SocketNoOrigin],
      ["5", T.t5Redirect],
      ["7", T.t7CloseCode],
      ["8", T.t8Scope],
      ["12-14", () => T.tFrames($("frames"))],
    ];
    for (const [id, step] of steps) {
      $("connect-status").textContent = `Running ${id}...`;
      try {
        await step();
      } catch (e) {
        setResult(id.split("-")[0], "fail", `threw: ${errText(e)}`);
      }
    }
    $("connect-status").textContent = `Run all finished. Connected to ${T.ctx.origin}. Now do the interactive tests.`;
  } catch (e) {
    $("connect-status").textContent = `Not connected: ${errText(e)}`;
  } finally {
    button.disabled = false;
  }
}

// --- startup ----------------------------------------------------------------

async function start(): Promise<void> {
  renderResults();
  buildInteractive();
  const loadError = await loadState();
  try {
    status = await shellStatus();
  } catch (e) {
    $("where").textContent = `shell_status failed: ${errText(e)}`;
  }
  const isNewProcess = !!status && status.processStartedMs !== state.lastProcessStartMs;
  if (status && isNewProcess) {
    state.launchCount += 1;
    state.lastProcessStartMs = status.processStartedMs;
    state.launchLog = [...state.launchLog, `launch #${state.launchCount} at ${new Date(status.processStartedMs).toISOString()}`].slice(-10);
  }
  if (status?.stored) {
    T.ctx.origin = status.stored;
    setListenerHost(new URL(status.stored).hostname);
    $<HTMLInputElement>("address").value = status.stored;
    $("connect-status").textContent = `Stored origin ${status.stored} was granted again at launch.`;
  }
  T.ctx.granted = status?.granted ?? [];
  const off = location.origin !== "tauri://localhost" ? ` WARNING: page origin is ${location.origin}, not tauri://localhost; use the --no-dev-server commands from the README.` : "";
  $("where").textContent = `Launch #${state.launchCount} · ${status?.os ?? "?"} · page ${location.origin}${off}${loadError ? ` · ${loadError}` : ""}`;

  T.t10Page();
  T.t16Storage(isNewProcess);
  T.t17SafeArea();
  window.addEventListener("resize", () => T.t17SafeArea());
  renderResults();

  const started = status?.processStartedMs ?? pageStartedMs;
  try {
    const current = await getCurrent();
    if (current?.length && isNewProcess) T.t18Record("getCurrent", current, started);
  } catch (e) {
    setResult("18", "fail", `getCurrent failed: ${errText(e)}`);
  }
  try {
    await onOpenUrl((urls) => T.t18Record("onOpenUrl", urls, started));
  } catch (e) {
    setResult("18", "fail", `onOpenUrl failed: ${errText(e)}`);
  }
  try {
    await onNotificationClicked((data) => recordTap(data as { id?: number; data?: Record<string, string> | null }));
  } catch (e) {
    setResult("22", "n/a", `onNotificationClicked could not be registered: ${errText(e)}`);
  }
  try {
    await onNotificationReceived((n) => {
      const r = state.results["21"];
      const note = `foreground delivery event while open: ${JSON.stringify({ title: (n as { title?: string }).title, body: (n as { body?: string }).body })}`;
      setResult("21", r?.status ?? "n/a", r ? `${r.detail}\n${note}` : `${note}\n(quit the app first: a push that arrives while it is open is not shown)`);
    });
  } catch {
    // Not every backend supports it; 21 is marked by the person anyway.
  }

  if (isNewProcess && state.test9) await T.t9AfterRestart(status?.processStartedMs ?? pageStartedMs);
  await saveState();

  $("connect").addEventListener("click", () =>
    void ensureConnected().catch((e) => ($("connect-status").textContent = `Not connected: ${errText(e)}`)),
  );
  $("run-all").addEventListener("click", () => void runAll());
  $("copy-report").addEventListener("click", async () => {
    $("connect-status").textContent = `Results ${await copyText(buildReport(reportHeader()))}.`;
  });
  $("show-report").addEventListener("click", () => {
    const ta = $<HTMLTextAreaElement>("report-text");
    ta.value = buildReport(reportHeader());
    ta.hidden = false;
    ta.select();
  });
  // WKWebView has no confirm() dialog under Tauri (wry does not implement the
  // panel), so clearing needs a second press instead.
  let armedUntil = 0;
  $("clear-results").addEventListener("click", () => {
    const button = $<HTMLButtonElement>("clear-results");
    if (Date.now() > armedUntil) {
      armedUntil = Date.now() + 5000;
      button.textContent = "Press again within 5 s to clear everything";
      setTimeout(() => (button.textContent = "Clear all results"), 5000);
      return;
    }
    armedUntil = 0;
    button.textContent = "Clear all results";
    state.results = {};
    state.micRuns = [];
    state.deepLinks = [];
    state.pushTaps = [];
    state.downloads = {};
    state.pushText = undefined;
    state.test9 = undefined;
    state.launchCount = 1;
    void saveState();
    renderResults();
  });
}

void start();
