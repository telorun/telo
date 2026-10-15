import type { ResourceDefinition } from "@telorun/sdk";
import {
  controllerBearingAncestor,
  hasOwnControllerOrTemplate,
  inheritedCapability,
  type DefResolver,
} from "./extends-resolution.js";
import { needTypeOf } from "./need-type.js";
import { NEED_CONSTRAINTS, readRefSlot } from "./ref-slot.js";
import { forEachRefSlotNode } from "./validate-ref-slots.js";

/**
 * OBSERVING SLOTS — a reference slot whose `x-telo-ref` lists `observes`: the
 * kind opening the fulfilment there reports what it found (the version, the
 * features present) and the kernel compares it with the need.
 *
 * The kernel can only demand that report at a moment the kind is bound to
 * reach, so `observes` is legal only on a kind whose effective capability has a
 * DEADLINE in {@link OBSERVATION_DEADLINES} and whose instances a controller
 * serves (an abstract declares it as a contract its implementations inherit).
 * One table, read by `telo check`, by the kernel when it registers a definition
 * and by the kernel when it holds an instance to its deadline — a capability
 * gains `observes` only by gaining an entry here.
 *
 * Browser-safe.
 */

/** When an observation is due: `init` — when `init()` returns; `run` — when
 *  `run()` returns (the first, for a Runnable); `invoke` — when the first
 *  `invoke()` returns. */
export type ObservationDeadline = "init" | "run" | "invoke";

export const OBSERVATION_DEADLINES: Readonly<Record<string, ObservationDeadline>> = {
  "Telo.Provider": "init",
  "Telo.Service": "run",
  "Telo.Runnable": "run",
  "Telo.Invocable": "invoke",
};

export function observationDeadline(capability: string | undefined): ObservationDeadline | undefined {
  return capability ? OBSERVATION_DEADLINES[capability] : undefined;
}

export interface ObservesProblem {
  code: "X_TELO_REF_INVALID_OBSERVES";
  /** Schema path of the `observes` key, under the definition. */
  path: string;
  message: string;
}

/** The `x-telo-ref` annotations of a slot node that state `observes`: its own
 *  and its `anyOf` / `oneOf` branches'. */
function observingCarriers(
  node: Record<string, unknown>,
  path: string,
): Array<{ annotation: Record<string, unknown>; at: string }> {
  const carriers: Array<{ annotation: Record<string, unknown>; at: string }> = [];
  const own = node["x-telo-ref"];
  if (own && typeof own === "object" && !Array.isArray(own)) {
    carriers.push({ annotation: own as Record<string, unknown>, at: `${path}.x-telo-ref` });
  }
  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = node[key];
    if (!Array.isArray(branches)) continue;
    branches.forEach((branch, i) => {
      const ann = (branch as Record<string, unknown> | null)?.["x-telo-ref"];
      if (ann && typeof ann === "object" && !Array.isArray(ann)) {
        carriers.push({ annotation: ann as Record<string, unknown>, at: `${path}.${key}[${i}].x-telo-ref` });
      }
    });
  }
  return carriers.filter((c) => c.annotation.observes !== undefined);
}

/** Schema path of every observing slot of `schema`, mapped to its first
 *  observing annotation's path. */
function observingSlots(schema: unknown): Map<string, string> {
  const out = new Map<string, string>();
  forEachRefSlotNode(schema, "schema", (node, path) => {
    const [first] = observingCarriers(node, path);
    if (first) out.set(path, first.at);
  });
  return out;
}

/**
 * Every refusal of `observes` a kind answers for, split by what each is about.
 *
 * The SLOT — its tokens, and that its kind is a need type declaring each
 * constraint — is judged on `ownSchema`, the slots the kind writes itself, so
 * a slot is judged once, at the kind that declares it. The HOLDER — a deadline
 * for the observation and a controller to make it — is judged on
 * `mergedSchema`, the kind's author schema with what it inherits: an abstract's
 * observing slot binds every implementation, and an implementation's refusal
 * for an inherited slot names the ancestor that declares it and is anchored at
 * its own `extends`. `resolve` maps a kind to its definition; returning
 * undefined for a slot kind means it is not loaded (`pending`).
 */
