// The measurements. Each one records pass / fail / n/a with what was observed.
// "n/a" means could-not-measure, and the detail says why. Nothing is assumed:
// a value that was not observed is reported as not observed.

import { Channel, invoke } from "@tauri-apps/api/core";
import { fetch as nativeFetch } from "@tauri-apps/plugin-http";
import { relaunch } from "@tauri-apps/plugin-process";
import { grantForThisRun, ShellSocket, textEvents } from "./shell";
import { errText, saveState, setResult, state } from "./state";

export const EXAMPLE = "https://example.com";
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const ctx = {
  origin: "" as string,
  granted: [] as string[],
};

export function requireOrigin(): string {
  if (!ctx.origin) throw new Error("not connected: enter the listener address and press Connect");
  return ctx.origin;
}

const wss = (path: string): string => requireOrigin().replace(/^https:/, "wss:") + path;
const extraGrantActive = (): boolean => ctx.granted.includes(EXAMPLE);

export async function timeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}: no answer within ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Header names only (values can carry tailnet identity); origin value shown. */
function headerSummary(headers: Record<string, string>): string {
  const names = Object.keys(headers).sort().join(", ");
  const origin = "origin" in headers ? JSON.stringify(headers.origin) : "absent";
  return `origin: ${origin}; header names: ${names}`;
}

// --- 1 -------------------------------------------------------------------
export async function t1Upload(): Promise<void> {
  const origin = requireOrigin();
  const size = 25 * 1024 * 1024;
  const body = new Uint8Array(size);
  for (let i = 0; i < size; i += 65536) crypto.getRandomValues(body.subarray(i, Math.min(i + 65536, size)));
  const localHash = hex(await crypto.subtle.digest("SHA-256", body));
  const t0 = performance.now();
  try {
    const res = await timeout(
      nativeFetch(`${origin}/upload`, {
        method: "POST",
        body,
        headers: { "Content-Type": "application/octet-stream" },
      }),
      240_000,
      "upload",
    );
    const answer = (await res.json()) as { bytes?: number; sha256?: string };
    const ms = Math.round(performance.now() - t0);
    const same = answer.sha256 === localHash;
    const ok = res.status === 200 && answer.bytes === size && same;
    setResult(
      "1",
      ok ? "pass" : "fail",
      `sent ${size} bytes (25 MiB); HTTP ${res.status}; listener received ${answer.bytes ?? "?"} bytes; sha256 ${same ? "matches" : "DIFFERS"}; ${ms} ms`,
    );
  } catch (e) {
    setResult("1", "fail", `upload failed after ${Math.round(performance.now() - t0)} ms: ${errText(e)}`);
  }
}

// --- 2 -------------------------------------------------------------------
export async function t2Stream(): Promise<void> {
  const origin = requireOrigin();
  const t0 = performance.now();
  try {
    const res = await nativeFetch(`${origin}/stream?chunks=20&interval=200`);
    const tHeaders = performance.now();
    const reader = res.body?.getReader();
    if (!reader) return setResult("2", "fail", `HTTP ${res.status} with no body stream`);
    const arrivals: number[] = [];
    const decoder = new TextDecoder();
    let text = "";
    for (;;) {
      const { done, value } = await timeout(reader.read(), 15_000, "stream read");
      if (done) break;
      arrivals.push(Math.round(performance.now() - tHeaders));
      text += decoder.decode(value, { stream: true });
    }
    const chunks = text.trim().split("\n").filter(Boolean).length;
    const span = arrivals.length ? arrivals[arrivals.length - 1] - arrivals[0] : 0;
    // The listener spreads 20 chunks over 3.8 s. Incremental = many separate
    // reads spread over most of that time; all-at-once = one or two reads.
    const incremental = arrivals.length >= 10 && span >= 1900;
    setResult(
      "2",
      chunks === 20 && incremental ? "pass" : "fail",
      `HTTP ${res.status}; headers after ${Math.round(tHeaders - t0)} ms; ${chunks}/20 chunks in ${arrivals.length} reads spread over ${span} ms (${incremental ? "incremental" : "NOT incremental"}); read times ms after headers: ${arrivals.join(",")}`,
    );
  } catch (e) {
    setResult("2", "fail", `stream failed: ${errText(e)}`);
  }
}

