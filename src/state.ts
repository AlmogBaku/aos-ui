// Probe state: results and multi-launch bookkeeping. Persisted by the Rust shell
// in the app config dir (state_load / state_save), so results survive restarts
// even when WebKit storage does not (that is measurement 16).

import { invoke } from "@tauri-apps/api/core";

export type Status = "pass" | "fail" | "n/a";

export interface Result {
  status: Status;
  detail: string;
  at: string;
  launch: number;
}

export interface MicRun {
  /** "11" = Tauri default, "11b" = with the shell's permission handler. Older saved runs have none (= "11"). */
  row?: "11" | "11b";
  run: number;
  launch: number;
  mime: string;
  bytes: number;
  gumMs: number;
  permissionBefore: string;
  prompt?: "yes" | "no";
  heard?: "yes" | "no";
  context?: string;
}

export interface DeepLinkSeen {
  via: "getCurrent" | "onOpenUrl";
  url: string;
  launch: number;
  msAfterProcessStart: number;
  at: string;
}

export interface PushTap {
  id: number | null;
  data: Record<string, string> | null;
  launch: number;
  msAfterProcessStart: number;
  at: string;
}

export interface Test9Pending {
  grantedAt: string;
  grantedInLaunch: number;
  beforeRestart: string;
  relaunchRequestedAtMs?: number;
  relaunchError?: string;
}

export interface ProbeState {
  version: 1;
  launchCount: number;
  lastProcessStartMs: number;
  launchLog: string[];
  results: Record<string, Result>;
  test9?: Test9Pending;
  micRuns: MicRun[];
  deepLinks: DeepLinkSeen[];
  pushTaps: PushTap[];
  downloads: { blob?: string; data?: string };
  pushText?: { verdict: string; seen: string };
  /** Sub-results of the multi-part rows (11b, 15c, 15d, 15e, 23, 24, 25, 26), keyed by row then part. */
  parts?: Record<string, Record<string, string>>;
}

export interface Measurement {
  id: string;
  name: string;
}

export const MEASUREMENTS: Measurement[] = [
  { id: "1", name: "25 MB upload through the native http path" },
  { id: "2", name: "Streamed response arrives incrementally" },
  { id: "3", name: "No Origin header on a request" },
  { id: "4", name: "No Origin header on the socket upgrade" },
  { id: "5", name: "Cross-host redirect not followed" },
  { id: "6", name: "Socket survives 60 s in the background" },
  { id: "7", name: "Close code 4001 reaches the page" },
  { id: "8", name: "Scope: other hosts refused (http and socket)" },
  { id: "9", name: "Runtime grant does not survive a restart" },
  { id: "9r", name: "Process plugin relaunch works on this OS" },
  { id: "10", name: "isSecureContext, crypto.subtle, navigator.clipboard" },
  { id: "11", name: "Microphone: getUserMedia + MediaRecorder 2 s (Tauri default)" },
  { id: "11b", name: "Microphone with the shell permission handler" },
  { id: "12", name: "Framing under frame-ancestors (3 variants)" },
  { id: "13", name: "postMessage both ways with the frame" },
  { id: "14", name: "Bridge isolation inside frames" },
  { id: "15", name: "Downloads: blob URL and data URL (Tauri default, no handler)" },
  { id: "15c1", name: "Native save: 1 MiB binary via save dialog + write in the shell" },
  { id: "15c2", name: "Native save: small text file via save dialog + write in the shell" },
  { id: "15d1", name: "Download handler: blob URL <a download>" },
  { id: "15d2", name: "Download handler: data URL <a download>" },
  { id: "15d3", name: "Download handler: listener file with Content-Disposition: attachment" },
  { id: "15e", name: "Share sheet with a file (Web Share API)" },
  { id: "16", name: "localStorage and document.cookie survive a restart" },
  { id: "17", name: "Safe-area insets (viewport-fit=cover)" },
  { id: "18", name: "Deep link aosprobe:// (running and cold start)" },
  { id: "19", name: "External link opens in the system browser" },
  { id: "20", name: "Push permission + APNs device token" },
  { id: "21", name: "Closed-app localized push text" },
  { id: "22", name: "Tap from closed delivers the payload" },
  { id: "23a", name: "Upload: <input type=file> single pick, read, send, compare" },
  { id: "23b", name: "Upload: <input type=file multiple> pick, read, send, compare" },
  { id: "23c", name: "Upload: accept=image/* picker options and a photo end to end" },
  { id: "23d", name: "Upload: drag a file from Finder onto the page (Mac)" },
  { id: "24", name: "Playback: tone after a tap, and 3 s later without a new tap" },
  { id: "25", name: "Clipboard: text round trip, PNG via ClipboardItem, execCommand copy" },
  { id: "26", name: "Screen wake lock" },
];

