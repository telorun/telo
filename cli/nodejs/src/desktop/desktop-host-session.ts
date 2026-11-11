import { HostListeners, type KernelOptions, type UnavailableContext, type UnavailableResponse } from "@telorun/kernel";
import type { Logger } from "@telorun/sdk";
import type { InputPrompter } from "../application-input-prompt.js";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { DesktopAdmission, type AdmissionRequest, type HostAnswer } from "./desktop-admission.js";
import { userAppDirectory } from "./desktop-app-directory.js";
import { assertDesktopAvailable } from "./desktop-availability.js";
import {
  ControlRefusal,
  openControlChannel,
  type ControlChannel,
  type ControlConnection,
  type ControlHandler,
  type ControlRequest,
  type TrayOpenRequest,
  type WindowOpenRequest,
} from "./desktop-control-channel.js";
import { DesktopHelper, DesktopHelperGone, DesktopHelperRequestError } from "./desktop-helper-client.js";
import type { HelperExit } from "./desktop-helper-client.js";
import { detectCheckout, locateHelper } from "./desktop-helper-location.js";
import type { DesktopHostNeed } from "./desktop-host-need.js";
import { DesktopHostOrigin } from "./desktop-host-origin.js";
import { DesktopHostUnavailable } from "./desktop-host-unavailable.js";
import { bindHostOrigin, bindOrigin, type BoundOrigin } from "./desktop-origin.js";
import { SigninReturn } from "./desktop-signin-return.js";
import { DesktopStartupFlow } from "./desktop-startup-flow.js";
import { STARTUP_PATH } from "./desktop-startup-pages.js";
import { acquireInstanceLock, alreadyRunningLine, type HeldInstanceLock } from "./single-instance-lock.js";

/**
 * `telo run` as the desktop host (`kernel/specs/desktop-host.md` §5): the
 * single-instance lock, the app's origin and its admission, the host's own origin
 * serving every page the host shows a window, the helper that owns
 * the native windows and tray icons, and the host end of `desktop_host-1` the
 * application's `Desktop.*` resources talk to. Everything is set up before the
 * kernel is built; {@link DesktopHostSession.kernelOptions} is what the kernel
 * is handed.
 */

const SUPPLIER = "the desktop host";
const UNKNOWN_ENTRY = "ERR_DESKTOP_HOST_UNKNOWN_ENTRY";
const REQUEST_FAILED = "ERR_DESKTOP_HOST_REQUEST_FAILED";
/** The host's own window: the startup view, the inputs form, the boot refusal. */
const STARTUP_WINDOW = "telo.startup";
const STARTUP_SIZE = { width: 520, height: 420 };

export interface DesktopHostOptions {
  need: DesktopHostNeed;
  /** What this start runs — the manifest or the packaged executable — told to a second start. */
  source: string;
  /** The CLI's version, which the helper must report. */
  version: string;
  /** The helper a packaged app carries, used when nothing in the environment names one. */
  packagedHelperPath?: string;
  /** The environment the host reads its own values from. */
  env: NodeJS.ProcessEnv;
  /** The environment the helper is started with. */
  helperEnv: NodeJS.ProcessEnv;
  /** Opens an http(s) URL in the system browser. */
  openExternal: (url: string) => void;
  /** Asked before a connection that is not admitted is refused. */
  unadmittedRequest?: (request: AdmissionRequest) => HostAnswer | undefined;
  /** The `503` body of a connection no server can take. */
  unavailablePage?: (context: UnavailableContext) => UnavailableResponse;
}

export type DesktopHostStart =
  | { kind: "hosting"; host: DesktopHostSession }
  /** Another start holds the lock: its windows are shown, and this start prints `line` and exits 0. */
  | { kind: "running"; line: string };

/** A navigation a window sent to the system browser. */
export interface ExternalNavigation {
  /** The helper's name of the window it left. */
  window: string;
  url: string;
}

interface HeldWindow {
  name: string;
  /** The connection of the resource that opened it; none for a window the host opened. */
  owner?: ControlConnection;
  declaredVisible: boolean;
  visible: boolean;
  /** The host's own window (the startup window): never counted toward what is visible or shown again. */
  host?: boolean;
  order: number;
}