// --- 3 -------------------------------------------------------------------
export async function t3NoOrigin(): Promise<void> {
  const origin = requireOrigin();
  try {
    const blank = (await (await nativeFetch(`${origin}/echo-headers`, { headers: { Origin: "" } })).json()) as {
      headers: Record<string, string>;
    };
    const untouched = (await (await nativeFetch(`${origin}/echo-headers`)).json()) as {
      headers: Record<string, string>;
    };
    const absent = !("origin" in blank.headers);
    setResult(
      "3",
      absent ? "pass" : "fail",
      `with Origin set to "": ${headerSummary(blank.headers)}\nwith Origin untouched: origin ${"origin" in untouched.headers ? JSON.stringify(untouched.headers.origin) : "absent"}`,
    );
  } catch (e) {
    setResult("3", "fail", `request failed: ${errText(e)}`);
  }
}

// --- 4 -------------------------------------------------------------------
export async function t4SocketNoOrigin(): Promise<void> {
  try {
    const socket = await ShellSocket.open(wss("/ws?mode=hello"));
    const hello = await socket.waitFor((e) => e.kind === "text", 8000);
    const msg = JSON.parse((hello as { data: string }).data) as { type: string; headers: Record<string, string> };
    await socket.close(1000, "done").catch(() => undefined);
    setResult("4", "origin" in msg.headers ? "fail" : "pass", `upgrade request as the listener saw it: ${headerSummary(msg.headers)}`);
  } catch (e) {
    setResult("4", "fail", `socket failed: ${errText(e)}`);
  }
}

// --- 5 -------------------------------------------------------------------
export async function t5Redirect(): Promise<void> {
  const origin = requireOrigin();
  if (extraGrantActive())
    return setResult("5", "n/a", "example.com is granted for this run (measurement 9 step 1); restart the app before measuring 5");
  let followed = "";
  let pass = false;
  try {
    const res = await nativeFetch(`${origin}/redirect-external`);
    const body = await res.text();
    const exampleContent = /Example Domain/i.test(body);
    pass = !exampleContent && !res.url.startsWith(EXAMPLE);
    followed = `default fetch resolved: HTTP ${res.status}, final URL ${res.url}, example.com content ${exampleContent ? "PRESENT" : "absent"}`;
  } catch (e) {
    pass = true;
    followed = `default fetch refused: ${errText(e)}`;
  }
  let manual = "";
  try {
    const res = await nativeFetch(`${origin}/redirect-external`, { maxRedirections: 0 });
    manual = `with maxRedirections 0: HTTP ${res.status}, location ${res.headers.get("location") ?? "none"}`;
  } catch (e) {
    manual = `with maxRedirections 0: refused: ${errText(e)}`;
  }
  setResult("5", pass ? "pass" : "fail", `${followed}\n${manual}`);
}

// --- 6 (interactive) -------------------------------------------------------
export const visibilityLog: Array<{ state: string; t: number }> = [];
document.addEventListener("visibilitychange", () => visibilityLog.push({ state: document.visibilityState, t: Date.now() }));

let tickSocket: ShellSocket | null = null;
let tickOpenedAt = 0;

export async function t6Open(onTick: (text: string) => void): Promise<void> {
  try {
    tickSocket = await ShellSocket.open(wss("/ws?mode=tick&interval=5000"));
    tickOpenedAt = Date.now();
    visibilityLog.length = 0;
    tickSocket.onEvent = () => {
      const ticks = textEvents(tickSocket?.events ?? []).filter((m) => m.msg.type === "tick");
      onTick(`socket open; ${ticks.length} ticks received${tickSocket?.closed ? "; socket CLOSED" : ""}`);
    };
    onTick("socket open; waiting for the first tick (every 5 s)");
  } catch (e) {
    setResult("6", "fail", `could not open the tick socket: ${errText(e)}`);
    onTick(`open failed: ${errText(e)}`);
  }
}