export function freshState(): ProbeState {
  return {
    version: 1,
    launchCount: 0,
    lastProcessStartMs: 0,
    launchLog: [],
    results: {},
    micRuns: [],
    deepLinks: [],
    pushTaps: [],
    downloads: {},
  };
}

export const state: ProbeState = freshState();

export async function loadState(): Promise<string | null> {
  try {
    const text = await invoke<string | null>("state_load");
    if (!text) return null;
    const parsed = JSON.parse(text) as Partial<ProbeState>;
    if (parsed.version === 1) Object.assign(state, freshState(), parsed);
    return null;
  } catch (e) {
    return `could not load saved state: ${errText(e)}`;
  }
}

let saveChain: Promise<unknown> = Promise.resolve();
export function saveState(): Promise<unknown> {
  const json = JSON.stringify(state);
  saveChain = saveChain.then(() => invoke("state_save", { json })).catch((e) => {
    console.error("state_save failed", e);
  });
  return saveChain;
}

type Listener = () => void;
const listeners: Listener[] = [];
export function onResultsChanged(fn: Listener): void {
  listeners.push(fn);
}

export function setResult(id: string, status: Status, detail: string): void {
  state.results[id] = {
    status,
    detail: scrub(detail),
    at: new Date().toISOString(),
    launch: state.launchCount,
  };
  void saveState();
  for (const fn of listeners) fn();
}

export function setPart(row: string, key: string, value: string): Record<string, string> {
  state.parts ??= {};
  const parts = (state.parts[row] ??= {});
  parts[key] = value;
  return parts;
}

export function errText(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

// --- report ---------------------------------------------------------------

let listenerHost = "";
export function setListenerHost(host: string): void {
  listenerHost = host;
}

/** Safety net for anything that ends up in the report: hide the listener's
 * tailnet host name and any long hex run (an APNs token is 64+ hex chars). */
export function scrub(text: string): string {
  let out = text;
  if (listenerHost) out = out.split(listenerHost).join("<listener-host>");
  out = out
    .replace(/\/(Users|home)\/[^/\s"]+/g, "/$1/<user>")
    .replace(/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, "<uuid>");
  return out.replace(/\b[0-9a-fA-F]{32,}\b/g, (m) => `<hex ${m.length} chars hidden>`);
}

export function statusLabel(s: Status | undefined): string {
  if (s === "pass") return "PASS";
  if (s === "fail") return "FAIL";
  if (s === "n/a") return "N/A";
  return "not run";
}

export function buildReport(header: string[]): string {
  const lines = ["ALM-109 device probe report", ...header.map(scrub), ""];
  for (const m of MEASUREMENTS) {
    const r = state.results[m.id];
    const when = r ? ` (launch #${r.launch}, ${r.at})` : "";
    lines.push(`#${m.id} [${statusLabel(r?.status)}] ${m.name}${when}`);
    if (r) lines.push(`    ${scrub(r.detail).replace(/\n/g, "\n    ")}`);
  }
  lines.push("", "N/A = could not be measured in this run; the line says why.");
  return lines.join("\n");
}
