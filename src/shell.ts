// Thin wrappers around the Rust shell commands (src-tauri/src/lib.rs).

import { Channel, invoke } from "@tauri-apps/api/core";

export interface ShellStatus {
  stored: string | null;
  granted: string[];
  os: string;
  arch: string;
  tauriVersion: string;
  appVersion: string;
  identifier: string;
  configDir: string | null;
  processStartedMs: number;
  handlers: boolean;
}

export type SocketEvent =
  | { kind: "text"; data: string }
  | { kind: "binary"; len: number }
  | { kind: "close"; code: number | null; reason: string | null }
  | { kind: "error"; message: string }
  | { kind: "ended" };

export type TimedEvent = SocketEvent & { t: number };

export const shellStatus = (): Promise<ShellStatus> => invoke<ShellStatus>("shell_status");
export const connect = (address: string): Promise<string> => invoke<string>("connect", { address });
export const grantForThisRun = (address: string): Promise<string> =>
  invoke<string>("grant_for_this_run", { address });

export class ShellSocket {
  id = 0;
  readonly events: TimedEvent[] = [];
  private waiters: Array<() => void> = [];
  onEvent?: (e: TimedEvent) => void;

  /** Opens a socket through the shell; `url` must be wss:// on the stored origin. */
  static async open(url: string): Promise<ShellSocket> {
    const socket = new ShellSocket();
    const channel = new Channel<SocketEvent>();
    channel.onmessage = (event) => {
      const timed = { ...event, t: Date.now() } as TimedEvent;
      socket.events.push(timed);
      socket.onEvent?.(timed);
      const waiters = socket.waiters;
      socket.waiters = [];
      for (const w of waiters) w();
    };
    socket.id = await invoke<number>("socket_open", { url, onEvent: channel });
    return socket;
  }

  get closed(): boolean {
    return this.events.some((e) => e.kind === "close" || e.kind === "ended" || e.kind === "error");
  }

  /** Resolves with the first event at or after `from` that matches. */
  waitFor(match: (e: TimedEvent) => boolean, timeoutMs: number, from = 0): Promise<TimedEvent> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no matching socket event within ${timeoutMs} ms`)), timeoutMs);
      const check = (): void => {
        const hit = this.events.slice(from).find(match);
        if (hit) {
          clearTimeout(timer);
          resolve(hit);
        } else {
          this.waiters.push(check);
        }
      };
      check();
    });
  }

  send(text: string): Promise<void> {
    return invoke("socket_send", { id: this.id, text });
  }

  close(code: number, reason: string): Promise<void> {
    return invoke("socket_close", { id: this.id, code, reason });
  }
}

export function textEvents(events: TimedEvent[]): Array<{ msg: Record<string, unknown>; t: number }> {
  const out: Array<{ msg: Record<string, unknown>; t: number }> = [];
  for (const e of events) {
    if (e.kind !== "text") continue;
    try {
      out.push({ msg: JSON.parse(e.data) as Record<string, unknown>, t: e.t });
    } catch {
      out.push({ msg: { raw: e.data }, t: e.t });
    }
  }
  return out;
}
