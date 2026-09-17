export const CAPABILITY_VALUES = [
  "Telo.Service",
  "Telo.Runnable",
  "Telo.Invocable",
  "Telo.Provider",
  "Telo.Mount",
  "Telo.Sink",
  "Telo.Callable",
  "Telo.Type",
] as const;

/** One-line role summary per capability, surfaced on hover. Kept in sync with
 *  the capability list in `CLAUDE.md` / the kernel builtins. */
export const CAPABILITY_DOCS: Record<string, string> = {
  "Telo.Service": "Long-lived resource: `init()` + `run()`, returning what undoes them (servers, pools).",
  "Telo.Runnable": "One-shot task: `run()` (pipelines, boot steps).",
  "Telo.Invocable": "Request handler: `invoke(inputs)` (scripts, endpoints).",
  "Telo.Provider": "Value-flow source: `init()` + optional `provide()` (config, secrets).",
  "Telo.Mount": "Mounted into a Service (HTTP APIs, middleware).",
  "Telo.Sink":
    "Record-stream destination: `write(record)` + `flush()` / `flushSync()` / `close()`, written to directly rather than dispatched.",
  "Telo.Callable":
    "Function: synchronous `call(args)` against a declared `params` / `returns` signature, called from CEL through a module name.",
  "Telo.Type": "Pure schema definition — no runtime instance.",
};