interface HeldTray {
  name: string;
  owner: ControlConnection;
}

export async function startDesktopHost(options: DesktopHostOptions): Promise<DesktopHostStart> {
  await assertDesktopAvailable({ env: options.env });
  const { need } = options;
  const appDirectory = userAppDirectory(need.identifier, { env: options.env });
  if (!appDirectory) {
    throw new DesktopHostUnavailable(
      process.platform === "win32"
        ? "LOCALAPPDATA is not set, so there is no per-user directory for the application"
        : "HOME is not set, so there is no per-user directory for the application",
    );
  }
  const session = new DesktopHostSession(options);
  const lock = await acquireInstanceLock({
    identifier: need.identifier,
    appDirectory,
    source: options.source,
    onShowWindows: () => session.showStartWindows(),
    env: options.env,
    onError: (err) => session.reportLockError(err),
  });
  if (!lock.acquired) return { kind: "running", line: alreadyRunningLine(lock, need.productName) };
  try {
    await session.setUp(lock);
  } catch (err) {
    await session.close();
    throw err;
  }
  return { kind: "hosting", host: session };
}

export class DesktopHostSession implements ControlHandler {
  private lock?: HeldInstanceLock;
  private origin?: BoundOrigin;
  private hostOrigin?: BoundOrigin;
  private hostPages?: DesktopHostOrigin;
  private helper?: DesktopHelper;
  private channel?: ControlChannel;
  private admission?: DesktopAdmission;
  private signin?: SigninReturn;
  private listeners?: HostListeners;
  private readonly secret = randomBytes(32).toString("base64url");
  private readonly windows = new Map<string, HeldWindow>();
  private readonly trays = new Map<string, HeldTray>();
  private nextOrder = 0;
  private hostWindows = 0;
  /** Some window or tray icon has been open: from then on, none left open is a reason to stop. */
  private everShown = false;
  private quitAsked = false;
  private closing?: Promise<void>;
  private stopping = false;
  private stopListener?: () => void;
  private logger?: Logger;
  private readonly pendingLog: Array<(logger: Logger) => void> = [];
  private readonly flow: DesktopStartupFlow;
  private interrupted = false;
  private refusalWaiters: Array<() => void> = [];
  private readonly navigationListeners: Array<(navigation: ExternalNavigation) => void> = [];
  /** The host's own exit status: 1 when the helper ended unasked. */
  exitCode = 0;

  constructor(private readonly options: DesktopHostOptions) {
    this.flow = new DesktopStartupFlow(options.need.productName);
  }

  /** The prompter the load asks its missing inputs through: a form in the startup window. */
  inputPrompter(): InputPrompter {
    return this.flow.prompter();
  }

  /** Startup ended: the startup window closes if the application's own windows have not already replaced it. */
  startupCompleted(): void {
    this.flow.complete();
    void this.closeStartupWindow();
  }

  /** SIGINT / SIGTERM: a form that waits is declined, and a refusal is not waited for. */
  interrupt(): void {
    this.interrupted = true;
    this.flow.declineAsk();
    this.releaseRefusalWaiters();
  }

  /**
   * Startup failed: the window shows the diagnostics and this resolves when the
   * user closes it, the helper ends or the host is asked to stop — at once when
   * there is no window to read them in.
   */
  showRefusal(diagnostics: string): Promise<void> {
    if (this.stopping || this.interrupted || this.flow.ended || !this.windows.has(STARTUP_WINDOW)) return Promise.resolve();
    this.flow.fail(diagnostics);
    return new Promise((resolve) => this.refusalWaiters.push(resolve));
  }

  /** What the kernel is constructed with: the origin socket, the port and the need supplied by name, and the secrets to redact. */
  kernelOptions(): Pick<KernelOptions, "listeners" | "inputs" | "redactedValues"> {
    const { need } = this.options;
    return {
      listeners: this.listeners!,
      redactedValues: [this.channel!.token, this.secret],
      inputs: {
        ports: { [need.portKey]: this.origin!.port },
        needs: { [need.name]: { endpoint: this.channel!.endpoint, token: this.channel!.token } },
        suppliedBy: SUPPLIER,
      },
    };
  }

