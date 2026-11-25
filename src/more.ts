// Measurements added for "everything the web app does must work":
// microphone default + shell handler (11, 11b), native save (15c), download
// handler (15d), share sheet (15e), uploads (23a-d), playback (24),
// clipboard (25) and wake lock (26).
// Same rules as tests.ts: pass / fail / n/a with what was observed.

import { invoke } from "@tauri-apps/api/core";
import { fetch as nativeFetch } from "@tauri-apps/plugin-http";
import { relaunch } from "@tauri-apps/plugin-process";
import { ctx, hex, requireOrigin, sleep, timeout } from "./tests";
import { errText, setPart, setResult, state, type Status } from "./state";

export const shell = { handlers: false, os: "" };

interface LogEntry {
  kind: "permission" | "download-requested" | "download-finished";
  detail: string;
  url: string | null;
  path: string | null;
  success: boolean | null;
  onDiskBytes: number | null;
  atMs: number;
}

const shellLog = (): Promise<LogEntry[]> => invoke<LogEntry[]>("shell_log");

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", bytes));
}

function needMode(row: string, on: boolean): boolean {
  if (shell.handlers === on) return true;
  setResult(
    row,
    "n/a",
    `this row needs shell handlers ${on ? "ON" : "OFF"} (now ${shell.handlers ? "ON" : "OFF"}); use the "Shell handlers" card to restart in that mode`,
  );
  return false;
}

// --- 11 / 11b: microphone ----------------------------------------------------

const MIC_TYPES = ["audio/mp4", "audio/webm", "audio/webm;codecs=opus"];
const lastRecording: Partial<Record<"11" | "11b", string>> = {};

async function deviceCount(): Promise<string> {
  if (!navigator.mediaDevices?.enumerateDevices) return "enumerateDevices absent";
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === "audioinput").length;
    return `${devices.length} devices (${inputs} audioinput)`;
  } catch (e) {
    return `enumerateDevices failed (${errText(e)})`;
  }
}

export async function micRecord(row: "11" | "11b"): Promise<void> {
  if (!needMode(row, row === "11b")) return;
  const run = state.micRuns.filter((r) => (r.row ?? "11") === row).length + 1;
  const hasMediaDevices = typeof navigator.mediaDevices?.getUserMedia === "function";
  const supported = MIC_TYPES.filter((t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t));
  let permissionBefore = "unsupported";
  try {
    permissionBefore = (await navigator.permissions.query({ name: "microphone" as PermissionName })).state;
  } catch (e) {
    permissionBefore = `query failed (${errText(e)})`;
  }
  const devicesBefore = await deviceCount();
  const logFrom = row === "11b" ? (await shellLog()).length : 0;
  const context = `navigator.mediaDevices ${hasMediaDevices ? "present" : "ABSENT"}; before: ${devicesBefore}; MediaRecorder supports: ${supported.join(", ") || "none of " + MIC_TYPES.join(", ")}`;
  const t0 = performance.now();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const gumMs = Math.round(performance.now() - t0);
    const recorder = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => chunks.push(e.data);
    const stopped = new Promise<void>((r) => (recorder.onstop = () => r()));
    recorder.start();
    await sleep(2000);
    recorder.stop();
    await timeout(stopped, 5000, "MediaRecorder stop");
    for (const track of stream.getTracks()) track.stop();
    const blob = new Blob(chunks, { type: recorder.mimeType });
    if (lastRecording[row]) URL.revokeObjectURL(lastRecording[row]!);
    lastRecording[row] = URL.createObjectURL(blob);
    let handler = "";
    if (row === "11b") {
      const calls = (await shellLog()).slice(logFrom).filter((e) => e.kind === "permission");
      handler = `; shell permission handler called ${calls.length}x${calls.length ? ` (${calls.map((c) => c.detail).join(", ")})` : ""}`;
    }
    state.micRuns.push({
      row,
      run,
      launch: state.launchCount,
      mime: recorder.mimeType,
      bytes: blob.size,
      gumMs,
      permissionBefore,
      context: `${context}; after: ${await deviceCount()}${handler}`,
    });
    writeMic(row);
  } catch (e) {
    setResult(row, "fail", `run ${run}: getUserMedia/MediaRecorder failed after ${Math.round(performance.now() - t0)} ms: ${errText(e)}\n${context}`);
  }
}

