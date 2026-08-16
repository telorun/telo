import { decideColor } from "@telorun/kernel";

/** Output encodings the CLI can produce. `yaml` is deliberately absent: the flag
 *  is an enum precisely so it can gain a value later without a second flag. */
export type OutputFormat = "text" | "json";

export const OUTPUT_FORMATS: OutputFormat[] = ["text", "json"];

/** A colour palette bound to ONE stream.
 *
 *  Colour is a property of the descriptor being written to, not of the process:
 *  `telo check 2>/dev/null` leaves stdout a TTY and stderr not, and a single
 *  process-wide decision is wrong for one of them either way. The CLI used to
 *  decide once from `process.stdout.isTTY` while `formatDiagnostics` wrote to
 *  stderr, so redirecting one stream and not the other produced escapes where
 *  they could not be rendered — the leak this splits apart. */
export interface Palette {
  ok(text: string): string;
  warn(text: string): string;
  error(text: string): string;
  dim(text: string): string;
}

const PLAIN: Palette = {
  ok: (t) => t,
  warn: (t) => t,
  error: (t) => t,
  dim: (t) => t,
};

function paletteFor(isTTY: boolean, env: NodeJS.ProcessEnv): Palette {
  // Follows `kernel/specs/logging.md` §11.2 precedence, shared with the `pretty`
  // log encoding rather than reimplemented.
  if (!decideColor({ setting: "auto", env, isTTY })) return PLAIN;
  const wrap = (code: string) => (text: string) => `\x1b[${code}m${text}\x1b[0m`;
  return { ok: wrap("32"), warn: wrap("33"), error: wrap("31"), dim: wrap("2") };
}

/** The minimum of a writable stream this needs. Narrow on purpose: a test hands
 *  in a recording pair, so `Output` never reads process globals. */
export interface OutputStream {
  isTTY?: boolean;
  /** Terminal width, when the stream is one. A transient progress line is
   *  truncated to it: a line that wraps occupies two rows, and the erase
   *  sequence clears only the row the cursor is on, so the overflow would be
   *  left on screen for the next line to be written over. */
  columns?: number;
  write(chunk: string): unknown;
}

export interface OutputOptions {
  format: OutputFormat;
  stdout?: OutputStream;
  stderr?: OutputStream;
  env?: NodeJS.ProcessEnv;
}

/** The single seam every CLI-owned write goes through.
 *
 *  The stream split is the whole contract:
 *
 *  - **stdout is the machine surface.** Under `-o json` it carries the payload
 *    and nothing else, so a consumer parses it whole.
 *  - **stderr is the human surface, in BOTH formats.** Prose keeps flowing under
 *    `-o json` — the convention npm, cargo and kubectl follow — because the
 *    alternative is silence: a command that reports a failure reason through
 *    prose would otherwise have it swallowed, leaving `{"ok":false}` with no
 *    cause. Suppressing stderr was error swallowing, which Telo forbids.
 *
 *  `telo run` is exempt from `-o json` entirely; see `emit`. */
export class Output {
  readonly format: OutputFormat;
  readonly stdout: Palette;
  readonly stderr: Palette;
  private readonly outStream: OutputStream;
  private readonly errStream: OutputStream;

  constructor(options: OutputOptions) {
    const {
      format,
      stdout = process.stdout,
      stderr = process.stderr,
      env = process.env,
    } = options;
    this.format = format;
    this.outStream = stdout;
    this.errStream = stderr;
    // Structured output must never carry escapes: a consumer parses it, and no
    // terminal renders it. Deciding this here rather than at each call site is
    // what makes "JSON is always clean" true by construction. stderr keeps its
    // colour under `-o json` because it stays the human surface.
    this.stdout = format === "text" ? paletteFor(Boolean(stdout.isTTY), env) : PLAIN;
    this.stderr = paletteFor(Boolean(stderr.isTTY), env);
  }

  /** Whether a transient progress line is currently on screen, waiting to be
   *  overwritten. Owned here because the rule it implies — every other write
   *  must erase it first — has to hold for every write method, and a call site
   *  that forgot would leave its output glued to the end of a ticker. */
  private transient = false;

  get isJson(): boolean {
    return this.format === "json";
  }

  /** Erase a pending transient line, so the next write starts on a clean row.
   *  `\r` returns to column 0 and `\x1b[2K` clears the row; both are cursor
   *  control rather than colour, so they are gated on the stream being a TTY and
   *  not on the palette — a `NO_COLOR` terminal still has a cursor. */
  private clearTransient(): void {
    if (!this.transient) return;
    this.transient = false;
    this.errStream.write("\r\x1b[2K");
  }

  /** Drop any pending progress line without writing anything else. For a
   *  command that finishes without a further write and would otherwise leave the
   *  shell prompt sitting after a half-drawn ticker. */
  endProgress(): void {
    this.clearTransient();
  }

  /** Human-readable line on stdout. Suppressed under `-o json`, where stdout is
   *  reserved for the payload. */
  line(text = ""): void {
    if (this.format !== "text") return;
    // Cleared even though this writes to the OTHER stream: both usually land on
    // one terminal, so a stdout line written over a pending stderr ticker would
    // start halfway across the row.
    this.clearTransient();
    this.outStream.write(`${text}\n`);
  }

  /** Human-readable line on stderr. Written in BOTH formats — stderr is not the
   *  machine contract, and silencing it loses the reason a command failed. */
  errLine(text = ""): void {
    this.clearTransient();
    this.errStream.write(`${text}\n`);
  }