  /** The window's origin, `http://127.0.0.1:<port>`. */
  get originUrl(): string {
    return this.origin!.origin;
  }

  /** Where the host's records go once a kernel exists; what came before is replayed. */
  reportLockError(err: Error): void {
    this.log((logger) => logger.error(`Desktop host: the single-instance socket failed: ${err.message}`));
  }

  attachLogger(logger: Logger): void {
    this.logger = logger;
    for (const write of this.pendingLog.splice(0)) write(logger);
  }

  /** Called once for the host's graceful stop (`Host.Quit`, an OS quit, the last window gone). */
  onStop(listener: () => void): void {
    this.stopListener = listener;
    if (this.stopping) listener();
  }

  /** Each navigation a window sends to the system browser; the external sign-in return is armed from here. */
  onExternalNavigation(listener: (navigation: ExternalNavigation) => void): void {
    this.navigationListeners.push(listener);
  }

  async setUp(lock: HeldInstanceLock): Promise<void> {
    this.lock = lock;
    const { need } = this.options;
    this.origin = await bindOrigin(lock, {
      ...(need.declaredPort !== undefined ? { declaredPort: need.declaredPort } : {}),
      warn: (warning) => this.log((logger) => logger.warn(warning.message, undefined, { eventName: warning.code })),
    });
    this.hostOrigin = await bindHostOrigin();
    this.signin = new SigninReturn({
      origin: this.origin.origin,
      hostOrigin: this.hostOrigin.origin,
      callbackPaths: need.callbackPaths,
      productName: need.productName,
      focus: (window) => this.helper!.focusWindow(window),
      navigate: (window, url) => this.helper!.navigateWindow(window, url),
      report: (event) =>
        this.log((logger) =>
          event === "used"
            ? logger.info("Desktop host: an external sign-in returned and is replayed in its window", undefined, {
                eventName: "desktop.signin.return_used",
              })
            : logger.error(`Desktop host: the sign-in return could not be replayed in its window: ${event.failed.message}`),
        ),
    });
    this.listeners = new HostListeners({
      ports: [{ port: this.origin.port, address: "127.0.0.1" }],
      unavailable: (context) => (this.options.unavailablePage ?? ((c) => this.flow.unavailable(c)))(context),
    });
    this.admission = new DesktopAdmission(this.origin.server, {
      port: this.origin.port,
      origin: this.origin.origin,
      hostOrigin: this.hostOrigin.origin,
      listeners: this.listeners,
      secret: this.secret,
      unadmittedRequest: (request) => this.signin!.unadmitted(request) ?? this.options.unadmittedRequest?.(request),
    });
    this.hostPages = new DesktopHostOrigin(this.hostOrigin.server, {
      port: this.hostOrigin.port,
      origin: this.hostOrigin.origin,
      secret: this.secret,
      page: (request) => this.flow.page(request) ?? this.signin!.page(request),
    });

    const webviewDirectory = path.join(lock.directory, "webview");
    fs.mkdirSync(webviewDirectory, { recursive: true, mode: 0o700 });
    const command = await locateHelper({
      env: this.options.env,
      packagedHelperPath: this.options.packagedHelperPath,
      checkout: detectCheckout(),
      version: this.options.version,
      report: (message) => this.log((logger) => logger.info(message)),
    });
    const helper = new DesktopHelper({
      command,
      version: this.options.version,
      env: this.options.helperEnv,
      init: {
        identifier: need.identifier,
        productName: need.productName,
        origin: this.origin.origin,
        hostOrigin: this.hostOrigin.origin,
        webviewDirectory,
        showInDock: need.showInDock,
        ...(need.icon ? { icon: need.icon } : {}),
      },
      log: (line) => this.log((logger) => logger.debug(line)),
    });
    this.helper = helper;
    helper.on("windowClosed", ({ window }) => this.windowClosedByUser(window));
    helper.on("windowHidden", ({ window }) => this.windowHiddenByUser(window));
    helper.on("trayItemChosen", ({ tray, item }) => this.trays.get(tray)?.owner.notify("Tray.ItemChosen", { tray, item }));
    helper.on("trayClicked", ({ tray }) => this.trays.get(tray)?.owner.notify("Tray.Clicked", { tray }));
    helper.on("windowOpenRequested", ({ fromWindow, url }) => void this.openRequested(fromWindow, url));
    helper.on("navigationExternal", (navigation) => this.navigateExternally(navigation));
    helper.on("reopened", () => void this.showStartWindows());
    helper.on("quitRequested", () => {
      this.quitAsked = true;
      this.stop();
    });
    helper.on("exited", (exit) => this.helperExited(exit));
    await helper.start();
    this.channel = await openControlChannel(this, { env: this.options.env });
    await this.openStartupWindow();
  }