export async function micPlay(row: "11" | "11b"): Promise<string> {
  const url = lastRecording[row];
  if (!url) return "record first (recordings are kept in memory for this launch only)";
  try {
    await new Audio(url).play();
    return "playing; now mark whether you heard it";
  } catch (e) {
    return `play() failed: ${errText(e)}`;
  }
}

export function micMark(row: "11" | "11b", key: "prompt" | "heard", value: "yes" | "no"): void {
  const runs = state.micRuns.filter((r) => (r.row ?? "11") === row);
  const last = runs[runs.length - 1];
  if (!last) return;
  last[key] = value;
  writeMic(row);
}

function writeMic(row: "11" | "11b"): void {
  const runs = state.micRuns.filter((r) => (r.row ?? "11") === row);
  const last = runs[runs.length - 1];
  if (!last) return;
  const lines = runs.map(
    (r) =>
      `run ${r.run} (launch #${r.launch}): ${r.mime || "(empty mimeType)"}, ${r.bytes} bytes, getUserMedia ${r.gumMs} ms, permission before ${r.permissionBefore}, prompt ${r.prompt ?? "not marked"}, playback heard ${r.heard ?? "not marked"}${r.context ? `\n    ${r.context}` : ""}`,
  );
  let status: Status = "pass";
  if (last.bytes === 0 || last.heard === "no") status = "fail";
  else if (!last.heard) {
    status = "n/a";
    lines.push('press "Play last recording" and mark whether you heard it');
  }
  setResult(row, status, lines.join("\n"));
}

// --- shell mode ----------------------------------------------------------------

export async function switchHandlers(on: boolean, log: (s: string) => void): Promise<void> {
  await invoke("set_handlers", { on });
  log(`Saved: handlers ${on ? "ON" : "OFF"} from the next launch. Relaunching...`);
  try {
    await relaunch();
  } catch (e) {
    log(`relaunch() failed (${errText(e)}). Quit the app fully and open it again.`);
  }
  setTimeout(() => log("Still running: quit the app fully (iPhone: swipe it away) and open it again."), 3000);
}

// --- 15c: native save ------------------------------------------------------------

interface SaveReport {
  cancelled: boolean;
  pathForm: string;
  path: string;
  bytesWritten: number;
  writtenSha256: string;
  readBackBytes: number | null;
  readBackSha256: string | null;
  readBackError: string | null;
}

function payload(kind: "binary" | "text"): { name: string; bytes: Uint8Array<ArrayBuffer> } {
  if (kind === "text")
    return { name: "alm109-probe-note.txt", bytes: new TextEncoder().encode("ALM-109 probe native save\nline 2: text, punctuation · and Hebrew שלום\n") };
  // 1 MiB, deterministic so the hash is the same on every device.
  const bytes = new Uint8Array(1024 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + (i >> 8)) & 0xff;
  return { name: "alm109-probe-1mib.bin", bytes };
}

export async function nativeSave(row: "15c1" | "15c2"): Promise<void> {
  const { name, bytes } = payload(row === "15c1" ? "binary" : "text");
  const expected = await sha256Hex(bytes);
  try {
    const r = await invoke<SaveReport>("save_native", bytes, { headers: { "file-name": name } });
    if (r.cancelled) {
      setPart(row, "auto", "the save dialog was cancelled");
      setPart(row, "autoOk", "cancelled");
      return writeSave(row);
    }
    const wrote = r.bytesWritten === bytes.length && r.writtenSha256 === expected;
    const readOk = r.readBackBytes === bytes.length && r.readBackSha256 === expected;
    const read = r.readBackError
      ? `read-back of the same path FAILED (${r.readBackError}); size known only from the write: ${r.bytesWritten} bytes`
      : `read-back ${r.readBackBytes} bytes, sha256 ${readOk ? "matches" : "DIFFERS"}`;
    setPart(row, "auto", `${name}: dialog returned a ${r.pathForm}: ${r.path}\nwrote ${r.bytesWritten}/${bytes.length} bytes (${wrote ? "ok" : "MISMATCH"}); ${read}`);
    setPart(row, "autoOk", wrote && (readOk || !!r.readBackError) ? (readOk ? "yes" : "write-only") : "no");
  } catch (e) {
    setPart(row, "auto", `save_native failed: ${errText(e)}`);
    setPart(row, "autoOk", "no");
  }
  writeSave(row);
}