  /**
   * A progress tick on stderr, written only in text format and only to a TTY.
   *
   * The distinction this draws is between a **diagnostic** and a **progress
   * indicator**, and it is why the rule is not the one `errLine` follows.
   * `errLine` must write in every format because silencing it would lose the
   * reason a command failed — that is error swallowing. A tick explains nothing.
   * It is an affordance of the human-formatted mode: something for a person
   * watching a long operation, so that a two-minute build does not look hung.
   *
   * BOTH conditions, because either one alone leaves a case wrong. `-o json`
   * says the output is a contract, and decorating that run with prose the caller
   * did not ask for is noise in their terminal whether or not they are looking
   * at it — the format is the caller's statement of intent, not a guess about
   * where the bytes land. And a text run redirected into a file or a CI log has
   * nobody watching either, where sixty ticks bury the output the reader came
   * for.
   */
  progress(text: string): void {
    if (this.format !== "text" || !this.errStream.isTTY) return;
    this.clearTransient();
    // No newline: this line is TRANSIENT. The next tick overwrites it and any
    // real output erases it, so a 59-module run leaves behind only the findings
    // rather than 59 ticks interleaved with them — which is the whole reason a
    // ticker is bearable at this length at all.
    this.errStream.write(truncate(text, this.errStream.columns));
    this.transient = true;
  }

  /** Emit a command's structured RESULT ENVELOPE. A no-op in text mode.
   *
   *  Every command that owns its stdout calls this exactly once, including when
   *  it has nothing interesting to report — a consumer cannot distinguish
   *  "nothing to say" from "this command ignores the flag", so a bare envelope
   *  is the difference between a contract and a guess.
   *
   *  `telo run` is the ONE exemption, and it is a property of the command rather
   *  than an oversight: the kernel runs in-process and the app's own output goes
   *  to these same descriptors (`teeStdio` copies, it does not redirect), so
   *  NEITHER stream is the CLI's to claim. An envelope written after arbitrary
   *  app output is unparseable, which is the exact failure `-o json` exists to
   *  remove. The machine surface for a run already exists and is `--debug`,
   *  whose wire protocol is framed per event precisely because it shares a
   *  stream. */
  emit(payload: unknown): void {
    // Unconditionally, including under `text` where nothing is written: every
    // command reports its result exactly once, so this is the lifecycle point at
    // which a leftover ticker has to go.
    this.clearTransient();
    if (this.format === "json") this.outStream.write(serialize(payload));
  }

  /** Write a bare DOCUMENT to stdout, in either format.
   *
   *  For the commands whose structured form is the document itself rather than a
   *  result report — `cel`, `search`, `module versions|manifest|digest|resources|kinds`.
   *  Unconditional because their per-command `--json` flag predates `-o` and
   *  must keep working under the default `text` format. One serializer with
   *  `emit`, so the CLI has a single JSON encoding rather than three. */
  document(payload: unknown): void {
    this.clearTransient();
    this.outStream.write(serialize(payload));
  }

  /** Write verbatim content to stdout, unconditionally and with no framing.
   *
   *  For the one case that is neither prose nor a JSON payload: `telo module
   *  manifest` printing a module's `telo.yaml` bytes, which ARE the output. It
   *  bypasses format handling because the bytes are the answer in every format
   *  — the `--json` path wraps them in a document instead and never reaches
   *  here. */
  raw(content: string): void {
    this.clearTransient();
    this.outStream.write(content);
  }
}

/** Clip to the terminal width, measuring PRINTABLE characters so the escapes a
 *  palette wrapped the text in do not count toward it. A line that wraps
 *  occupies two rows and the erase sequence clears one. */
function truncate(text: string, columns: number | undefined): string {
  if (!columns || columns < 8) return text;
  let printable = 0;
  for (let i = 0; i < text.length; i++) {
    // Skip a CSI sequence wholesale: `\x1b[` … a final byte in `@`–`~`.
    if (text[i] === "\x1b" && text[i + 1] === "[") {
      i += 2;
      while (i < text.length && !/[@-~]/.test(text[i])) i++;
      continue;
    }
    if (++printable > columns - 1) return `${text.slice(0, i)}…`;
  }
  return text;
}

function serialize(payload: unknown): string {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

/** Configured once from argv by a yargs middleware, before any handler runs, so
 *  call sites far from the handler reach the same decision without threading it
 *  through every signature. Tests construct an `Output` directly instead. */
let current = new Output({ format: "text" });

export function configureOutput(format: OutputFormat): void {
  current = new Output({ format });
}

/** Swap the ambient instance, returning a restore function.
 *
 *  For tests of code that reaches the seam through the accessor rather than
 *  through a parameter — they hand in an `Output` over recording streams instead
 *  of spying on `process.stderr.write`. */
export function installOutput(replacement: Output): () => void {
  const previous = current;
  current = replacement;
  return () => {
    current = previous;
  };
}

export function output(): Output {
  return current;
}

/** yargs has already rejected anything outside `choices` by the time a handler
 *  runs, so an unrecognized value here means the enum grew and this function was
 *  not updated. Throwing is the point: silently degrading `-o yaml` to text is
 *  the worst failure a format flag can have. */
export function parseOutputFormat(value: unknown): OutputFormat {
  if (OUTPUT_FORMATS.includes(value as OutputFormat)) return value as OutputFormat;
  throw new Error(
    `Unsupported --output format '${String(value)}'. Expected one of: ${OUTPUT_FORMATS.join(", ")}.`,
  );
}

/** Free-function forms of the seam, for the many call sites that only need to
 *  write a line and would otherwise each bind a local. They read the singleton
 *  per call, so they observe the configured format no matter when they run. */
export const outLine = (text = ""): void => current.line(text);
export const outErrLine = (text = ""): void => current.errLine(text);
export const outEmit = (payload: unknown): void => current.emit(payload);
export const outDocument = (payload: unknown): void => current.document(payload);
export const outProgress = (text: string): void => current.progress(text);
export const outEndProgress = (): void => current.endProgress();
