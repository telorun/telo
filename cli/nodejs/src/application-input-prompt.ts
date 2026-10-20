import type { UnresolvedApplicationInput } from "@telorun/kernel";
import type { Output } from "./output.js";

/**
 * Asking a person at the terminal for an application input no channel
 * supplied — one entry at a time, on stderr, answers read line by line from
 * stdin.
 *
 * Stdin belongs to the application once it starts (a `Console.ReadLine`, a
 * conversation over it), so a read here takes exactly the answer: bytes typed
 * past the line break are put back, and the stream is left paused, not raw,
 * with its flowing state as it was found.
 */

/** The half of a readable stream a prompt reads from — `process.stdin`, or a
 *  test's stream. */
export interface PromptInput extends NodeJS.ReadableStream {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(mode: boolean): unknown;
  readableFlowing?: boolean | null;
  unshift(chunk: Buffer | string): void;
}

/** How Ctrl-C reaches a prompt: in cooked mode the terminal raises SIGINT; a
 *  hidden read in raw mode receives the byte and raises it itself, so the
 *  run's own interrupt handling sees the same signal either way. */
export interface PromptInterrupts {
  subscribe(listener: () => void): () => void;
  raise(): void;
}

export const processInterrupts: PromptInterrupts = {
  subscribe(listener) {
    process.on("SIGINT", listener);
    return () => process.removeListener("SIGINT", listener);
  },
  raise() {
    process.kill(process.pid, "SIGINT");
  },
};

/** Ctrl-C while an answer was being read. */
export class InputInterrupted extends Error {
  constructor() {
    super("interrupted while asking for the application's inputs");
    this.name = "InputInterrupted";
  }
}

const LF = 0x0a;
const CR = 0x0d;
const CTRL_C = 0x03;
const CTRL_D = 0x04;
const BACKSPACE = 0x08;
const DELETE = 0x7f;

/**
 * Read one line from `input`, consuming nothing after its line break. `hidden`
 * reads without echo where the input is a terminal. Resolves `null` at the end
 * of input (Ctrl-D on an empty line); rejects {@link InputInterrupted} on
 * Ctrl-C.
 */
export function readAnswerLine(
  input: PromptInput,
  hidden: boolean,
  interrupts: PromptInterrupts = processInterrupts,
): Promise<string | null> {
  const raw = hidden && input.isTTY === true && typeof input.setRawMode === "function";
  const wasRaw = input.isRaw === true;
  const wasFlowing = input.readableFlowing;
  if (raw) input.setRawMode!(true);
  return new Promise<string | null>((resolve, reject) => {
    const bytes: number[] = [];
    let settled = false;
    const finish = (rest: Buffer | undefined, settle: () => void) => {
      if (settled) return;
      settled = true;
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      unsubscribe();
      input.pause();
      if (rest && rest.length > 0) input.unshift(rest);
      if (raw) input.setRawMode!(wasRaw);
      // `pause()` leaves a stream that was never read from marked paused, which
      // a later `data` listener would not start; it is put back as found.
      if (wasFlowing === null) input.readableFlowing = null;
      settle();
    };
    const onData = (chunk: Buffer | string) => {
      const data = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      for (let i = 0; i < data.length; i++) {
        const byte = data[i]!;
        const rest = () => data.subarray(i + 1);
        if (byte === LF || (raw && byte === CR)) {
          if (!raw && bytes[bytes.length - 1] === CR) bytes.pop();
          finish(rest(), () => resolve(Buffer.from(bytes).toString("utf8")));
          return;
        }
        if (!raw) {
          bytes.push(byte);
          continue;
        }
        if (byte === CTRL_C) {
          finish(rest(), () => reject(new InputInterrupted()));
          interrupts.raise();
          return;
        }
        if (byte === CTRL_D && bytes.length === 0) {
          finish(rest(), () => resolve(null));
          return;
        }
        if (byte === DELETE || byte === BACKSPACE) {
          // One character, which in UTF-8 is its continuation bytes and its lead.
          while (bytes.length > 0 && (bytes[bytes.length - 1]! & 0xc0) === 0x80) bytes.pop();
          bytes.pop();
          continue;
        }
        if (byte < 0x20) continue;
        bytes.push(byte);
      }
    };
    const onEnd = () =>
      finish(undefined, () => resolve(bytes.length > 0 ? Buffer.from(bytes).toString("utf8") : null));
    const unsubscribe = interrupts.subscribe(() => finish(undefined, () => reject(new InputInterrupted())));
    input.on("end", onEnd);
    input.on("data", onData);
    input.resume();
  });
}