export async function t6Check(): Promise<void> {
  const socket = tickSocket;
  if (!socket) return setResult("6", "n/a", "press \"6a. Open tick socket\" first, then background the app for 60 s");
  const now = Date.now();
  const ticks = textEvents(socket.events).filter((m) => m.msg.type === "tick");
  let gap = 0;
  let prev = tickOpenedAt;
  for (const tick of ticks) {
    gap = Math.max(gap, tick.t - prev);
    prev = tick.t;
  }
  gap = Math.max(gap, now - prev);
  let hiddenMs = 0;
  let hiddenAt = 0;
  for (const v of visibilityLog) {
    if (v.state === "hidden") hiddenAt = v.t;
    else if (hiddenAt) {
      hiddenMs += v.t - hiddenAt;
      hiddenAt = 0;
    }
  }
  const ended = socket.events.find((e) => e.kind !== "text");
  let serverSent: number | null = null;
  let alive = false;
  if (!socket.closed) {
    try {
      const from = socket.events.length;
      await socket.send("status");
      const reply = await socket.waitFor((e) => e.kind === "text" && e.data.includes('"status"'), 5000, from);
      serverSent = (JSON.parse((reply as { data: string }).data) as { sent: number }).sent;
      alive = true;
    } catch (e) {
      alive = false;
    }
  }
  const received = textEvents(socket.events).filter((m) => m.msg.type === "tick").length;
  const missed = serverSent === null ? "unknown" : String(serverSent - received);
  const parts = [
    `socket ${alive ? "still open (status round-trip ok)" : "NOT usable"}`,
    `open for ${Math.round((now - tickOpenedAt) / 1000)} s`,
    `ticks received ${received}, listener sent ${serverSent ?? "unknown"}, missed ${missed}`,
    `longest silence ${Math.round(gap / 1000)} s`,
    `page hidden for ${Math.round(hiddenMs / 1000)} s in total (visibilitychange)`,
  ];
  if (ended) parts.push(`socket event: ${JSON.stringify(ended)}`);
  if (hiddenMs < 50_000)
    return setResult("6", "n/a", `${parts.join("; ")}. The page was not hidden for 50 s or more, so this is not a background test yet.`);
  setResult("6", alive ? "pass" : "fail", parts.join("; "));
}

// --- 7 -------------------------------------------------------------------
export async function t7CloseCode(): Promise<void> {
  try {
    const socket = await ShellSocket.open(wss("/ws?mode=hello"));
    await socket.waitFor((e) => e.kind === "text", 8000);
    await socket.send("close-4001");
    const close = await socket.waitFor((e) => e.kind === "close" || e.kind === "error" || e.kind === "ended", 8000);
    if (close.kind !== "close") return setResult("7", "fail", `socket ended without a close frame: ${JSON.stringify(close)}`);
    const ok = close.code === 4001 && close.reason === "probe-close-4001";
    setResult("7", ok ? "pass" : "fail", `page received close code ${close.code} reason ${JSON.stringify(close.reason)}`);
  } catch (e) {
    setResult("7", "fail", `socket failed: ${errText(e)}`);
  }
}

