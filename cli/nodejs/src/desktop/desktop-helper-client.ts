import { encodeFrame, encodeTypedFrame, FrameReader, FrameRefusal } from "@telorun/sdk";
import { spawn, type ChildProcess } from "node:child_process";

import { DesktopHostUnavailable } from "./desktop-host-unavailable.js";
import {
  isNotificationType,
  notificationFault,
  readyFault,
  unavailableFault,
  type HelperInit,
  type HelperNotifications,
  type TrayOpen,
  type WindowOpen,
} from "./desktop-helper-messages.js";

/**
 * The Node end of the link to `telo-desktop-host` (`cli/rust/desktop-host/README.md`).
 *
 * The helper is spawned with all three standard streams piped and no
 * arguments. Its stdin and stdout carry the controller protocol's frame
 * (`@telorun/sdk`'s `encodeFrame` / `FrameReader`), every frame a message frame
 * whose meta is the typed-frame envelope `{ id, payload, type }` — written by
 * the SDK's canonical writer, which already orders members by key and writes
 * whole numbers plainly, and read with `JSON.parse`, since this link carries
 * plain numbers and no `$telo` tags. Requests flow host to helper with odd ids
 * and are answered `{ ok }` / `{ error }`; notifications flow back with even
 * ids and are never answered. Its stderr lines go to the supplied log.
 *
 * `start()` resolves once the helper said `Helper.Ready` (its version equal to
 * the CLI's) and answered `Helper.Init`; every way that can fail is
 * `ERR_DESKTOP_HOST_UNAVAILABLE`. A helper that then ends without a `quit()`
 * — exit, closed stdout, or a protocol violation — is surfaced as ONE `exited`
 * event, which the host treats as a graceful stop.
 */

export type HelperExit =
  | { reason: "ended"; code: number | null; signal: NodeJS.Signals | null }
  | { reason: "violation"; message: string };

export interface HelperEvents extends HelperNotificationEvents {
  exited: HelperExit;
}

type HelperNotificationEvents = {
  quitRequested: HelperNotifications["Helper.QuitRequested"];
  reopened: HelperNotifications["Helper.Reopened"];
  windowClosed: HelperNotifications["Window.Closed"];
  windowHidden: HelperNotifications["Window.Hidden"];
  windowOpenRequested: HelperNotifications["Window.OpenRequested"];
  navigationExternal: HelperNotifications["Navigation.External"];
  trayItemChosen: HelperNotifications["Tray.ItemChosen"];
  trayClicked: HelperNotifications["Tray.Clicked"];
};

const EVENT_OF = {
  "Helper.QuitRequested": "quitRequested",
  "Helper.Reopened": "reopened",
  "Window.Closed": "windowClosed",
  "Window.Hidden": "windowHidden",
  "Window.OpenRequested": "windowOpenRequested",
  "Navigation.External": "navigationExternal",
  "Tray.ItemChosen": "trayItemChosen",
  "Tray.Clicked": "trayClicked",
} as const satisfies Record<keyof HelperNotifications, keyof HelperNotificationEvents>;

/** The helper refused a request: its error code and message. */
export class DesktopHelperRequestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly request: string,
  ) {
    super(`${request} was refused by the desktop helper: [${code}] ${message}`);
    this.name = "DesktopHelperRequestError";
  }
}

/** A request that could not be answered because the helper is gone. */
export class DesktopHelperGone extends Error {
  constructor(request: string, why: string) {
    super(`${request} was not answered: ${why}`);
    this.name = "DesktopHelperGone";
  }
}

export interface DesktopHelperOptions {
  /** The helper binary (`locateHelper`). */
  command: string;
  /** The CLI's own version; a helper reporting another is refused. */
  version: string;
  init: HelperInit;
  /** Receives each line the helper writes to its stderr. */
  log: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  /** How long `quit()` waits for the helper to exit before killing it. */
  quitTimeoutMs?: number;
}

interface Pending {
  type: string;
  resolve: (body: unknown) => void;
  reject: (err: Error) => void;
}

type Listener<K extends keyof HelperEvents> = (event: HelperEvents[K]) => void;

export class DesktopHelper {
  /** Whether `Tray.Open` can show an icon, as `Helper.Ready` said. */
  trayAvailable = false;

  private child: ChildProcess | undefined;
  private readonly reader = new FrameReader();
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<keyof HelperEvents, Array<Listener<never>>>();
  private nextRequestId = 1;
  private lastNotificationId = 0;
  private stderrTail: string[] = [];
  private ready: { resolve: (r: { version: string; tray: boolean }) => void; reject: (e: Error) => void } | undefined;
  private ended = false;
  private quitting = false;
  private exitWaiters: Array<() => void> = [];

  constructor(private readonly options: DesktopHelperOptions) {}

