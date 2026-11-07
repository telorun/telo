import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "child_process";
import { outErrLine } from "./output.js";

export interface OpenerCommand {
  command: string;
  args: string[];
}

export interface OpenBrowserOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  /** Called with the reason when the opener cannot be launched or exits non-zero. */
  onFailure?: (reason: string) => void;
}

/**
 * The launcher for a URL, which always travels as ONE argv element and never
 * through a shell, so a consent URL's `&` and `%` arrive intact.
 *
 * `$BROWSER` wins when set and is taken as a single executable (never split on
 * spaces or `:`). In VS Code remote / devcontainers it is a helper that forwards
 * the URL to the user's local browser. Windows uses `rundll32
 * url.dll,FileProtocolHandler`: unlike `cmd /c start` it needs no shell, so the
 * URL is not re-parsed for `&` and `%`.
 */
export function openerFor(
  url: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): OpenerCommand {
  if (env.BROWSER) return { command: env.BROWSER, args: [url] };
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") {
    return { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  }
  return { command: "xdg-open", args: [url] };
}

/** Tells the person which URL to open themselves, on stderr. */
export function reportOpenFailure(url: string, reason: string): void {
  outErrLine(`Could not open a browser (${reason}). Open ${url} yourself.`);
}

/**
 * Launches the user's browser on a URL, detached and without touching the
 * terminal's stdio. A launch failure is reported with the reason and the URL.
 */
export function openBrowser(url: string, options: OpenBrowserOptions = {}): void {
  const { command, args } = openerFor(url, options.platform, options.env);
  const spawn = options.spawn ?? nodeSpawn;
  const fail = options.onFailure ?? ((reason: string) => reportOpenFailure(url, reason));
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", (error) => fail(error.message));
    child.on("exit", (code, signal) => {
      if (code) fail(`${command} exited with code ${code}`);
      else if (signal) fail(`${command} was stopped by ${signal}`);
    });
    child.unref();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Whether auto-opening makes sense here. `$BROWSER` (VSCode remote, devcontainers)
 * forwards to the user's local browser, so opening works even on a headless host —
 * only skip when there's no opener path at all: CI, or a bare headless Linux box
 * with no display and no `$BROWSER`.
 */
export function canOpenBrowser(): boolean {
  if (process.env.CI) return false;
  if (process.env.BROWSER) return true;
  if (
    process.platform === "linux" &&
    !process.env.DISPLAY &&
    !process.env.WAYLAND_DISPLAY
  ) {
    return false;
  }
  return true;
}