export function saveMark(row: "15c1" | "15c2", there: boolean): void {
  setPart(row, "person", there ? "file is there and has the content" : "file missing, empty or wrong");
  writeSave(row);
}

function writeSave(row: string): void {
  const p = state.parts?.[row] ?? {};
  let status: Status = "n/a";
  if (p.autoOk === "no" || p.person?.startsWith("file missing")) status = "fail";
  else if ((p.autoOk === "yes" || p.autoOk === "write-only") && p.person) status = "pass";
  const ask = p.autoOk === "yes" || p.autoOk === "write-only" ? (p.person ? "" : "\nmark whether the file is really there (Finder / Files app)") : "";
  setResult(row, status, `${p.auto ?? "not run"}${p.person ? `\nperson: ${p.person}` : ""}${ask}`);
}

// --- 15d: download handler ---------------------------------------------------------

const D_ROWS = { blob: "15d1", data: "15d2", attachment: "15d3" } as const;
type DKind = keyof typeof D_ROWS;

export async function handlerDownload(kind: DKind): Promise<void> {
  const row = D_ROWS[kind];
  if (!needMode(row, true)) return;
  const from = (await shellLog()).length;
  const text = `ALM-109 probe ${kind} download through the handler ${new Date().toISOString()}\n`;
  const a = document.createElement("a");
  if (kind === "attachment") {
    a.href = `${requireOrigin()}/attachment?run=${crypto.randomUUID().slice(0, 8)}`;
  } else {
    a.download = `alm109-probe-15d-${kind}.txt`;
    a.href = kind === "blob" ? URL.createObjectURL(new Blob([text], { type: "text/plain" })) : `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`;
  }
  document.body.append(a);
  a.click();
  a.remove();
  const scheme = kind === "blob" ? "blob" : kind === "data" ? "data" : "https";
  let entries: LogEntry[] = [];
  for (let i = 0; i < 16; i++) {
    await sleep(500);
    entries = (await shellLog()).slice(from).filter((e) => e.kind.startsWith("download") && (e.url ?? "").startsWith(scheme));
    if (entries.some((e) => e.kind === "download-finished")) break;
  }
  const requested = entries.find((e) => e.kind === "download-requested");
  const finished = entries.find((e) => e.kind === "download-finished");
  const lines = [
    `handler called: ${requested ? "yes" : "NO"}${requested ? ` (url ${requested.url}; destination set to ${requested.path}; ${requested.detail})` : ""}`,
    `finished: ${finished ? `success ${finished.success}; ${finished.detail}; file on disk at the destination: ${finished.onDiskBytes === null ? "no" : `${finished.onDiskBytes} bytes`}` : "no finished event within 8 s"}`,
  ];
  setPart(row, "auto", lines.join("\n"));
  setPart(row, "autoOk", requested && finished?.success ? "yes" : "no");
  writeDownload(row);
}

export function downloadMark(kind: DKind, there: boolean): void {
  setPart(D_ROWS[kind], "person", there ? "file is there" : "file is NOT there");
  writeDownload(D_ROWS[kind]);
}