// --- 8 -------------------------------------------------------------------
export async function t8Scope(): Promise<void> {
  const origin = requireOrigin();
  if (extraGrantActive())
    return setResult("8", "n/a", "example.com is granted for this run (measurement 9 step 1); restart the app before measuring 8");
  const lines: string[] = [];
  let pass = true;
  const expectRefused = async (label: string, attempt: () => Promise<unknown>, refusal: RegExp) => {
    try {
      await attempt();
      pass = false;
      lines.push(`${label}: ALLOWED`);
    } catch (e) {
      const text = errText(e);
      const recognised = refusal.test(text);
      if (!recognised) pass = false;
      lines.push(`${label}: refused (${recognised ? "" : "UNEXPECTED ERROR, "}${text})`);
    }
  };
  await expectRefused("http to https://example.com/", () => nativeFetch(`${EXAMPLE}/`), /not allowed/i);
  const url = new URL(origin);
  const otherPort = url.port === "9" ? "10" : "9";
  await expectRefused(`http to the same host on port ${otherPort}`, () => nativeFetch(`https://${url.hostname}:${otherPort}/`), /not allowed/i);
  await expectRefused(
    "shell socket to wss://example.com/",
    () => invoke("socket_open", { url: "wss://example.com/", onEvent: new Channel() }),
    /not the stored host/i,
  );
  await expectRefused(
    "shell socket to wss://<listener-host>@example.com/",
    () => invoke("socket_open", { url: `wss://${url.host}@example.com/`, onEvent: new Channel() }),
    /credentials|not the stored host/i,
  );
  await expectRefused(
    "websocket plugin's own connect (permission not granted)",
    () => invoke("plugin:websocket|connect", { url: wss("/ws?mode=hello&leak=plugin-connect"), onMessage: new Channel() }),
    /not allowed|denied|permission/i,
  );
  setResult("8", pass ? "pass" : "fail", lines.join("\n"));
}

// --- 9 (two launches) ------------------------------------------------------
export async function t9Grant(log: (s: string) => void): Promise<void> {
  requireOrigin();
  let before: string;
  try {
    await grantForThisRun(EXAMPLE);
    ctx.granted.push(EXAMPLE);
    const res = await nativeFetch(`${EXAMPLE}/`);
    before = `example.com granted for this run only; request before restart: HTTP ${res.status}`;
  } catch (e) {
    before = `granting/requesting example.com before restart failed: ${errText(e)}`;
  }
  state.test9 = { grantedAt: new Date().toISOString(), grantedInLaunch: state.launchCount, beforeRestart: before };
  state.test9.relaunchRequestedAtMs = Date.now();
  await saveState();
  log(`${before}. Asking the process plugin to relaunch...`);
  try {
    await relaunch();
    log("relaunch() returned without restarting.");
    state.test9.relaunchError = "relaunch() returned and the process kept running";
  } catch (e) {
    state.test9.relaunchError = `relaunch() threw: ${errText(e)}`;
    log(state.test9.relaunchError);
  }
  await saveState();
  setTimeout(
    () => log("Still running. Quit the app fully (iPhone: swipe it away in the app switcher; Mac: Cmd+Q) and open it again; the check runs on the next launch."),
    3000,
  );
}

/** Runs on the first launch after t9Grant (a new process). */
export async function t9AfterRestart(processStartedMs: number): Promise<void> {
  const pending = state.test9;
  if (!pending) return;
  state.test9 = undefined;
  const requested = pending.relaunchRequestedAtMs ?? 0;
  const gapS = requested ? Math.round((processStartedMs - requested) / 1000) : null;
  const relaunchNote = pending.relaunchError ? ` ${pending.relaunchError}.` : "";
  setResult(
    "9r",
    "n/a",
    `new process started ${gapS ?? "?"} s after relaunch() was requested.${relaunchNote} Mark below whether the app reopened by itself.`,
  );
  const lines = [pending.beforeRestart, `after restart (launch #${state.launchCount}, ${gapS ?? "?"} s later):`];
  let pass = true;
  try {
    await nativeFetch(`${EXAMPLE}/`);
    pass = false;
    lines.push("  example.com: ALLOWED (the grant survived the restart)");
  } catch (e) {
    const t = errText(e);
    if (!/not allowed/i.test(t)) pass = false;
    lines.push(`  example.com: refused (${t})`);
  }
  if (ctx.origin) {
    try {
      const res = await nativeFetch(`${ctx.origin}/echo-headers`);
      lines.push(`  stored origin: HTTP ${res.status} (re-granted from storage at launch)`);
      if (res.status !== 200) pass = false;
    } catch (e) {
      pass = false;
      lines.push(`  stored origin: FAILED (${errText(e)})`);
    }
  } else {
    pass = false;
    lines.push("  stored origin: none stored at launch");
  }
  setResult("9", pass ? "pass" : "fail", lines.join("\n"));
}

