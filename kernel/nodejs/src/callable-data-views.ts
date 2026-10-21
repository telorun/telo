/**
 * **A native function's dependencies, delivered as data** — the kernel half of
 * `callable-data-slot.ts`.
 *
 * At `create()` of a native callable, every reference at one of its data sites
 * (every use its slot takes there is `dependency`) is replaced, on the copy the
 * controller receives, by the referent's VIEW: the configuration the referent's
 * own controller received — compile-eval fields expanded, accessor fields as
 * bindings, texts as records, references injected — without `kind` and
 * `metadata`, each reference inside replaced by that referent's view in turn,
 * deep-cloned and frozen. One view per declaration, so the cost is linear in
 * what the views hold.
 *
 * The callable's own declaration keeps its references, so creation order,
 * deferral, reconcile and the rebinding of module calls follow them exactly as
 * they follow any other reference; the views sit on the controller's copy only,
 * at paths Phase-5 injection is told not to overwrite.
 *
 * What is delivered is checked positively: every leaf a CEL value, every
 * container plain. Anything else — an expression left for a later evaluation, a
 * scope, a need's fulfilment, an instance at a position no reference slot
 * declares, a cycle, a template body's reference to a resource of the module
 * defining the template, which the body's lookup leaves unresolved — is
 * `ERR_CALLABLE_REFERENCE_NOT_DATA`, worded by the same reader `telo check`
 * reports the static half with.
 */
import {
  callableReferenceNotDataMessage,
  isDataSite,
  type NotData,
  type NotDataReason,
  type ReachSite,
} from "@telorun/analyzer";
import { celTypeNameOf, isCelBytes, isCelRecord } from "@telorun/cel";
import { isCompiledValue, RuntimeError, type ResourceManifest } from "@telorun/sdk";
import { declarationOfInstance } from "./instance-declaration.js";
import { isNeedFulfilment } from "./need-fulfilment.js";

type Keys = readonly (string | number)[];

/** Declaration → the manifest its controller's `create()` received. */
const received = new WeakMap<object, ResourceManifest>();
/** Declaration → its view, once built. */
const views = new WeakMap<object, Readonly<Record<string, unknown>>>();
/** Every view built, so a view met again — on a native callable's own copy —
 *  is recognised as one rather than walked as configuration. */
const builtViews = new WeakSet<object>();

/** Record what `declaration`'s controller received at `create()`. */
export function recordReceivedConfiguration(declaration: object, configuration: ResourceManifest): void {
  received.set(declaration, configuration);
}

/** What `declaration`'s controller received at `create()` — the declaration
 *  itself for one not created yet. */
export function receivedConfigurationOf(declaration: ResourceManifest): ResourceManifest {
  return received.get(declaration) ?? declaration;
}

/** What resolving a reference reads from the kernel. */
export interface DataViewHost {
  /** The concrete sites of `configuration`, its kind resolved as `declaration`'s. */
  sitesOf(declaration: ResourceManifest, configuration: ResourceManifest): readonly ReachSite[];
  /** What a reference `declaration` writes names, looked up in the context that
   *  declared it as Phase-5 injection looks it up. */
  instanceFor(declaration: ResourceManifest, name: string, alias?: string): unknown;
  /** True when a bare `name` `declaration` writes is beyond that lookup's reach
   *  but declared where its context was spawned from — a template body naming a
   *  resource of the module defining the template. */
  beyondReach(declaration: ResourceManifest, name: string, alias?: string): boolean;
}

/** Why a reference resolved to nothing. */
const missing = (beyondReach: boolean): NotDataReason =>
  beyondReach ? { kind: "module" } : { kind: "unresolved" };

/** A refusal on its way out of a nested view, gaining the name of each
 *  reference it crosses. */
class Refused {
  constructor(readonly notData: NotData) {}
}

const refuse = (name: string, reason: NotDataReason): never => {
  throw new Refused({ chain: [name], reason });
};

function readReference(value: unknown): { name: string; alias?: string } | undefined {
  if (!isCelRecord(value)) return undefined;
  const { kind, name, alias } = value as Record<string, unknown>;
  if (typeof kind !== "string" || typeof name !== "string") return undefined;
  return { name, ...(typeof alias === "string" ? { alias } : {}) };
}

function pathOf(keys: Keys): string {
  let out = "";
  for (const key of keys) out += typeof key === "number" ? `[${key}]` : out === "" ? key : `.${key}`;
  return out;
}

function describe(value: unknown): string {
  if (typeof value === "function") return "a function";
  if (declarationOfInstance(value)) return "a live resource instance";
  const name = (value as { constructor?: { name?: unknown } } | null)?.constructor?.name;
  return typeof name === "string" && name.length > 0 ? `a ${name}` : `a value of type ${typeof value}`;
}

