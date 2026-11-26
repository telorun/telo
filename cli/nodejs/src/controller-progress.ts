import type { Kernel } from "@telorun/kernel";
import type { Logger } from "./logger.js";
import { output } from "./output.js";

/**
 * Sources that resolve from already-on-disk artifacts and aren't worth
 * surfacing in the default view — neither a network nor a compile happened,
 * so no `ControllerWorkStarted` was emitted for them either and there is no
 * row to close. A load reporting one of these renders nothing at all.
 * `node_modules` (workspace pnpm — kept visible because it's the path users
 * hit when developing modules and want to see resolved) still prints its
 * terminal line. `--verbose` bypasses this filter and shows every source.
 */
const SILENT_SOURCES = new Set(["cache", "local"]);

/**
 * Subscribe to ControllerLoading / ControllerLoaded / ControllerLoadFailed
 * events and render a minimal progress trail. By default a no-op when stdout
 * is not a TTY (so CI logs and the dockerised `telorun/telo` service stay
 * clean); pass `force: true` to render unconditionally so `--verbose`
 * captured logs include the lines too.
 *
 * The `⬇ <purl>` line is opened by `ControllerWorkStarted` — emitted by the
 * sub-loader that is about to install, compile or fetch — so it appears
 * exactly when a wait begins and for the whole of it. A warm start enters no
 * such branch, emits no such event, and therefore prints nothing at any
 * point: there is no speculative line to take back. `ControllerLoaded`
 * overwrites the row in place via cursor-up + clear-line, so one wait shows as
 * one line that morphs from `⬇` to `✓`; when no work happened it prints a
 * plain `✓` for a source worth recording (`node_modules`, or anything under
 * `--verbose`) and nothing for `cache`/`local`.
 *
 * Concurrent loads each occupy their own line: each pending entry tracks
 * how many lines back from the cursor it lives, and incoming Loadings push
 * existing entries one further up.
 *
 * Stdout-as-TTY also gives us `moveCursor`/`clearLine`. On the `force` path
 * (e.g. piped `--verbose` capture), those methods are absent — we skip the
 * in-progress `⬇` line entirely (we'd never be able to rewrite it later) and
 * emit only the terminal `✓` / `✗` line at `Loaded` / `Failed`. That keeps
 * captured logs orphan-free at the cost of no in-progress feedback in piped
 * output.
 */
export function attachControllerProgress(
  kernel: Kernel,
  log: Logger,
  options: { force?: boolean } = {},
): void {
  const out = output();
  // Never render into a machine surface. Only `run` attaches this today and
  // `run` is exempt from `-o json`, so this guard is currently unreachable —
  // it is here because `--verbose` forces rendering past the TTY check, so a
  // future `install --verbose -o json` would otherwise interleave progress
  // lines into the payload.
  if (out.isJson) return;
  const isTty = Boolean(process.stdout.isTTY);
  if (!options.force && !isTty) {
    attachPlainProgress(kernel, log, out);
    return;
  }

  type Pending = { linesBack: number };
  // Keyed by `<emitter-namespace> <purl>` (see `attemptKey`). Two
  // definitions referencing the same controller PURL must each get their
  // own pending entry; a purl-only key would let a concurrent peer's
  // `Loaded` rewrite the wrong row. The kernel namespaces every event as
  // `<defname>.<eventName>`, so the prefix is enough to disambiguate —
  // one definition can't have two attempts in flight (the loader resolves
  // candidates serially within a single `load()` call, and emits Loading
  // only for the one that resolved).
  const pending = new Map<string, Pending>();

  function attemptKey(eventName: string, purl: string): string {
    const dot = eventName.lastIndexOf(".");
    const ns = dot >= 0 ? eventName.slice(0, dot) : "";
    return `${ns} ${purl}`;
  }

  /** Whether this resolve is worth a line at all. */
  function worthReporting(source: string): boolean {
    return Boolean(options.force) || !SILENT_SOURCES.has(source);
  }

  // The in-place rewrite path needs cursor controls. Without them (piped
  // stdout under `--verbose`), we skip the `⬇` line at Loading altogether and
  // print a single `✓` line at Loaded. Cursor controls are available iff
  // stdout is a real TTY.
  const canRewrite = isTty;

  function workLine(purl: string, work: string): string {
    return `  ${log.dim("⬇")} ${formatPurl(purl)} ${log.dim(`${work}…`)}`;
  }
  function loadedLine(purl: string, source: string, ms: number | undefined): string {
    const meta = ms !== undefined ? `(${source}, ${formatMs(ms)})` : `(${source})`;
    return `  ${log.ok("✓")} ${formatPurl(purl)} ${log.dim(meta)}`;
  }
  function failedLine(purl: string | undefined, error: string): string {
    return `  ${log.error("✗")} ${purl ? formatPurl(purl) : "<unknown>"}: ${error}`;
  }

  /**
   * Bump every pending entry's `linesBack` by one. Called immediately after a
   * println so existing entries — and the just-printed one — reflect their
   * new distance from the (now one-row-lower) cursor.
   */
  function bumpAfterPrint(): void {
    for (const entry of pending.values()) entry.linesBack += 1;
  }

  /**
   * Replace the in-place `⬇ …` line for `purl` with `text`. Requires a real
   * TTY — `moveCursor`/`clearLine` aren't on plain piped streams. When there
   * is no such line (a silent source, or the piped path), return false so the
   * caller prints `text` as a fresh line instead.
   *
   * Cursor accounting: after `write("text\n")` the cursor sits one row below
   * the rewritten line. Coming from `up` rows above the original cursor, we
   * need `up - 1` rows back down to restore. (If `up === 1` the trailing
   * `\n` already lands us back at the original row.)
   */
  function rewritePendingInPlace(key: string, text: string): boolean {
    const entry = pending.get(key);
    if (!entry) return false;
    const rewritten = rewritePending(key, text);
    // The row survives — this is a re-label, not a close-out.
    if (rewritten) pending.set(key, entry);
    return rewritten;
  }

  function rewritePending(key: string, text: string): boolean {
    const entry = pending.get(key);
    if (!entry) return false;
    pending.delete(key);
    const stdout = process.stdout as NodeJS.WriteStream & {
      moveCursor?: (dx: number, dy: number) => void;
      clearLine?: (dir: number) => void;
      cursorTo?: (x: number) => void;
    };
    if (!stdout.moveCursor || !stdout.clearLine || !stdout.cursorTo) {
      return false;
    }
    const up = entry.linesBack;
    stdout.moveCursor(0, -up);
    stdout.cursorTo(0);
    stdout.clearLine(0);
    stdout.write(`${text}\n`);
    if (up > 1) stdout.moveCursor(0, up - 1);
    return true;
  }

  kernel.on("*.ControllerWorkStarted", (event: any) => {
    const purl: string | undefined = event?.payload?.purl;
    if (!purl) return;
    if (!canRewrite) return; // see comment by `canRewrite` declaration
    const key = attemptKey(event.name, purl);
    // One row per attempt: an install followed by a compile is one wait, so a
    // second work event re-labels the row rather than opening another.
    const work: string = event?.payload?.work ?? "working";
    if (rewritePendingInPlace(key, workLine(purl, work))) return;
    pending.set(key, { linesBack: 0 });
    out.line(workLine(purl, work));
    bumpAfterPrint();
  });

  kernel.on("*.ControllerLoaded", (event: any) => {
    const purl: string | undefined = event?.payload?.purl;
    if (!purl) return;
    const key = attemptKey(event.name, purl);
    const source: string = event?.payload?.source ?? "unknown";
    const ms: number | undefined = event?.payload?.durationMs;
    const text = loadedLine(purl, source, ms);
    // A row exists iff work was reported, and work is always worth recording —
    // the source filter only decides whether a load that did *no* work is.
    if (rewritePending(key, text)) return;
    if (worthReporting(source)) out.line(text);
  });

  kernel.on("*.ControllerLoadFailed", (event: any) => {
    const purl: string | undefined = event?.payload?.purl;
    const error: string = event?.payload?.error ?? "unknown error";
    const text = failedLine(purl, error);
    if (!purl || !rewritePending(attemptKey(event.name, purl), text)) out.line(text);
  });
}

