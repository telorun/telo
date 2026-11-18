/**
 * The host runner's own output seam. stdout is the machine surface — under
 * `-o json` it carries the address document and nothing else, so prose goes
 * silent there — and stderr the human one in both formats.
 */

export type OutputFormat = "text" | "json";

export const OUTPUT_FORMATS: readonly OutputFormat[] = ["text", "json"];

let format: OutputFormat = "text";

export function configureOutput(next: OutputFormat): void {
  format = next;
}

/** A prose line on stdout, written in text format only. */
export function outLine(text = ""): void {
  if (format === "text") process.stdout.write(`${text}\n`);
}

/** A line on stderr, written in both formats: it is how a failure is explained. */
export function outErrLine(text = ""): void {
  process.stderr.write(`${text}\n`);
}

/** The result document, written once under `-o json`; nothing under `text`. */
export function outEmit(payload: unknown): void {
  if (format === "json") process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}