function writeDownload(row: string): void {
  const p = state.parts?.[row] ?? {};
  let status: Status = "n/a";
  if (p.autoOk === "no" || p.person === "file is NOT there") status = "fail";
  else if (p.autoOk === "yes" && p.person) status = "pass";
  const ask = p.autoOk === "yes" && !p.person ? "\nmark whether the file is really there (Mac: Downloads; iPhone: Files > On My iPhone > the app)" : "";
  setResult(row, status, `${p.auto ?? "not run"}${p.person ? `\nperson: ${p.person}` : ""}${ask}`);
}

// --- 15e: share sheet --------------------------------------------------------------

export async function shareFile(): Promise<void> {
  const file = new File([`ALM-109 probe shared file ${new Date().toISOString()}\n`], "alm109-probe-share.txt", { type: "text/plain" });
  const canShare = typeof navigator.canShare === "function" ? String(navigator.canShare({ files: [file] })) : "canShare absent";
  let outcome: string;
  if (typeof navigator.share !== "function") outcome = "navigator.share absent";
  else {
    try {
      await navigator.share({ files: [file], title: "ALM-109 probe" });
      outcome = "share() resolved";
    } catch (e) {
      outcome = `share() rejected: ${errText(e)}`;
    }
  }
  setPart("15e", "auto", `canShare({files}) ${canShare}; ${outcome}`);
  setPart("15e", "autoOk", typeof navigator.share === "function" ? "yes" : "no");
  writeShare();
}

export function shareMark(outcome: string): void {
  setPart("15e", "person", outcome);
  writeShare();
}

function writeShare(): void {
  const p = state.parts?.["15e"] ?? {};
  let status: Status = "n/a";
  if (p.autoOk === "no" || (p.person && p.person !== "sheet appeared and Save to Files worked")) status = "fail";
  else if (p.person) status = "pass";
  setResult(
    "15e",
    status,
    `${p.auto ?? "not run"}${p.person ? `\nperson: ${p.person}` : "\nmark what the share sheet did"}\n(native share-sheet plugin: N/A, there is no official Tauri plugin for it; this is the web platform's own path)`,
  );
}

// --- 23: uploads -------------------------------------------------------------------

const UPLOAD_CAP = 30 * 1024 * 1024;

function readWithFileReader(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error("FileReader error"));
    reader.readAsArrayBuffer(file);
  });
}

/** pick -> read twice (arrayBuffer, FileReader) -> native upload -> compare. */
async function endToEnd(file: File): Promise<{ ok: boolean; line: string }> {
  const head = `"${file.name}" (${file.type || "no type"}, ${file.size} bytes)`;
  try {
    const viaBlob = new Uint8Array(await file.arrayBuffer());
    const viaReader = new Uint8Array(await readWithFileReader(file));
    const hash = await sha256Hex(viaBlob);
    const sameRead = viaReader.length === viaBlob.length && (await sha256Hex(viaReader)) === hash;
    if (viaBlob.length !== file.size || !sameRead)
      return { ok: false, line: `${head}: read MISMATCH (arrayBuffer ${viaBlob.length} bytes, FileReader ${viaReader.length} bytes)` };
    if (viaBlob.length > UPLOAD_CAP) return { ok: false, line: `${head}: read ok, but larger than the ${UPLOAD_CAP} byte probe cap; pick a smaller file` };
    const res = await nativeFetch(`${requireOrigin()}/upload`, { method: "POST", body: viaBlob, headers: { "Content-Type": "application/octet-stream" } });
    const answer = (await res.json()) as { bytes?: number; sha256?: string };
    const same = answer.bytes === viaBlob.length && answer.sha256 === hash;
    return { ok: same, line: `${head}: arrayBuffer and FileReader agree; upload HTTP ${res.status}, listener got ${answer.bytes ?? "?"} bytes, sha256 ${same ? "matches" : "DIFFERS"}` };
  } catch (e) {
    return { ok: false, line: `${head}: ${errText(e)}` };
  }
}

