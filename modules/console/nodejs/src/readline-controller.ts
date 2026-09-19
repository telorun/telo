import type { ResourceContext, ResourceInstance, RuntimeResource } from "@telorun/sdk";
import * as rl from "readline";
import { isTtyStream, render } from "./markup.js";

interface ReadLineInputs {
  prompt: string;
}

/**
 * One reader per INPUT STREAM, shared by every `Console.ReadLine` in the
 * application and by every call each of them makes.
 *
 * Two things forced this. A `readline` interface reads ahead, so a second one
 * over the same input starts after whatever the first had already buffered —
 * with a terminal nobody notices, but with piped input every line after the
 * first was silently lost. And an interface opened over an input that has
 * ALREADY ended never reports that it ended, so a second reader waited forever
 * for a line that could not arrive: the manifest below hung on its second read,
 * having answered the first.
 *
 * Keyed by the stream, so two applications in one process (a child run through
 * `ctx.runtime`) get one reader each rather than sharing one.
 */
const readers = new WeakMap<NodeJS.ReadableStream, LineReader>();

class LineReader {
  #buffered: string[] = [];
  #waiting: Array<(line: string) => void> = [];
  #ended = false;
  /** How many resources hold this reader. The interface closes when the LAST one
   *  goes, not when the first one does: a `with:`-scoped `Console.ReadLine`
   *  tearing down beside a module-level one would otherwise close the shared
   *  interface, and the next read would build a second one over a
   *  partially-consumed input — the read-ahead loss this reader exists to
   *  remove. */
  #holders = 0;

  constructor(private readonly iface: rl.Interface, alreadyEnded: boolean) {
    this.#ended = alreadyEnded;
    iface.on("line", (line) => {
      const waiter = this.#waiting.shift();
      if (waiter) waiter(line);
      else this.#buffered.push(line);
    });
    iface.on("close", () => this.#end());
  }

  /** Input has ended: everyone waiting, and everyone after them, reads "" rather
   *  than waiting for a line that cannot arrive. */
  #end(): void {
    this.#ended = true;
    for (const waiter of this.#waiting.splice(0)) waiter("");
  }

  async read(): Promise<string> {
    const buffered = this.#buffered.shift();
    if (buffered !== undefined) return buffered;
    if (this.#ended) return "";
    return new Promise<string>((resolve) => this.#waiting.push(resolve));
  }

  hold(): void {
    this.#holders += 1;
  }

  /** True when that was the last holder and the interface has been closed. */
  release(): boolean {
    this.#holders -= 1;
    if (this.#holders > 0) return false;
    this.iface.close();
    return true;
  }
}

/**
 * Read one line from this application's input.
 *
 * EOF reads as an empty string rather than hanging — what the Rust controller
 * has always done. The previous shape resolved only from `question`'s callback,
 * which never fires once input has ended, so an application whose input was a
 * closed pipe waited for a line that could not arrive and, holding nothing,
 * exited silently having done none of its work.
 */
class ConsoleReadLine implements ResourceInstance<ReadLineInputs, { value: string }> {
  #held?: LineReader;

  constructor(private readonly ctx: ResourceContext) {}

  async invoke(inputs: ReadLineInputs): Promise<{ value: string }> {
    const reader = await this.#reader();
    const prompt = render(String(inputs?.prompt ?? ""), isTtyStream(this.ctx.stdout as any));
    // Written here rather than through `iface.question`, which is what the
    // per-call interface used. The prompt still precedes the read.
    if (prompt.length > 0) this.ctx.stdout.write(prompt);
    return { value: await reader.read() };
  }

  async #reader(): Promise<LineReader> {
    if (this.#held) return this.#held;

    const existing = readers.get(this.ctx.stdin);
    const reader = existing ?? this.#openReader();
    this.#held = reader;
    reader.hold();

    // Performed rather than returned: the reader is opened on first use, inside
    // an invocation, so there is no lifecycle method left to hand a chain back
    // from. An open interface keeps the input flowing, so closing it is what
    // lets the process finish — but only once every resource sharing it is gone.
    await this.ctx
      .effect("console reader", async () => ({
        result: undefined,
        inverse: () => {
          this.#held = undefined;
          if (reader.release()) readers.delete(this.ctx.stdin);
        },
      }))
      .perform();
    return reader;
  }

  #openReader(): LineReader {
    const iface = rl.createInterface({ input: this.ctx.stdin, output: this.ctx.stdout });
    // An input that has already ended emits nothing further, so the reader is
    // born ended rather than waiting for a `close` that has been and gone.
    const alreadyEnded =
      (this.ctx.stdin as NodeJS.ReadableStream & { readableEnded?: boolean }).readableEnded ===
      true;
    const reader = new LineReader(iface, alreadyEnded);
    readers.set(this.ctx.stdin, reader);
    return reader;
  }
}

export function register(): void {}

export async function create(
  resource: RuntimeResource,
  ctx: ResourceContext,
): Promise<ConsoleReadLine> {
  return new ConsoleReadLine(ctx);
}