/**
 * Piped output has no cursor to rewrite, so each wait is two lines on stderr —
 * the human surface — `⬇ <purl> <work>…` when it begins and `✓ …` when it ends.
 * A load that did no work reports nothing, so a warm start stays silent.
 */
function attachPlainProgress(kernel: Kernel, log: Logger, out: ReturnType<typeof output>): void {
  const palette = log.err;
  const waiting = new Set<string>();
  const keyOf = (event: any, purl: string): string => {
    const name: string = event.name;
    const dot = name.lastIndexOf(".");
    return `${dot >= 0 ? name.slice(0, dot) : ""} ${purl}`;
  };

  kernel.on("*.ControllerWorkStarted", (event: any) => {
    const purl: string | undefined = event?.payload?.purl;
    if (!purl) return;
    const key = keyOf(event, purl);
    if (waiting.has(key)) return;
    waiting.add(key);
    const work: string = event?.payload?.work ?? "working";
    out.errLine(`  ${palette.dim("⬇")} ${formatPurl(purl)} ${palette.dim(`${work}…`)}`);
  });

  kernel.on("*.ControllerLoaded", (event: any) => {
    const purl: string | undefined = event?.payload?.purl;
    if (!purl || !waiting.delete(keyOf(event, purl))) return;
    const source: string = event?.payload?.source ?? "unknown";
    const ms: number | undefined = event?.payload?.durationMs;
    const meta = ms !== undefined ? `(${source}, ${formatMs(ms)})` : `(${source})`;
    out.errLine(`  ${palette.ok("✓")} ${formatPurl(purl)} ${palette.dim(meta)}`);
  });

  kernel.on("*.ControllerLoadFailed", (event: any) => {
    const purl: string | undefined = event?.payload?.purl;
    const error: string = event?.payload?.error ?? "unknown error";
    if (purl) waiting.delete(keyOf(event, purl));
    out.errLine(`  ${palette.error("✗")} ${purl ? formatPurl(purl) : "<unknown>"}: ${error}`);
  });
}

function formatPurl(purl: string): string {
  // Render as `<type>:<name>@<version>[#entry]` (e.g.
  // `npm:@telorun/assert@0.3.0#events`, `cargo:crate-name@1.2.3`). Drops the
  // `pkg:` scheme prefix and the qualifier query string (`?local_path=…`),
  // but keeps the `#entry` fragment — different entries are different
  // controllers loaded via different `import()` calls, so they're not
  // duplicates and need to be visually distinct.
  let s = purl.startsWith("pkg:") ? purl.slice("pkg:".length) : purl;
  const slash = s.indexOf("/");
  if (slash >= 0) s = `${s.slice(0, slash)}:${s.slice(slash + 1)}`;
  const qIdx = s.indexOf("?");
  if (qIdx < 0) return s;
  // Strip the qualifier block but preserve any `#entry` fragment that follows.
  const hashIdx = s.indexOf("#", qIdx);
  return hashIdx >= 0 ? s.slice(0, qIdx) + s.slice(hashIdx) : s.slice(0, qIdx);
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
