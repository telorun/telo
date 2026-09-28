/** `error.type` for a failure on a span: the structured code when the error
 *  carries one, else its class name. Low-cardinality by construction — never the
 *  message. The one rule every span producer (the kernel's dispatch spans, a
 *  module's own) writes the attribute by. */
export function errorTypeOf(err: unknown): string {
  if (err && typeof err === "object") {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
    if (err instanceof Error && err.name) return err.name;
  }
  return "UnknownError";
}