  on<K extends keyof HelperEvents>(event: K, listener: Listener<K>): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener as Listener<never>);
    this.listeners.set(event, list);
  }

  async start(): Promise<void> {
    const readyFrame = new Promise<{ version: string; tray: boolean }>((resolve, reject) => {
      this.ready = { resolve, reject };
    });
    // The rejection is observed below; unobserved while spawning fails first.
    readyFrame.catch(() => undefined);

    const child = spawn(this.options.command, [], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: this.options.env ?? process.env,
    });
    this.child = child;
    child.on("error", (err) => {
      this.ready?.reject(new DesktopHostUnavailable(`the helper could not be started (${err.message})`));
      this.ready = undefined;
      this.finish({ reason: "ended", code: null, signal: null }, `could not be started (${err.message})`);
    });
    child.stdin!.on("error", () => undefined);
    child.stdout!.on("data", (chunk: Buffer) => this.receive(chunk));
    child.stdout!.on("end", () => {
      try {
        this.reader.end();
      } catch (err) {
        this.violate((err as Error).message);
      }
    });
    this.readStderr(child);
    child.on("close", (code, signal) => this.finish({ reason: "ended", code, signal }, this.exitDescription(code, signal)));

    let ready: { version: string; tray: boolean };
    try {
      ready = await readyFrame;
    } catch (err) {
      this.abandon();
      throw err;
    }
    if (ready.version !== this.options.version) {
      this.abandon();
      throw new DesktopHostUnavailable(
        `the helper is version ${ready.version} but this telo is ${this.options.version}; they must be the same release`,
      );
    }
    this.trayAvailable = ready.tray;
    try {
      await this.request("Helper.Init", this.options.init);
    } catch (err) {
      this.abandon();
      throw new DesktopHostUnavailable(`the helper refused to start: ${(err as Error).message}`);
    }
  }

  openWindow(window: WindowOpen): Promise<void> {
    return this.request("Window.Open", window).then(() => undefined);
  }
  showWindow(window: string): Promise<void> {
    return this.request("Window.Show", { window }).then(() => undefined);
  }
  hideWindow(window: string): Promise<void> {
    return this.request("Window.Hide", { window }).then(() => undefined);
  }
  focusWindow(window: string): Promise<void> {
    return this.request("Window.Focus", { window }).then(() => undefined);
  }
  navigateWindow(window: string, url: string): Promise<void> {
    return this.request("Window.Navigate", { window, url }).then(() => undefined);
  }
  closeWindow(window: string): Promise<void> {
    return this.request("Window.Close", { window }).then(() => undefined);
  }
  async openTray(tray: TrayOpen): Promise<{ available: boolean }> {
    const body = await this.request("Tray.Open", tray);
    const available = (body as { available?: unknown } | null)?.available;
    if (typeof available !== "boolean") this.violate("Tray.Open was answered without { available }");
    return { available: available === true };
  }
  closeTray(tray: string): Promise<void> {
    return this.request("Tray.Close", { tray }).then(() => undefined);
  }

  /** Has the helper close everything and exit 0, and waits for it; kills it past the timeout. */
  async quit(): Promise<void> {
    if (this.ended) return;
    this.quitting = true;
    const timer = setTimeout(() => this.kill(), this.options.quitTimeoutMs ?? 5000);
    try {
      try {
        await this.request("Helper.Quit", {});
      } catch (err) {
        if (!(err instanceof DesktopHelperGone)) throw err;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => this.exitWaiters.push(resolve));
    } finally {
      clearTimeout(timer);
    }
  }

  private request(type: string, payload: unknown): Promise<unknown> {
    if (this.ended) return Promise.reject(new DesktopHelperGone(type, "the helper has exited"));
    const id = this.nextRequestId;
    this.nextRequestId += 2;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { type, resolve, reject });
      const frame = encodeFrame("message", encodeTypedFrame({ id, payload, type }));
      this.child!.stdin!.write(frame, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(new DesktopHelperGone(type, err.message));
        }
      });
    });
  }

  private receive(chunk: Buffer): void {
    if (this.ended) return;
    try {
      for (const frame of this.reader.push(chunk)) {
        if (frame.class !== "message") throw new FrameRefusal("the helper sent a data frame");
        this.dispatch(frame.meta);
        if (this.ended) return;
      }
    } catch (err) {
      this.violate((err as Error).message);
    }
  }

  private dispatch(meta: string): void {
    let envelope: unknown;
    try {
      envelope = JSON.parse(meta);
    } catch {
      throw new FrameRefusal("a meta that is not JSON");
    }
    const { id, type, payload } = envelopeOf(envelope);
    if (id % 2 === 1) this.answer(id, type, payload);
    else this.notify(id, type, payload);
  }

  private answer(id: number, type: string, payload: unknown): void {
    const waiting = this.pending.get(id);
    if (!waiting) throw new FrameRefusal(`a response to request ${id}, which is not pending`);
    if (waiting.type !== type) throw new FrameRefusal(`a response of type ${type} to ${waiting.type}`);
    this.pending.delete(id);
    const record = payload as Record<string, unknown> | null;
    if (typeof record === "object" && record !== null && "ok" in record && Object.keys(record).length === 1) {
      waiting.resolve(record.ok);
    } else if (typeof record === "object" && record !== null && "error" in record && Object.keys(record).length === 1) {
      const error = record.error as { code?: unknown; message?: unknown } | null;
      if (typeof error?.code !== "string" || typeof error.message !== "string") {
        throw new FrameRefusal(`an error response to ${type} without a code and a message`);
      }
      waiting.reject(new DesktopHelperRequestError(error.code, error.message, type));
    } else {
      throw new FrameRefusal(`a response to ${type} that is neither { ok } nor { error }`);
    }
  }

  private notify(id: number, type: string, payload: unknown): void {
    if (id <= this.lastNotificationId) throw new FrameRefusal(`a notification id ${id} that does not follow ${this.lastNotificationId}`);
    this.lastNotificationId = id;
    if (type === "Helper.Ready" || type === "Helper.Unavailable") return this.lifecycle(type, payload);
    if (!isNotificationType(type)) throw new FrameRefusal(`a notification of unknown type ${type}`);
    const fault = notificationFault(type, payload);
    if (fault) throw new FrameRefusal(`${type} with ${fault}`);
    if (this.ready) throw new FrameRefusal(`${type} before Helper.Ready`);
    this.emit(EVENT_OF[type], payload as never);
  }

  private lifecycle(type: string, payload: unknown): void {
    if (!this.ready) throw new FrameRefusal(`${type} after the helper's first frame`);
    const ready = this.ready;
    this.ready = undefined;
    if (type === "Helper.Unavailable") {
      const fault = unavailableFault(payload);
      if (fault) throw new FrameRefusal(`Helper.Unavailable with ${fault}`);
      ready.reject(new DesktopHostUnavailable((payload as { reason: string }).reason));
      return;
    }
    const fault = readyFault(payload);
    if (fault) throw new FrameRefusal(`Helper.Ready with ${fault}`);
    ready.resolve(payload as { version: string; tray: boolean });
  }

  private violate(message: string): void {
    if (this.ended) return;
    this.kill();
    this.finish({ reason: "violation", message }, `broke the protocol: ${message}`);
  }

  /** The one place the helper's end is decided: rejects what waits, then tells the host once. */
  private finish(exit: HelperExit, why: string): void {
    if (this.ended) return;
    this.ended = true;
    const detail = this.stderrTail.length > 0 ? ` (${this.stderrTail.join(" | ")})` : "";
    if (this.ready) {
      const early = exit.reason === "ended" ? " before it was ready" : "";
      this.ready.reject(new DesktopHostUnavailable(`the helper ${why}${early}${detail}`));
      this.ready = undefined;
    }
    for (const [, waiting] of this.pending) waiting.reject(new DesktopHelperGone(waiting.type, `the helper ${why}`));
    this.pending.clear();
    for (const wake of this.exitWaiters.splice(0)) wake();
    if (!this.quitting) this.emit("exited", exit);
  }

  private exitDescription(code: number | null, signal: NodeJS.Signals | null): string {
    return signal ? `was killed by ${signal}` : `exited with code ${code}`;
  }

  private emit<K extends keyof HelperEvents>(event: K, payload: HelperEvents[K]): void {
    for (const listener of this.listeners.get(event) ?? []) (listener as Listener<K>)(payload);
  }

  private readStderr(child: ChildProcess): void {
    let partial = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      partial += chunk;
      const lines = partial.split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) this.stderrLine(line);
    });
    child.stderr!.on("end", () => {
      if (partial) this.stderrLine(partial);
    });
  }

  private stderrLine(line: string): void {
    this.stderrTail = [...this.stderrTail, line].slice(-3);
    this.options.log(line);
  }

  /** A start that failed: the helper is killed and its end is no event for the host. */
  private abandon(): void {
    this.quitting = true;
    this.kill();
  }

  private kill(): void {
    this.child?.kill();
  }
}

function envelopeOf(value: unknown): { id: number; type: string; payload: unknown } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new FrameRefusal("a meta that is not an envelope");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(",");
  if (keys !== "id,payload,type") throw new FrameRefusal(`an envelope with members '${keys}', not id, payload and type`);
  if (typeof record.id !== "number" || !Number.isSafeInteger(record.id) || record.id < 0) {
    throw new FrameRefusal("an envelope whose id is not a whole non-negative number");
  }
  if (typeof record.type !== "string") throw new FrameRefusal("an envelope whose type is not text");
  return { id: record.id, type: record.type, payload: record.payload };
}