export function t9MarkRelaunch(byItself: boolean): void {
  const prev = state.results["9r"]?.detail ?? "";
  const base = prev.replace(/ Mark below.*$/, "").replace(/ Person: .*$/, "");
  setResult("9r", byItself ? "pass" : "fail", `${base} Person: the app ${byItself ? "reopened by itself" : "did NOT reopen by itself"}.`);
}

// --- 10 ------------------------------------------------------------------
export function t10Page(): void {
  const secure = window.isSecureContext;
  const subtle = typeof crypto !== "undefined" && typeof crypto.subtle?.digest === "function";
  const clipboard = typeof navigator.clipboard?.writeText === "function";
  setResult(
    "10",
    secure && subtle && clipboard ? "pass" : "fail",
    `isSecureContext ${secure}; crypto.subtle ${subtle}; navigator.clipboard ${clipboard}; location.origin ${JSON.stringify(location.origin)}; href ${location.href}`,
  );
}

// --- 11 / 11b are in more.ts ----------------------------------------------

// --- 12, 13, 14 ------------------------------------------------------------
interface FrameMessage {
  probe: "alm109";
  type: "loaded" | "pong" | "bridge";
  variant: string;
  where?: "outer" | "inner";
  seenOrigin?: string;
  via?: string;
  nonce?: string;
  has?: Record<string, boolean>;
  attempts?: Record<string, string>;
}

const VARIANTS = ["tauri-localhost", "tauri-scheme", "nothing"] as const;