export async function uploadPicked(row: "23a" | "23b" | "23c", files: FileList | null): Promise<void> {
  if (!files || files.length === 0) return setResult(row, "n/a", "no file picked");
  if (!ctx.origin) return setResult(row, "fail", "not connected: connect to the listener first, then pick again");
  const picked = Array.from(files).slice(0, 5);
  const results = [];
  for (const f of picked) results.push(await endToEnd(f));
  const ok = results.every((r) => r.ok) && (row !== "23b" || files.length >= 2);
  const note = row === "23b" && files.length < 2 ? "\npick at least two files to measure multiple selection" : "";
  setPart(row, "auto", `${files.length} file(s) picked${files.length > 5 ? " (first 5 measured)" : ""}:\n${results.map((r) => r.line).join("\n")}${note}`);
  setPart(row, "autoOk", ok ? "yes" : "no");
  writeUpload(row);
}

export function pickerOption(option: string): void {
  const p = state.parts?.["23c"] ?? {};
  const set = new Set((p.options ?? "").split(", ").filter(Boolean));
  if (option === "none of these") set.clear();
  set.add(option);
  setPart("23c", "options", [...set].join(", "));
  writeUpload("23c");
}

function writeUpload(row: string): void {
  const p = state.parts?.[row] ?? {};
  const status: Status = p.autoOk === "yes" ? "pass" : p.autoOk === "no" ? "fail" : "n/a";
  const options = row === "23c" ? `\npicker offered (person): ${p.options ?? "not marked"}` : "";
  setResult(row, status, `${p.auto ?? "not picked yet"}${options}`);
}

export async function dropped(event: DragEvent): Promise<void> {
  if (shell.os === "ios") return setResult("23d", "n/a", "drag from Finder is a Mac measurement");
  const files = event.dataTransfer?.files;
  if (!files || files.length === 0) return setResult("23d", "fail", `drop event arrived without files (types: ${event.dataTransfer?.types.join(", ") || "none"})`);
  if (!ctx.origin) return setResult("23d", "fail", "not connected: connect to the listener first, then drop again");
  const r = await endToEnd(files[0]);
  setResult("23d", r.ok ? "pass" : "fail", `drop event with ${files.length} file(s); first: ${r.line}`);
}

export function markDropIosNa(): void {
  if (shell.os === "ios" && !state.results["23d"]) setResult("23d", "n/a", "drag from Finder is a Mac measurement");
}

// --- 24: playback --------------------------------------------------------------------

let audioCtx: AudioContext | null = null;
let toneUrl = "";

export function initPlayback(): void {
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    audioCtx = Ctor ? new Ctor() : null;
    setPart("24", "ctxLoad", audioCtx ? audioCtx.state : "AudioContext absent");
  } catch (e) {
    setPart("24", "ctxLoad", `AudioContext failed: ${errText(e)}`);
  }
  toneUrl = URL.createObjectURL(toneWav());
}

/** 0.8 s, 660 Hz, 16-bit mono WAV with short fades. */
function toneWav(): Blob {
  const rate = 22050;
  const n = Math.round(rate * 0.8);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const fade = Math.min(1, i / 600, (n - i) / 600);
    v.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * 660 * i) / rate) * 0.4 * fade * 32767), true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

export async function playTone(delayed: boolean): Promise<void> {
  if (audioCtx && !state.parts?.["24"]?.ctxTap) {
    const before = audioCtx.state;
    try {
      await audioCtx.resume();
    } catch {
      /* state below says what happened */
    }
    setPart("24", "ctxTap", `${before} -> ${audioCtx.state} after a tap + resume()`);
  }
  const key = delayed ? "playB" : "playA";
  setPart("24", key, delayed ? "waiting 3 s..." : "starting");
  writePlayback();
  if (delayed) await sleep(3000);
  try {
    await new Audio(toneUrl).play();
    setPart("24", key, "play() resolved");
  } catch (e) {
    setPart("24", key, `play() rejected: ${errText(e)}`);
  }
  writePlayback();
}

export function playbackMark(delayed: boolean, heard: boolean): void {
  setPart("24", delayed ? "heardB" : "heardA", heard ? "heard" : "NOT heard");
  writePlayback();
}

