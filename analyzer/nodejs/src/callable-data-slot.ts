/**
 * **Where a native function holds its dependencies as data** — the one reader
 * of which reference slots of a `Telo.Callable` deliver the referent's
 * configuration rather than a live instance.
 *
 * A native function's `call(args)` receives no context, so it can do nothing
 * with a live instance. What it can do is read a referent's configuration: a
 * translator reading its catalogs, a formatter reading a table of units. So a
 * native callable's `use: dependency` slot may name any kind, and at `create()`
 * the kernel hands the controller the referent's configuration as its own
 * controller received it, references inside replaced the same way, recursively.
 *
 * Which slot delivers data is decided by `use` alone, never by the kind it
 * names: a slot is a DATA SLOT when every use it can take — across every case
 * of a case map — is `dependency`, and a concrete site of it is a DATA SITE
 * when every use it takes there is, a case map resolved per site by the call
 * graph's own rule. Any other use keeps a callable's slot to another callable
 * or a shape, as before.
 *
 * Read by `validate-callable-kinds.ts` (what such a slot may name, and which
 * slots the determinism rule reads), `validate-callable-data.ts` (what a data
 * site may hold) and the kernel's delivery at creation, so the three agree on
 * which sites are data by construction.
 *
 * Browser-safe: no Node built-ins.
 */
import type { ResourceDefinition } from "@telorun/sdk";
import { callableBodyField, isCallableKind } from "./callable-signature.js";
import { resolveSlotUseAt } from "./call-graph.js";
import type { DefResolver } from "./extends-resolution.js";
import type { ReachSite } from "./reference-reach.js";
import { possibleUses, type RefSlot, type RefUse } from "./ref-slot.js";

const DATA_USE: RefUse = "dependency";

function allData(uses: readonly RefUse[]): boolean {
  return uses.length > 0 && uses.every((use) => use === DATA_USE);
}

/** True when every use the slot can take, across every case, is `dependency`. */
export function isDataSlot(slot: RefSlot): boolean {
  return allData(possibleUses(slot));
}

/** True when a concrete site's every slot takes only `dependency` there. */
export function isDataSite(site: ReachSite, resource: unknown): boolean {
  return (
    site.refs.length > 0 &&
    site.refs.every(({ slot }, index) =>
      allData(resolveSlotUseAt(slot, resource, site.refs[index]!, site.path).use),
    )
  );
}

/** True for a callable kind whose result comes from its controller's code —
 *  no field of its author schema is a body. A callable `Telo.Abstract` is
 *  native, since every implementation of it is. */
export function isNativeCallableKind(
  definition: ResourceDefinition | undefined,
  resolve: DefResolver,
): boolean {
  return isCallableKind(definition, resolve) && callableBodyField(definition, resolve) === undefined;
}

/** Why a referent's configuration cannot be handed over as data. `module` is a
 *  template body's reference to a resource of the module defining the template,
 *  which the body's lookup does not reach (`template-body-lookup.ts`). `value`
 *  and `unresolved` are the kernel's alone: what an instance holds at a position
 *  no manifest describes, and a reference it finds no created resource for. */
export type NotDataReason =
  | { readonly kind: "expression"; readonly path: string; readonly tag: string }
  | { readonly kind: "scope"; readonly path: string }
  | { readonly kind: "need" }
  | { readonly kind: "cycle" }
  | { readonly kind: "module" }
  | { readonly kind: "value"; readonly path: string; readonly what: string }
  | { readonly kind: "unresolved" };

/** A refusal, with the references followed from the slot's referent to the
 *  declaration it is about — the referent alone when it is that one. */
export interface NotData {
  readonly chain: readonly string[];
  readonly reason: NotDataReason;
}

/** The one sentence both halves refuse a data site with
 *  (`CALLABLE_REFERENCE_NOT_DATA` / `ERR_CALLABLE_REFERENCE_NOT_DATA`). */
export function callableReferenceNotDataMessage(
  holder: string,
  sitePath: string,
  notData: NotData,
): string {
  const quote = (name: string) => `'${name}'`;
  const last = notData.chain[notData.chain.length - 1]!;
  const subject =
    notData.chain.length > 1
      ? `${quote(last)}, which it reaches through ${notData.chain.slice(0, -1).map(quote).join(" → ")},`
      : "it";
  const reason = notData.reason;
  const why = (() => {
    switch (reason.kind) {
      case "expression":
        return (
          `${subject} holds \`!${reason.tag}\` at '${reason.path}', evaluated after it is created, so ` +
          `its configuration is not data yet. A native function receives each dependency's ` +
          `configuration once, at creation: write a literal there, or an expression in a field ` +
          `its kind evaluates at creation`
        );
      case "scope":
        return (
          `${subject} declares a scope at '${reason.path}', whose resources are created only when ` +
          `its controller runs, so nothing there is data`
        );
      case "need":
        return (
          `${quote(last)} is a need: it is supplied when the application loads, from outside the ` +
          `manifest, so there is no configuration to hand over. Read its fields in a compile-eval ` +
          `field instead (\`resources.${last}.<field>\`)`
        );
      case "module":
        return (
          `${quote(last)} is a resource of the module defining the template, which an entry ` +
          `of the template's body does not reach: declare it in the body's \`resources:\`, or ` +
          `hand it in through a bare \`self.<field>\``
        );
      case "cycle":
        return (
          `the references ${notData.chain.map(quote).join(" → ")} form a cycle, so its ` +
          `configuration would contain itself`
        );
      case "value":
        return `${subject} holds ${reason.what} at '${reason.path}', which is not data`;
      case "unresolved":
        return `${quote(last)} names no resource created in the scope that wrote it`;
    }
  })();
  return `${holder}: holds ${quote(notData.chain[0]!)} at '${sitePath}' as data, but ${why}.`;
}