export async function tFrames(container: HTMLElement): Promise<void> {
  const origin = requireOrigin();
  const run = crypto.randomUUID().slice(0, 8);
  container.replaceChildren();
  const frames = new Map<string, HTMLIFrameElement>();
  const messages: Array<{ data: FrameMessage; origin: string; variant: string }> = [];
  const onMessage = (ev: MessageEvent) => {
    const data = ev.data as FrameMessage;
    if (!data || data.probe !== "alm109") return;
    messages.push({ data, origin: ev.origin, variant: data.variant });
  };
  window.addEventListener("message", onMessage);
  try {
    for (const variant of VARIANTS) {
      const label = document.createElement("div");
      label.className = "muted";
      label.textContent = `frame-ancestors variant: ${variant}${variant === "nothing" ? " (negative control, must stay blank)" : ""}`;
      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
      frame.src = `${origin}/sandbox.html?fa=${variant}&run=${run}`;
      container.append(label, frame);
      frames.set(variant, frame);
    }
    await sleep(6000);
    const loaded = new Set(messages.filter((m) => m.data.type === "loaded").map((m) => m.variant));

    // 13: postMessage both ways with the first rendered positive variant.
    const target = VARIANTS.slice(0, 2).find((v) => loaded.has(v));
    const nonce = crypto.randomUUID().slice(0, 8);
    if (target) frames.get(target)?.contentWindow?.postMessage({ probe: "alm109", type: "ping", nonce }, origin);
    await sleep(5000);

    let hits: { sandbox: Record<string, number>; leaks: string[] } = { sandbox: {}, leaks: [] };
    let hitsError = "";
    try {
      hits = (await (await nativeFetch(`${origin}/hits?run=${run}`)).json()) as typeof hits;
    } catch (e) {
      hitsError = errText(e);
    }

    // 12
    const served = (v: string) => hits.sandbox?.[v] ?? 0;
    const rows = VARIANTS.map((v) => `${v}: ${loaded.has(v) ? "RENDERED" : "blocked/blank"} (listener served it ${served(v)}x)`);
    if (hitsError) rows.push(`could not read listener hits: ${hitsError}`);
    if (served("nothing") === 0 && !hitsError) {
      setResult("12", "n/a", `${rows.join("\n")}\nthe negative control was never requested, so "blocked" is not proven`);
    } else {
      const ok = !loaded.has("nothing") && (loaded.has("tauri-localhost") || loaded.has("tauri-scheme"));
      setResult("12", ok ? "pass" : "fail", rows.join("\n"));
    }

    // 13
    if (!target) {
      setResult("13", "n/a", "no positive frame variant rendered, so there is no frame to talk to");
    } else {
      const pongs = messages.filter((m) => m.data.type === "pong" && m.data.nonce === nonce);
      const star = pongs.find((m) => m.data.via === "*");
      const exact = pongs.find((m) => m.data.via === "exact");
      const seen = star?.data.seenOrigin ?? exact?.data.seenOrigin;
      const concrete = !!seen && seen !== "null";
      const ok = !!star && !!exact && concrete && star.origin === origin;
      setResult(
        "13",
        ok ? "pass" : "fail",
        [
          `frame (${target}) received the page's message: ${seen !== undefined ? "yes" : "NO"}; event.origin seen by the frame: ${JSON.stringify(seen ?? null)}`,
          `page received reply sent with targetOrigin "*": ${star ? "yes" : "NO"}; event.origin seen by the page: ${JSON.stringify(star?.origin ?? null)}`,
          `page received reply sent with targetOrigin = the origin the frame saw: ${exact ? "yes" : "NO"}`,
        ].join("\n"),
      );
    }

    // 14
    const bridges = messages.filter((m) => m.data.type === "bridge");
    if (!bridges.length) {
      setResult("14", "n/a", "no frame reported (no positive variant rendered or scripts did not run)");
    } else {
      let clean = true;
      const lines = bridges.map((b) => {
        const has = b.data.has ?? {};
        const exposed = ["internals", "tauri", "ipc"].filter((k) => has[k]);
        const succeeded = Object.entries(b.data.attempts ?? {}).filter(([, v]) => /^SUCCEEDED/.test(v));
        if (exposed.length || succeeded.length) clean = false;
        return `${b.data.where} frame (${b.variant}): __TAURI_INTERNALS__ ${has.internals ? "PRESENT" : "absent"}, __TAURI__ ${has.tauri ? "PRESENT" : "absent"}, window.ipc ${has.ipc ? "PRESENT" : "absent"}, webkit.messageHandlers.ipc ${has.webkitIpc ? "present" : "absent"}; attempts: ${Object.entries(b.data.attempts ?? {})
          .map(([k, v]) => `${k} -> ${v}`)
          .join("; ")}`;
      });
      const wheres = new Set(bridges.map((b) => b.data.where));
      if (!wheres.has("inner") || !wheres.has("outer")) {
        clean = false;
        lines.push(`missing report from the ${wheres.has("outer") ? "inner srcdoc" : "outer"} frame`);
      }
      if (hits.leaks?.length) {
        clean = false;
        lines.push(`LISTENER SAW LEAKED REQUESTS: ${hits.leaks.join(", ")}`);
      } else if (!hitsError) {
        lines.push("listener saw no request or socket from any frame attempt");
      } else {
        clean = false;
        lines.push(`could not read listener leak log: ${hitsError}`);
      }
      setResult("14", clean ? "pass" : "fail", lines.join("\n"));
    }
  } finally {
    window.removeEventListener("message", onMessage);
  }
}

// --- 15 (interactive) ------------------------------------------------------
export function t15Click(kind: "blob" | "data"): void {
  const text = `ALM-109 probe ${kind} download ${new Date().toISOString()}\n`;
  const a = document.createElement("a");
  a.download = `alm109-probe-${kind}.txt`;
  a.href = kind === "blob" ? URL.createObjectURL(new Blob([text], { type: "text/plain" })) : `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`;
  document.body.append(a);
  a.click();
  a.remove();
}

export function t15Mark(kind: "blob" | "data", outcome: string): void {
  state.downloads[kind] = outcome;
  const { blob, data } = state.downloads;
  const status = !blob || !data ? "n/a" : blob === "file saved" && data === "file saved" ? "pass" : "fail";
  setResult("15", status, `blob URL <a download>: ${blob ?? "not marked"}; data URL <a download>: ${data ?? "not marked"}`);
}