  /**
   * A second start, or a click on the macOS Dock icon: shows again every window
   * the start showed — those the application opened declared `visible: true`,
   * and those declared `visible: false` when no tray icon is open to reach
   * them — and focuses the first of them opened. A window outside that set (one
   * a tray item showed and the user hid again, while the tray is open) is left
   * as it is.
   */
  async showStartWindows(): Promise<void> {
    const helper = this.helper;
    if (!helper) return;
    const trayStandsIn = this.trays.size > 0;
    const shown = [...this.windows.values()]
      .filter((window) => window.owner && (window.declaredVisible || !trayStandsIn))
      .sort((a, b) => a.order - b.order);
    try {
      for (const window of shown) {
        await helper.showWindow(window.name);
        window.visible = true;
      }
      if (shown.length > 0) await helper.focusWindow(shown[0].name);
    } catch (err) {
      this.log((logger) => logger.error(`Desktop host: the windows could not be shown again: ${(err as Error).message}`));
    }
  }

  async handle(connection: ControlConnection, request: ControlRequest): Promise<unknown> {
    switch (request.type) {
      case "Host.Quit":
        // After the response is written: the module asked for this end.
        setImmediate(() => this.stop());
        return {};
      case "Window.Open":
        await this.openWindow(request.payload, connection);
        return {};
      case "Window.Show": {
        const window = this.windows.get(request.payload.window);
        if (!window?.owner) throw new ControlRefusal(UNKNOWN_ENTRY, `no window '${request.payload.window}' is open`);
        await this.call(() => this.helper!.showWindow(window.name));
        window.visible = true;
        return {};
      }
      case "Window.Close":
        await this.closeWindow(request.payload.window);
        return {};
      case "Tray.Open":
        return this.openTray(request.payload, connection);
      case "Tray.Close": {
        const tray = this.trays.get(request.payload.tray);
        if (tray) {
          this.trays.delete(tray.name);
          await this.call(() => goneWithTheHelper(this.helper!.closeTray(tray.name)));
        }
        return {};
      }
    }
  }

  ended(connection: ControlConnection): void {
    // What a connection held stops holding the application: its windows and tray icons go with it.
    for (const window of [...this.windows.values()]) {
      if (window.owner !== connection) continue;
      void this.closeWindow(window.name).catch((err) =>
        this.log((logger) =>
          logger.error(`Desktop host: closing window '${window.name}' after its connection ended failed: ${(err as Error).message}`),
        ),
      );
    }
    for (const tray of [...this.trays.values()]) {
      if (tray.owner !== connection) continue;
      this.trays.delete(tray.name);
      void this.helper?.closeTray(tray.name).catch((err) =>
        this.log((logger) =>
          logger.error(`Desktop host: closing tray icon '${tray.name}' after its connection ended failed: ${(err as Error).message}`),
        ),
      );
    }
  }

  violated(reason: string): void {
    this.log((logger) =>
      logger.warn(`Desktop host: a control connection sent a frame desktop_host-1 refuses, and was closed: ${reason}`),
    );
  }

  /** The host's graceful stop, the same as SIGTERM's. */
  stop(): void {
    this.releaseRefusalWaiters();
    if (this.stopping) return;
    this.stopping = true;
    this.stopListener?.();
  }

  /** Closes every window and tray icon (the helper quits), the control channel and both origins, and releases the lock. */
  close(): Promise<void> {
    this.releaseRefusalWaiters();
    this.closing ??= (async () => {
      try {
        await this.helper?.quit();
      } catch (err) {
        this.log((logger) => logger.error(`Desktop host: the helper did not quit: ${(err as Error).message}`));
      }
      await this.channel?.close();
      for (const bound of [this.origin, this.hostOrigin]) {
        await new Promise<void>((resolve) => (bound ? bound.server.close(() => resolve()) : resolve()));
      }
      await this.lock?.release();
    })();
    return this.closing;
  }

