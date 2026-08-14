/** Planning and applying a migration patch.
 *
 *  Planning is separate from applying because a patch is ALL-OR-NOTHING at each
 *  match: a rule whose second operation cannot apply must not leave the first
 *  one's edit behind. `planPatch` resolves every operation against the tree
 *  first and returns either a concrete effect list or one refusal; only then
 *  does an applier run. The same plan drives both appliers — the JSON tree the
 *  loader hands the analyzer, and the YAML document `telo migrate` writes — so
 *  the in-memory rewrite and the on-disk repair cannot disagree about what an
 *  operation means. */

import { makeTaggedSentinel } from "@telorun/templating";
import { deepEquals } from "./match.js";
import type {
  MigrationOperation,
  MigrationPath,
  MigrationRefusal,
} from "./types.js";

/** A resolved, unconditionally applicable edit. */
export type MigrationEffect =
  | { readonly kind: "rename-key"; readonly parent: MigrationPath; readonly from: string; readonly to: string }
  | { readonly kind: "set-value"; readonly path: MigrationPath; readonly value: unknown }
  | { readonly kind: "set-tag"; readonly path: MigrationPath; readonly tag: string; readonly source: string }
  | { readonly kind: "insert-item"; readonly path: MigrationPath; readonly index: number; readonly value: unknown }
  | { readonly kind: "remove-entry"; readonly path: MigrationPath };

export interface PatchPlan {
  readonly effects: readonly MigrationEffect[];
  /** Where the matched node lives after the patch. Differs from the matched
   *  path only when a `rename-key` moved it. */
  readonly finalPath: MigrationPath;
  /** The value at the match before anything was applied — the "before" half of
   *  the generated diagnostic sentence. */
  readonly before: unknown;
  /** The value at the match after the patch, or `undefined` for a removal. */
  readonly after: unknown;
}

export type PatchPlanResult =
  | { readonly ok: true; readonly plan: PatchPlan }
  | { readonly ok: false; readonly refusal: MigrationRefusal };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The container a path's last segment indexes into, or `undefined` when any
 *  hop is missing. An empty path has no container — the document root is not a
 *  mapping entry and no operation targets it. */
function containerOf(
  root: unknown,
  path: MigrationPath,
): { container: unknown; key: string | number } | undefined {
  if (path.length === 0) return undefined;
  let current: unknown = root;
  for (let i = 0; i < path.length - 1; i++) {
    const segment = path[i];
    if (typeof segment === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
    } else {
      if (!isPlainObject(current)) return undefined;
      current = current[segment];
    }
  }
  return { container: current, key: path[path.length - 1]! };
}

function readAt(root: unknown, path: MigrationPath): { found: boolean; value: unknown } {
  const located = containerOf(root, path);
  if (!located) return { found: false, value: undefined };
  const { container, key } = located;
  if (typeof key === "number") {
    if (!Array.isArray(container) || key < 0 || key >= container.length) {
      return { found: false, value: undefined };
    }
    return { found: true, value: container[key] };
  }
  if (!isPlainObject(container) || !Object.hasOwn(container, key)) {
    return { found: false, value: undefined };
  }
  return { found: true, value: container[key] };
}

/** A scalar YAML can carry behind a tag, and the only thing `set-tag` and
 *  `qualify` can operate on. */
