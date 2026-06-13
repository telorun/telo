import { spawn } from "child_process";

/**
 * Best-effort open of a URL in the user's browser. Never throws — a failure to
 * launch is non-fatal (the URL is always logged alongside).
 *
 * `$BROWSER` wins when set: VSCode remote / devcontainers / Codespaces point it
 * at a helper that forwards the URL to the user's *local* browser through the
 * tunnel, so this works even when the host itself is headless. Otherwise fall
 * back to the OS opener.
 */
export function openBrowser(url: string): void {
  const browser = process.env.BROWSER;
  const [cmd, args]: [string, string[]] = browser
    ? [browser, [url]]
    : process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // ignored — the URL is logged regardless
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