// --- 16 (at launch) --------------------------------------------------------
export function t16Storage(isNewProcess: boolean): void {
  const key = "alm109-marker";
  const readCookie = () =>
    document.cookie
      .split("; ")
      .find((c) => c.startsWith(`${key}=`))
      ?.slice(key.length + 1);
  let previousLs: string | null = null;
  let lsError = "";
  try {
    previousLs = localStorage.getItem(key);
  } catch (e) {
    lsError = errText(e);
  }
  const previousCookie = readCookie();
  const marker = `launch-${state.launchCount}@${new Date().toISOString()}`;
  try {
    localStorage.setItem(key, marker);
  } catch (e) {
    lsError ||= errText(e);
  }
  document.cookie = `${key}=${encodeURIComponent(marker)}; max-age=31536000; path=/; SameSite=Lax`;
  const cookieNow = readCookie();
  const cookieWritable = cookieNow !== undefined && decodeURIComponent(cookieNow) === marker;
  const detail = [
    `previous localStorage marker: ${previousLs ?? "none"}${lsError ? ` (error ${lsError})` : ""}`,
    `previous cookie marker: ${previousCookie ? decodeURIComponent(previousCookie) : "none"}`,
    `cookie writable now: ${cookieWritable}; wrote marker launch-${state.launchCount}`,
  ].join("\n");
  if (!isNewProcess) return; // a page reload is not a restart; keep the last real verdict
  if (state.launchCount <= 1)
    return setResult("16", "n/a", `${detail}\nfirst launch: markers written; quit and reopen the app, then look again`);
  setResult("16", previousLs && previousCookie ? "pass" : "fail", detail);
}

// --- 17 (at launch, on resize) ---------------------------------------------
export function t17SafeArea(): void {
  const probe = document.getElementById("safe-area-probe");
  if (!probe) return;
  const supported = CSS.supports("padding-top: env(safe-area-inset-top)");
  const cs = getComputedStyle(probe);
  const values = `top ${cs.paddingTop}, right ${cs.paddingRight}, bottom ${cs.paddingBottom}, left ${cs.paddingLeft}`;
  setResult(
    "17",
    supported ? "pass" : "fail",
    `env(safe-area-inset-*) supported: ${supported}; ${values}; viewport ${window.innerWidth}x${window.innerHeight}, ${screen.orientation?.type ?? "orientation unknown"}`,
  );
}

// --- 18 (event-driven) -----------------------------------------------------
export const EXPECTED_DEEP_LINK = "aosprobe://agent-1/session-1";

export function t18Record(via: "getCurrent" | "onOpenUrl", urls: string[], processStartedMs: number): void {
  for (const url of urls) {
    state.deepLinks.push({ via, url, launch: state.launchCount, msAfterProcessStart: Date.now() - processStartedMs, at: new Date().toISOString() });
  }
  const norm = (u: string) => u.replace(/\/$/, "");
  const matches = state.deepLinks.filter((d) => norm(d.url) === EXPECTED_DEEP_LINK);
  // Cold start = delivered to the process the link launched (getCurrent at
  // launch, or the event within 5 s of the process starting).
  const cold = matches.find((d) => d.via === "getCurrent" || d.msAfterProcessStart < 5000);
  const running = matches.find((d) => d.via === "onOpenUrl" && d.msAfterProcessStart >= 5000);
  const lines = state.deepLinks
    .slice(-6)
    .map((d) => `launch #${d.launch} via ${d.via} ${Math.round(d.msAfterProcessStart / 1000)} s after process start: ${d.url}`);
  const status = cold && running ? "pass" : "n/a";
  const missing = [!running && "while running", !cold && "from cold start"].filter(Boolean).join(" and ");
  setResult("18", status, `${lines.join("\n")}${missing ? `\nnot yet received ${missing}` : ""}`);
}

// --- 19 (interactive) ------------------------------------------------------
export function t19Mark(outcome: string): void {
  setResult("19", outcome === "opened in the system browser" ? "pass" : "fail", `person: ${outcome}`);
}

// --- 20-22 are in main.ts (they need the push token kept in memory only) ---
