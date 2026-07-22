export const CAPABILITY_VALUES = [
  "Telo.Service",
  "Telo.Runnable",
  "Telo.Invocable",
  "Telo.Provider",
  "Telo.Mount",
  "Telo.Type",
] as const;

/** One-line role summary per capability, surfaced on hover. Kept in sync with
 *  the capability list in `CLAUDE.md` / the kernel builtins. */
export const CAPABILITY_DOCS: Record<string, string> = {
  "Telo.Service": "Long-lived resource: `init()` + optional `teardown()` (servers, pools).",
  "Telo.Runnable": "One-shot task: `run()` (pipelines, boot steps).",
  "Telo.Invocable": "Request handler: `invoke(inputs)` (scripts, endpoints).",
  "Telo.Provider": "Value-flow source: `init()` + optional `provide()` (config, secrets).",
  "Telo.Mount": "Mounted into a Service (HTTP APIs, middleware).",
  "Telo.Type": "Pure schema definition — no runtime instance.",
};
