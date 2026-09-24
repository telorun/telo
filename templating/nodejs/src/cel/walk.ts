import { isTaggedSentinel } from "../sentinel.js";

/** Walks `value` and emits each tagged scalar with its dotted path (e.g.
 *  `routes[0].handler.body`) and the engine that owns it — including engines
 *  that produce no diagnostics (`literal`), so routing through the registry
 *  stays generic and a new engine needs no change here. A plain string is
 *  never a value's expression, and compiled values are skipped so a
 *  precompiled tree is not re-walked. */
export function walkCelExpressions(
  value: unknown,
  path: string,
  cb: (source: string, path: string, engineName: string) => void,
): void {
  if (isTaggedSentinel(value)) {
    cb(value.source, path, value.engine);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => walkCelExpressions(v, `${path}[${i}]`, cb));
    return;
  }
  if (
    value !== null &&
    typeof value === "object" &&
    !(value as { __compiled?: unknown }).__compiled &&
    isPlainObject(value)
  ) {
    // `for…in` over a plain object sees exactly its own enumerable keys, without
    // the array `Object.entries` allocates — this walk runs over every resource
    // a context creates.
    for (const k in value) {
      walkCelExpressions((value as Record<string, unknown>)[k], path ? `${path}.${k}` : k, cb);
    }
  }
}

/** A template body forwards `self.<ref>` as the LIVE instance, whose object graph
 *  is cyclic and holds no authored expression — walking it overflows the stack.
 *  The rule the include walk and `compileWalker` follow. */
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