function scalarSource(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

/**
 * Resolve `ops` at `path` against `root`, or refuse.
 *
 * Refusing is the design's safety valve: the node is left exactly as the author
 * wrote it and the ordinary validator reports it with an accurate message,
 * rather than the migration guessing or dropping a value.
 */
export function planPatch(
  root: unknown,
  path: MigrationPath,
  ops: readonly MigrationOperation[],
): PatchPlanResult {
  const initial = readAt(root, path);
  if (!initial.found) return { ok: false, refusal: "path-not-found" };

  const effects: MigrationEffect[] = [];
  let currentPath: MigrationPath = path;
  let currentValue = initial.value;
  let removed = false;

  for (const op of ops) {
    if (removed) return { ok: false, refusal: "path-not-found" };

    switch (op.op) {
      case "rename-key": {
        const located = containerOf(root, currentPath);
        const key = located?.key;
        if (!located || typeof key !== "string" || !isPlainObject(located.container)) {
          return { ok: false, refusal: "not-a-mapping-entry" };
        }
        if (op.to !== key && Object.hasOwn(located.container, op.to)) {
          // Refuse rather than replace: the occupied destination holds a value
          // the author wrote.
          return { ok: false, refusal: "destination-occupied" };
        }
        const parent = currentPath.slice(0, -1);
        effects.push({ kind: "rename-key", parent, from: key, to: op.to });
        currentPath = [...parent, op.to];
        break;
      }
      case "set-value": {
        let next: unknown;
        if (op.qualify !== undefined) {
          if (typeof currentValue !== "string") {
            return { ok: false, refusal: "malformed-value" };
          }
          if (currentValue.startsWith(op.qualify)) {
            return { ok: false, refusal: "nothing-to-rewrite" };
          }
          next = `${op.qualify}${currentValue}`;
        } else {
          // Same refusal as `qualify`'s, and for the same reason: a rule should
          // match only the legacy spelling, so a write of the value already
          // there means the matcher was too wide. Reporting it would be a
          // deprecation reading `type: string is now written type: string`.
          if (deepEquals(op.value, currentValue)) {
            return { ok: false, refusal: "nothing-to-rewrite" };
          }
          next = op.value;
        }
        effects.push({ kind: "set-value", path: currentPath, value: next });
        currentValue = next;
        break;
      }
      case "set-tag": {
        const source = scalarSource(currentValue);
        if (source === undefined) return { ok: false, refusal: "not-a-scalar" };
        effects.push({ kind: "set-tag", path: currentPath, tag: op.tag, source });
        currentValue = makeTaggedSentinel(op.tag, source);
        break;
      }
      case "insert-item": {
        if (!Array.isArray(currentValue)) return { ok: false, refusal: "not-a-sequence" };
        const index =
          op.at === undefined
            ? currentValue.length
            : Math.max(0, Math.min(op.at, currentValue.length));
        effects.push({ kind: "insert-item", path: currentPath, index, value: op.value });
        currentValue = [
          ...currentValue.slice(0, index),
          op.value,
          ...currentValue.slice(index),
        ];
        break;
      }
      case "remove-entry": {
        effects.push({ kind: "remove-entry", path: currentPath });
        currentValue = undefined;
        removed = true;
        break;
      }
    }
  }

  return {
    ok: true,
    plan: {
      effects,
      finalPath: currentPath,
      before: initial.value,
      after: removed ? undefined : currentValue,
    },
  };
}

/** Apply a plan to the in-memory manifest tree. Mutates in place — the tree is
 *  the loader's own projection of the document, never the author's file. */
export function applyEffectsToTree(root: unknown, effects: readonly MigrationEffect[]): void {
  for (const effect of effects) {
    switch (effect.kind) {
      case "rename-key": {
        const parent =
          effect.parent.length === 0 ? root : readAt(root, effect.parent).value;
        if (!isPlainObject(parent)) continue;
        // Rebuilt in place so the renamed key keeps its position. Key order is
        // what a round-trip consumer and a rendered diff both read.
        const entries = Object.entries(parent);
        for (const [key] of entries) delete parent[key];
        for (const [key, value] of entries) {
          parent[key === effect.from ? effect.to : key] = value;
        }
        break;
      }
      case "set-value":
      case "set-tag": {
        const located = containerOf(root, effect.path);
        if (!located) continue;
        const next =
          effect.kind === "set-value"
            ? effect.value
            : makeTaggedSentinel(effect.tag, effect.source);
        writeAt(located.container, located.key, next);
        break;
      }
      case "insert-item": {
        const target = readAt(root, effect.path).value;
        if (!Array.isArray(target)) continue;
        target.splice(effect.index, 0, effect.value);
        break;
      }
      case "remove-entry": {
        const located = containerOf(root, effect.path);
        if (!located) continue;
        if (typeof located.key === "number") {
          if (Array.isArray(located.container)) located.container.splice(located.key, 1);
        } else if (isPlainObject(located.container)) {
          delete located.container[located.key];
        }
        break;
      }
    }
  }
}

function writeAt(container: unknown, key: string | number, value: unknown): void {
  if (typeof key === "number") {
    if (Array.isArray(container)) container[key] = value;
    return;
  }
  if (isPlainObject(container)) container[key] = value;
}

/** Dotted rendering of a path, in the form the position index and every
 *  diagnostic's `data.path` use: `routes[0].handler`. */
export function formatMigrationPath(path: MigrationPath): string {
  let out = "";
  for (const segment of path) {
    if (typeof segment === "number") out += `[${segment}]`;
    else out += out.length === 0 ? segment : `.${segment}`;
  }
  return out;
}