export function observesProblems(
  definition: ResourceDefinition,
  ownSchema: Record<string, unknown> | undefined,
  mergedSchema: Record<string, unknown> | undefined,
  resolve: DefResolver,
): { problems: ObservesProblem[]; pending: string[] } {
  const problems: ObservesProblem[] = [];
  const pending: string[] = [];
  const name = `${definition.kind} '${definition.metadata?.name as string}'`;

  forEachRefSlotNode(ownSchema, "schema", (node, path) => {
    const observing = observingCarriers(node, path);
    if (observing.length === 0) return;
    for (const { annotation, at } of observing) {
      const raw = annotation.observes;
      const tokens = Array.isArray(raw) ? raw : undefined;
      if (!tokens || tokens.length === 0 || tokens.some((t) => !(NEED_CONSTRAINTS as readonly unknown[]).includes(t))) {
        problems.push({
          code: "X_TELO_REF_INVALID_OBSERVES",
          path: `${at}.observes`,
          message:
            `${name}: x-telo-ref at '${path}' declares 'observes: ${JSON.stringify(raw)}'. It lists ` +
            `the need constraints the kind reports for the fulfilment it opens at this slot — a ` +
            `non-empty list of ${NEED_CONSTRAINTS.join(", ")}.`,
        });
      }
    }
    const slot = readRefSlot(node as Record<string, any>);
    const observes = slot?.observes ?? [];
    for (const kind of slot?.kinds ?? []) {
      const target = resolve(kind, definition);
      if (!target) {
        pending.push(kind);
        continue;
      }
      const shape = needTypeOf(target);
      if (!shape) {
        problems.push({
          code: "X_TELO_REF_INVALID_OBSERVES",
          path: `${observing[0]!.at}.observes`,
          message:
            `${name}: x-telo-ref at '${path}' declares 'observes', and its kind '${kind}' is not a ` +
            `need type. Only a slot holding a need's fulfilment observes one.`,
        });
        continue;
      }
      for (const constraint of observes) {
        const declared =
          constraint === "version" ? shape.version === "semver" : (shape.features?.length ?? 0) > 0;
        if (declared) continue;
        problems.push({
          code: "X_TELO_REF_INVALID_OBSERVES",
          path: `${observing[0]!.at}.observes`,
          message:
            `${name}: x-telo-ref at '${path}' observes '${constraint}', which need type '${kind}' ` +
            `does not declare (${constraint === "version" ? "it has no 'version: semver'" : "it lists no 'features'"}), ` +
            `so no need of it can state one.`,
        });
      }
    }
  });

  const held = observingSlots(mergedSchema);
  if (held.size === 0) return { problems, pending };
  const kindProblem = observingKindProblem(definition, resolve);
  if (!kindProblem) return { problems, pending };
  const own = observingSlots(ownSchema);
  for (const [path, at] of held) {
    const ownAt = own.get(path);
    if (ownAt !== undefined) {
      problems.push({
        code: "X_TELO_REF_INVALID_OBSERVES",
        path: `${ownAt}.observes`,
        message: `${name}: x-telo-ref at '${path}' declares 'observes', but ${kindProblem}`,
      });
      continue;
    }
    const declarer = declaringAncestor(definition, path, resolve);
    problems.push({
      code: "X_TELO_REF_INVALID_OBSERVES",
      path: definition.extends !== undefined ? "extends" : `${at}.observes`,
      message:
        `${name}: x-telo-ref at '${path}', inherited from ` +
        `${declarer ? `${declarer.kind} '${declarer.metadata?.name as string}'` : "an ancestor"}, ` +
        `declares 'observes', but ${kindProblem}`,
    });
  }
  return { problems, pending };
}

/** The farthest ancestor along `extends` whose schema holds an observing slot
 *  at `path` — the one that declared it — never past an ancestor whose `base:`
 *  makes its own schema the whole of what it hands down. */
function declaringAncestor(
  definition: ResourceDefinition,
  path: string,
  resolve: DefResolver,
): ResourceDefinition | undefined {
  let found: ResourceDefinition | undefined;
  const seen = new Set<ResourceDefinition>([definition]);
  let current: ResourceDefinition | undefined = definition;
  while (current?.extends !== undefined && (current as { base?: unknown }).base == null) {
    const parent = resolve(current.extends, current);
    if (!parent || seen.has(parent)) break;
    seen.add(parent);
    if (observingSlots((parent as { schema?: unknown }).schema).has(path)) found = parent;
    current = parent;
  }
  return found;
}

/** Why `definition`'s instances cannot be held to an observation, or undefined
 *  when they can. */
function observingKindProblem(
  definition: ResourceDefinition,
  resolve: DefResolver,
): string | undefined {
  if (definition.kind === "Telo.Abstract") return undefined;
  const capability = inheritedCapability(definition, resolve);
  if (!observationDeadline(capability)) {
    return (
      `kind capability '${capability ?? "(none)"}' has no moment the observation is due — only ` +
      `${Object.keys(OBSERVATION_DEADLINES).join(", ")} kinds observe. Hold a resource of a kind ` +
      `that opens the fulfilment and observes at its own slot (a Telo.Provider) instead.`
    );
  }
  const bearer = hasOwnControllerOrTemplate(definition)
    ? definition
    : controllerBearingAncestor(definition, resolve);
  const controllers = (bearer as { controllers?: unknown[] } | undefined)?.controllers;
  if (!Array.isArray(controllers) || controllers.length === 0) {
    return (
      `its instances are served by ${bearer ? "the kernel's template controller" : "no controller"}, ` +
      `which has no code to report an observation. Observe in a kind whose controller opens the ` +
      `fulfilment (a Telo.Provider).`
    );
  }
  return undefined;
}