/** The view of the resource `instance` is, named `name` by whoever holds it. */
function viewOf(
  instance: unknown,
  name: string,
  stack: readonly object[],
  host: DataViewHost,
): Readonly<Record<string, unknown>> {
  if (isNeedFulfilment(instance)) refuse(name, { kind: "need" });
  const declaration = declarationOfInstance(instance);
  if (!declaration) return refuse(name, { kind: "unresolved" });
  if (stack.includes(declaration)) refuse(name, { kind: "cycle" });
  const cached = views.get(declaration);
  if (cached) return cached;

  const configuration = received.get(declaration) ?? declaration;
  const sites = new Map<string, ReachSite>();
  for (const site of host.sitesOf(declaration, configuration)) sites.set(JSON.stringify(site.keys), site);
  const inner = [...stack, declaration];

  const reference = (value: unknown, site: ReachSite): unknown => {
    if (isCelRecord(value) && builtViews.has(value)) return value;
    if (Array.isArray(value)) return Object.freeze(value.map((item) => reference(item, site)));
    let target = value;
    let targetName: string | undefined;
    const ref = readReference(value);
    if (ref) {
      targetName = ref.name;
      target = host.instanceFor(declaration, ref.name, ref.alias);
      if (target === undefined) {
        throw new Refused({
          chain: [name, ref.name],
          reason: missing(host.beyondReach(declaration, ref.name, ref.alias)),
        });
      }
    } else if (!isNeedFulfilment(value) && !declarationOfInstance(value)) {
      // A value branch: the slot holds data, not a reference.
      return data(value, site.keys, false);
    }
    targetName ??= String(declarationOfInstance(target)?.metadata?.name ?? site.path);
    try {
      return viewOf(target, targetName, inner, host);
    } catch (error) {
      if (error instanceof Refused) {
        throw new Refused({ ...error.notData, chain: [name, ...error.notData.chain] });
      }
      throw error;
    }
  };

  const data = (value: unknown, keys: Keys, atSite = true): unknown => {
    if (atSite && keys.length > 0) {
      const site = sites.get(JSON.stringify(keys));
      if (site?.scopes.length && value !== undefined) refuse(name, { kind: "scope", path: site.path });
      if (site && site.refs.length > 0) return reference(value, site);
    }
    if (value === null || value === undefined) return value;
    const type = typeof value;
    if (type === "string" || type === "number" || type === "bigint" || type === "boolean") return value;
    if (isCompiledValue(value)) {
      const engine = (value as { engine?: unknown }).engine;
      refuse(name, { kind: "expression", path: pathOf(keys), tag: typeof engine === "string" ? engine : "cel" });
    }
    if (Array.isArray(value)) return Object.freeze(value.map((item, index) => data(item, [...keys, index])));
    if (isCelBytes(value)) return new Uint8Array(value);
    if (isCelRecord(value)) {
      if (builtViews.has(value)) return value;
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value)) {
        if (keys.length === 0 && (key === "kind" || key === "metadata")) continue;
        out[key] = data(child, [...keys, key]);
      }
      return Object.freeze(out);
    }
    if (celTypeNameOf(value) !== undefined) return value;
    return refuse(name, { kind: "value", path: pathOf(keys), what: describe(value) });
  };

  const view = data(configuration, []) as Readonly<Record<string, unknown>>;
  builtViews.add(view);
  views.set(declaration, view);
  return view;
}

/**
 * The manifest a native callable's controller receives: `base` with every
 * reference at a data site replaced by its referent's view, and the paths of
 * those sites — which the copy record keeps Phase-5 injection off. Undefined
 * when the resource has no data site.
 *
 * `resolve` names the instance a reference written in the callable's own
 * context names, throwing the deferral injection throws for one not yet
 * initialized; `beyondReach` says why one resolving to nothing does.
 */
export function deliverDataSites(input: {
  label: string;
  declaration: ResourceManifest;
  base: ResourceManifest;
  sites: readonly ReachSite[];
  resolve: (name: string, alias?: string) => unknown;
  beyondReach: (name: string, alias?: string) => boolean;
  host: DataViewHost;
}): { manifest: ResourceManifest; paths: (string | number)[][] } | undefined {
  const { label, declaration, base, host } = input;
  const delivered: { site: ReachSite; value: unknown }[] = [];
  for (const site of input.sites) {
    if (!isDataSite(site, declaration)) continue;
    const deliver = (value: unknown): unknown => {
      if (Array.isArray(value)) return Object.freeze(value.map(deliver));
      if (isCelRecord(value) && builtViews.has(value)) return value;
      const ref = readReference(value);
      const instance = ref ? input.resolve(ref.name, ref.alias) : value;
      const name = ref?.name ?? String(declarationOfInstance(value)?.metadata?.name ?? site.path);
      if (!ref && !isNeedFulfilment(value) && !declarationOfInstance(value)) return value;
      try {
        if (instance === undefined) refuse(name, missing(!!ref && input.beyondReach(ref.name, ref.alias)));
        return viewOf(instance, name, [declaration], host);
      } catch (error) {
        if (error instanceof Refused) {
          throw new RuntimeError(
            "ERR_CALLABLE_REFERENCE_NOT_DATA",
            callableReferenceNotDataMessage(label, site.path, error.notData),
          );
        }
        throw error;
      }
    };
    delivered.push({ site, value: deliver(site.data) });
  }
  if (delivered.length === 0) return undefined;

  const manifest = { ...base } as Record<string | number, unknown>;
  for (const { site, value } of delivered) {
    let holder: Record<string | number, unknown> | unknown[] = manifest;
    const keys = site.keys;
    for (let index = 0; index < keys.length - 1; index++) {
      const key = keys[index]!;
      const child: unknown = (holder as Record<string | number, unknown>)[key];
      const copy: Record<string | number, unknown> | unknown[] = Array.isArray(child)
        ? [...child]
        : { ...(child as Record<string, unknown>) };
      (holder as Record<string | number, unknown>)[key] = copy;
      holder = copy;
    }
    (holder as Record<string | number, unknown>)[keys[keys.length - 1]!] = value;
  }
  return {
    manifest: manifest as unknown as ResourceManifest,
    paths: delivered.map(({ site }) => [...site.keys]),
  };
}
