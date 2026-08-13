import { isTaggedSentinel } from "../sentinel.js";
import { TEMPLATE_REGEX } from "./compile.js";

/** How an emitted expression sits in the scalar it came from. A repair can be
 *  applied by replacing the scalar only when the expression covers all of it;
 *  otherwise the literal text around it would be lost.
 *
 *  `wrapper` is the delimiter text to restore around a corrected expression —
 *  empty for a tagged sentinel (whose scalar *is* the expression), `${{` / `}}`
 *  for the legacy interpolation form. Carrying it as data rather than letting
 *  each consumer re-derive it is what keeps `${{ … }}` a first-class fix site
 *  instead of an exclusion: the two surfaces differ only by these delimiters. */
export interface CelSurface {
  readonly whole: boolean;
  readonly wrapper?: { readonly prefix: string; readonly suffix: string };
}

const OPEN = "${{";

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
  cb: (source: string, path: string, engineName: string, surface: CelSurface) => void,
): void {
  if (isTaggedSentinel(value)) {
    cb(value.source, path, value.engine, { whole: true });
    return;
  }
  if (typeof value === "string") {
    const matches = [...value.matchAll(TEMPLATE_REGEX)];
    for (const m of matches) {
      const expr = m[1]!.trim();
      // A string that is nothing but one interpolation is as whole as a
      // tagged scalar — the delimiters are the only difference, and they are
      // handed back as the wrapper.
      const only = matches.length === 1 && m.index === 0 && m[0]!.length === value.length;
      const lead = /^\s*/.exec(m[0]!.slice(OPEN.length))![0]!.length;
      cb(expr, path, "cel", {
        whole: only,
        ...(only
          ? {
              wrapper: {
                prefix: value.slice(0, OPEN.length + lead),
                suffix: value.slice(OPEN.length + lead + expr.length),
              },
            }
          : {}),
      });
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
