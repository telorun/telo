import { isTaggedSentinel } from "../sentinel.js";
import { TEMPLATE_REGEX } from "./compile.js";

/** Walks `value` and emits each templated source segment with its dotted
 *  path (e.g. `routes[0].handler.body`) and the engine that owns it.
 *
 *  - Untagged strings: every `${{ ... }}` segment is emitted with
 *    `engineName = "cel"` (the implicit engine for the legacy interpolation
 *    syntax).
 *  - Tagged sentinels: emitted once with the sentinel's declared engine.
 *    This includes engines that may produce no diagnostics (`literal`) —
 *    routing through the registry stays generic so adding a third engine
 *    that wants real analysis doesn't require touching the walker.
 *  - Compiled values are skipped so a precompiled tree won't be re-walked. */
export function walkCelExpressions(
  value: unknown,
  path: string,
  cb: (source: string, path: string, engineName: string) => void,
): void {
  if (isTaggedSentinel(value)) {
    cb(value.source, path, value.engine);
    return;
  }
  if (typeof value === "string") {
    for (const m of value.matchAll(TEMPLATE_REGEX)) {
      cb(m[1].trim(), path, "cel");
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => walkCelExpressions(v, `${path}[${i}]`, cb));
    return;
  }
  if (
    value !== null &&
    typeof value === "object" &&
    !(value as { __compiled?: unknown }).__compiled
  ) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      walkCelExpressions(v, path ? `${path}.${k}` : k, cb);
    }
  }
}