/** How a value is named to the person asked for it, in `--help`'s words. */
function typeOf(input: UnresolvedApplicationInput): string {
  const type = input.type === "object" || input.type === "array" ? "JSON" : input.type;
  return input.block === "secrets" ? `${type}; secret` : type;
}

/** What the residual schema asks of a value, beyond its type. */
export function describeConstraints(schema: Record<string, unknown>): string[] {
  const out: string[] = [];
  const list = (values: unknown[]) => values.map((value) => JSON.stringify(value)).join(", ");
  if (Array.isArray(schema.enum)) out.push(`one of ${list(schema.enum)}`);
  if (schema.const !== undefined) out.push(`exactly ${JSON.stringify(schema.const)}`);
  if (typeof schema.pattern === "string") out.push(`matching /${schema.pattern}/`);
  if (typeof schema.format === "string") out.push(`format ${schema.format}`);
  const range = (low: unknown, high: unknown, what: string) => {
    const lo = typeof low === "number" ? low : undefined;
    const hi = typeof high === "number" ? high : undefined;
    if (lo !== undefined && hi !== undefined) out.push(`${what}${lo}–${hi}`);
    else if (lo !== undefined) out.push(`${what}at least ${lo}`);
    else if (hi !== undefined) out.push(`${what}at most ${hi}`);
  };
  range(schema.minimum, schema.maximum, "");
  if (typeof schema.exclusiveMinimum === "number") out.push(`more than ${schema.exclusiveMinimum}`);
  if (typeof schema.exclusiveMaximum === "number") out.push(`less than ${schema.exclusiveMaximum}`);
  range(schema.minLength, schema.maxLength, "length ");
  range(schema.minItems, schema.maxItems, "items ");
  return out;
}

/**
 * The lines shown before an entry is asked for: its environment variable (and
 * command-line spelling) with its description and `[type; identity]`, as
 * `--help`'s Environment section writes it; what the value must satisfy; and,
 * when the last answer was refused, the kernel's sentence.
 */
export function describeInput(input: UnresolvedApplicationInput): string[] {
  const name = [input.env ?? input.name, ...(input.arg ? [input.arg] : [])].join(", ");
  const text = input.title ?? input.description;
  const lines = [[name, text, `[${typeOf(input)}; ${input.id}]`].filter(Boolean).join("  ")];
  const constraints = describeConstraints(input.schema);
  if (constraints.length > 0) lines.push(`  ${constraints.join("; ")}`);
  if (input.refusal !== undefined) lines.push(`  refused: ${input.refusal}`);
  return lines;
}

/** One person, one terminal: what the run asks through. */
export interface InputPrompter {
  /** Ask for one entry; `null` when the person ended the input. */
  ask(input: UnresolvedApplicationInput): Promise<string | null>;
  /** Ask a yes/no question; anything but yes, and the end of input, is no. */
  confirm(question: string): Promise<boolean>;
  /** A line of prose on the asking stream. */
  say(line: string): void;
}

export function terminalPrompter(
  input: PromptInput,
  out: Output,
  interrupts: PromptInterrupts = processInterrupts,
): InputPrompter {
  return {
    async ask(entry) {
      for (const line of describeInput(entry)) out.errLine(line);
      out.errPrompt(`${entry.env ?? entry.name}${entry.sensitive ? " (hidden)" : ""}: `);
      const answer = await readAnswerLine(input, entry.sensitive, interrupts);
      // A hidden read echoes nothing, its line break included.
      if (entry.sensitive && input.isTTY === true) out.errLine();
      if (answer === null) out.errLine();
      return answer;
    },
    async confirm(question) {
      out.errPrompt(`${question} [y/N] `);
      const answer = await readAnswerLine(input, false, interrupts);
      if (answer === null) out.errLine();
      return answer !== null && /^\s*y(es)?\s*$/i.test(answer);
    },
    say(line) {
      out.errLine(line);
    },
  };
}