  /** Removes the lock socket and the control socket at once, for a process that is exiting. */
  removeNow(): void {
    void this.lock?.release();
    this.channel?.removeNow();
  }

  private async openStartupWindow(): Promise<void> {
    await this.openWindow(
      {
        window: STARTUP_WINDOW,
        path: STARTUP_PATH,
        title: this.options.need.productName,
        size: STARTUP_SIZE,
        resizable: true,
        visible: true,
        onClose: "close",
      },
      undefined,
      true,
    );
  }

  /** Closes the startup window, if it is still open; nothing flickers because the application's own window is shown first. */
  private async closeStartupWindow(): Promise<void> {
    if (!this.windows.has(STARTUP_WINDOW)) return;
    try {
      await this.closeWindow(STARTUP_WINDOW);
    } catch (err) {
      this.log((logger) => logger.error(`Desktop host: the startup window could not be closed: ${(err as Error).message}`));
    }
  }

  private async openWindow(request: WindowOpenRequest, owner?: ControlConnection, host = false): Promise<void> {
    if (this.windows.has(request.window)) {
      throw new ControlRefusal(REQUEST_FAILED, `a window named '${request.window}' is already open`);
    }
    // With no tray to reach a hidden window, every window is shown.
    const visible = request.visible || !this.helper!.trayAvailable;
    // A host window's page is on the host origin; every other window's on the app's.
    const destination = `${host ? this.hostOrigin!.origin : this.origin!.origin}${request.path}`;
    const window: HeldWindow = {
      name: request.window,
      ...(owner ? { owner } : {}),
      declaredVisible: request.visible,
      visible,
      ...(host ? { host: true } : {}),
      order: this.nextOrder++,
    };
    this.windows.set(window.name, window);
    try {
      await this.call(() =>
        this.helper!.openWindow({
          window: request.window,
          url: this.hostPages!.admissionUrl(request.window, destination),
          ...(request.title !== undefined ? { title: request.title } : {}),
          ...(request.size ? { size: request.size } : {}),
          ...(request.minSize ? { minSize: request.minSize } : {}),
          resizable: request.resizable,
          visible,
          onClose: request.onClose,
        }),
      );
    } catch (err) {
      this.windows.delete(window.name);
      this.hostPages!.windowClosed(window.name);
      throw err;
    }
    if (host) return;
    if (visible) {
      this.everShown = true;
      // The application's own first visible window replaces the startup window.
      if (owner) await this.closeStartupWindow();
    }
  }

  private async closeWindow(name: string): Promise<void> {
    const window = this.windows.get(name);
    if (!window) return;
    this.windows.delete(name);
    this.hostPages!.windowClosed(name);
    this.signin?.windowClosed(name);
    await this.call(() => goneWithTheHelper(this.helper!.closeWindow(name)));
  }

  private async openTray(request: TrayOpenRequest, owner: ControlConnection): Promise<{ available: boolean }> {
    if (!this.helper!.trayAvailable) return { available: false };
    if (this.trays.has(request.tray)) {
      throw new ControlRefusal(REQUEST_FAILED, `a tray icon named '${request.tray}' is already open`);
    }
    const answer = await this.call(() => this.helper!.openTray(request));
    if (answer.available) {
      this.trays.set(request.tray, { name: request.tray, owner });
      this.everShown = true;
    }
    return answer;
  }

  /**
   * The user closed a window declared `onClose: close`. Once some window or tray
   * icon has been open, the application stops when that leaves no window visible
   * and no tray icon open: nothing is left to reach it by. An application that has
   * opened neither yet keeps running.
   */
  private windowClosedByUser(name: string): void {
    const window = this.windows.get(name);
    if (!window) return;
    this.windows.delete(name);
    this.hostPages!.windowClosed(name);
    this.signin?.windowClosed(name);
    if (window.host) {
      this.startupWindowClosedByUser();
      return;
    }
    window.owner?.notify("Window.Closed", { window: name });
    this.stopWhenNothingIsVisible();
  }