function writePlayback(): void {
  const p = state.parts?.["24"] ?? {};
  let status: Status = "n/a";
  if (p.heardA === "NOT heard" || p.heardB === "NOT heard") status = "fail";
  else if (p.heardA === "heard" && p.heardB === "heard") status = "pass";
  setResult(
    "24",
    status,
    [
      `AudioContext at load: ${p.ctxLoad ?? "?"}; ${p.ctxTap ?? "no tap yet"}`,
      `24a right after the tap: ${p.playA ?? "not run"}; person: ${p.heardA ?? "not marked"}`,
      `24b 3 s after the tap, no new gesture: ${p.playB ?? "not run"}; person: ${p.heardB ?? "not marked"}`,
    ].join("\n"),
  );
}

// --- 25: clipboard ---------------------------------------------------------------------

export async function clipText(): Promise<void> {
  const marker = `alm109-clip-${Date.now()}`;
  let line: string;
  try {
    await navigator.clipboard.writeText(marker);
    try {
      const back = await navigator.clipboard.readText();
      line = back === marker ? "writeText + readText round trip ok" : `readText returned something else (${back.length} chars)`;
    } catch (e) {
      line = `writeText ok; readText failed: ${errText(e)}`;
    }
  } catch (e) {
    line = `writeText failed: ${errText(e)}`;
  }
  setPart("25", "text", line);
  writeClipboard();
}

function tinyPng(): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = 8;
  canvas.height = 8;
  const g = canvas.getContext("2d");
  if (g) {
    g.fillStyle = "#2563eb";
    g.fillRect(0, 0, 8, 8);
  }
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob returned null"))), "image/png"));
}

export async function clipPng(): Promise<void> {
  let line: string;
  if (typeof ClipboardItem === "undefined" || typeof navigator.clipboard?.write !== "function") line = "ClipboardItem or clipboard.write absent";
  else {
    try {
      // The promise form keeps the write inside the tap for WebKit.
      await navigator.clipboard.write([new ClipboardItem({ "image/png": tinyPng() })]);
      line = "clipboard.write(PNG ClipboardItem) resolved";
    } catch (e) {
      line = `clipboard.write(PNG) failed: ${errText(e)}`;
    }
  }
  setPart("25", "png", line);
  writeClipboard();
}

export function clipExec(): void {
  const ta = document.createElement("textarea");
  ta.value = `alm109-exec-${Date.now()}`;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.append(ta);
  ta.select();
  let line: string;
  try {
    line = document.execCommand("copy") ? "execCommand('copy') returned true" : "execCommand('copy') returned false";
  } catch (e) {
    line = `execCommand('copy') threw: ${errText(e)}`;
  }
  ta.remove();
  setPart("25", "exec", line);
  writeClipboard();
}

function writeClipboard(): void {
  const p = state.parts?.["25"] ?? {};
  const ok = (v?: string) => !!v && (/round trip ok|resolved|returned true/.test(v));
  let status: Status = "n/a";
  if (p.text && p.png && p.exec) status = ok(p.text) && ok(p.png) && ok(p.exec) ? "pass" : "fail";
  setResult(
    "25",
    status,
    `25a text: ${p.text ?? "not run"}\n25b PNG: ${p.png ?? "not run"}\n25c fallback: ${p.exec ?? "not run"}${p.text && p.png && p.exec ? "" : "\nrun all three buttons"}`,
  );
}

// --- 26: wake lock -----------------------------------------------------------------------

export async function wakeLock(): Promise<void> {
  const nav = navigator as Navigator & { wakeLock?: { request: (type: "screen") => Promise<{ released: boolean; release: () => Promise<void> }> } };
  if (!nav.wakeLock) return setResult("26", "fail", "navigator.wakeLock absent");
  try {
    const sentinel = await nav.wakeLock.request("screen");
    const held = !sentinel.released;
    await sentinel.release();
    setResult("26", held ? "pass" : "fail", `request('screen') resolved; held ${held}; released after the check`);
  } catch (e) {
    setResult("26", "fail", `request('screen') rejected: ${errText(e)}`);
  }
}