  /** The user closed a window declared `onClose: hide`: it is hidden and still held. */
  private windowHiddenByUser(name: string): void {
    const window = this.windows.get(name);
    if (!window || window.host) return;
    window.visible = false;
    this.stopWhenNothingIsVisible();
  }

  private stopWhenNothingIsVisible(): void {
    if (!this.everShown || this.trays.size > 0) return;
    if ([...this.windows.values()].some((held) => !held.host && held.visible)) return;
    this.log((logger) => logger.info("Desktop host: no window is visible and no tray icon is open; stopping"));
    this.stop();
  }

  /**
   * The user closed the startup window before the application replaced it: an
   * open form is declined, a boot refusal is dismissed, and while the
   * application is still starting the close asks the host to stop.
   */
  private startupWindowClosedByUser(): void {
    const answered = this.flow.failed || this.flow.asking;
    this.flow.declineAsk();
    this.releaseRefusalWaiters();
    if (!answered && !this.flow.ended) this.stop();
  }

  private releaseRefusalWaiters(): void {
    for (const release of this.refusalWaiters.splice(0)) release();
  }

  /** A `window.open` on the app's origin: another host window. */
  private async openRequested(fromWindow: string, url: string): Promise<void> {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      this.log((logger) => logger.warn(`Desktop host: a window asked to open '${url}', which is not a URL`));
      return;
    }
    if (target.origin === this.hostOrigin!.origin) {
      // The helper opens nothing for these; a host page reached any other way than its own URL serves no window.
      this.log((logger) => logger.warn(`Desktop host: window '${fromWindow}' asked to open a page of the host's own; nothing opens`));
      return;
    }
    if (target.origin !== this.origin!.origin) {
      this.navigateExternally({ window: fromWindow, url });
      return;
    }
    const name = `telo.opened.${++this.hostWindows}`;
    try {
      await this.openWindow(
        { window: name, path: target.pathname + target.search, resizable: true, visible: true, onClose: "close" },
        undefined,
      );
    } catch (err) {
      this.log((logger) => logger.error(`Desktop host: a window opened from '${fromWindow}' could not be opened: ${(err as Error).message}`));
    }
  }

  private navigateExternally(navigation: ExternalNavigation): void {
    let scheme: string;
    try {
      scheme = new URL(navigation.url).protocol;
    } catch {
      scheme = "";
    }
    if (scheme !== "http:" && scheme !== "https:") {
      this.log((logger) =>
        logger.warn(
          `Desktop host: a window navigated to '${navigation.url}'; only an http or https address opens in the system browser`,
        ),
      );
      return;
    }
    this.options.openExternal(navigation.url);
    if (this.windows.has(navigation.window)) this.signin?.arm(navigation.window);
    for (const listener of this.navigationListeners) listener(navigation);
  }

  private helperExited(exit: HelperExit): void {
    if (this.quitAsked) {
      this.stop();
      return;
    }
    const why =
      exit.reason === "violation"
        ? `broke its protocol (${exit.message})`
        : exit.signal
          ? `was killed by ${exit.signal}`
          : `exited with code ${exit.code}`;
    this.log((logger) =>
      logger.error(`Desktop host: the desktop helper ${why} without being asked to quit; stopping`, undefined, {
        eventName: "ERR_DESKTOP_HOST_HELPER_EXITED",
      }),
    );
    this.exitCode = 1;
    this.flow.declineAsk();
    this.stop();
  }

  /** A helper request, its refusal answered in the protocol's codes. */
  private async call<T>(request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (err) {
      if (err instanceof DesktopHelperRequestError && err.code === UNKNOWN_ENTRY) throw new ControlRefusal(UNKNOWN_ENTRY, err.message);
      throw new ControlRefusal(REQUEST_FAILED, (err as Error).message);
    }
  }

  private log(write: (logger: Logger) => void): void {
    if (this.logger) write(this.logger);
    else this.pendingLog.push(write);
  }
}

/** A close the helper cannot answer because it has exited is done: what it held went with it. */
async function goneWithTheHelper(close: Promise<void>): Promise<void> {
  try {
    await close;
  } catch (err) {
    if (!(err instanceof DesktopHelperGone)) throw err;
  }
}
