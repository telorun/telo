import {
  coReferrerScopedMessage,
  isResolvedReference,
  pointerToPath,
  scopedCoReferrerCalls,
  type CoReferrerCall,
  type DefResolver,
  type ReachSite,
} from "@telorun/analyzer";
import { refSentinelTarget, RuntimeError, type ResourceManifest } from "@telorun/sdk";
import type { CoReferrerIndex, IndexedDeclaration } from "./co-referrer-index.js";

/**
 * `ERR_CO_REFERRER_SCOPED` — a scope member (`with:`, `x-telo-scope`) that would
 * be a co-referrer of some registered `callsCoReferrers`: it exists only while
 * its scope runs, so no dispatch from module scope can reach it. Refused when
 * the holder's scope is opened for injection, worded as `telo check` words
 * `CO_REFERRER_SCOPED`.
 */
export function refuseScopedCoReferrers(args: {
  members: readonly unknown[];
  /** The scope field as written (`with`). */
  field: string;
  holder: ResourceManifest;
  /** A member's canonical kind, resolved in the holder's module. */
  kindOf: (kind: string) => string;
  sitesOf: (member: ResourceManifest) => ReachSite[];
  calls: readonly CoReferrerCall[];
  resolve: DefResolver;
}): void {
  if (args.calls.length === 0) return;
  for (const member of args.members) {
    if (!member || typeof member !== "object") continue;
    const manifest = member as ResourceManifest;
    if (typeof manifest.kind !== "string") continue;
    const written = new Map<string, string>();
    for (const site of args.sitesOf(manifest)) {
      if (site.refs.length === 0 || written.has(site.path)) continue;
      const shown = shownReference(site.data);
      if (shown) written.set(site.path, shown);
    }
    const [call] = scopedCoReferrerCalls(
      args.kindOf(manifest.kind),
      new Set(written.keys()),
      args.calls,
      args.resolve,
    );
    if (!call) continue;
    const slot = pointerToPath(call.slot);
    throw new RuntimeError(
      "ERR_CO_REFERRER_SCOPED",
      coReferrerScopedMessage({
        kind: manifest.kind,
        name: String(manifest.metadata?.name),
        target: written.get(slot)!,
        slot,
        scope: args.field,
        owner: String(args.holder.metadata?.name),
      }),
    );
  }
}

/** A reference as written (`Lib.Joined`), or undefined for any other value. */
function shownReference(value: unknown): string | undefined {
  const sentinel = refSentinelTarget(value);
  if (sentinel) return sentinel.alias ? `${sentinel.alias}.${sentinel.name}` : sentinel.name;
  if (isResolvedReference(value)) {
    const { alias, name } = value;
    return typeof alias === "string" && alias !== "Self" ? `${alias}.${name}` : name;
  }
  return undefined;
}

/**
 * `ERR_CO_REFERRER_SCOPED` — a co-referrer in the library instance a scoped
 * `Telo.Import` reached whose target lies outside that instance's tree, in one
 * that outlives the scope run (the application's, a `shared` library's): the
 * dispatch its target's index answers never reaches it. Refused when the scoped
 * import initializes, worded as `telo check` words `CO_REFERRER_SCOPED`.
 */
export function refuseOutlivingCoReferrers(
  index: CoReferrerIndex,
  args: {
    /** The scoped import's name, its innermost holder and that holder's scope field. */
    alias: string;
    holder: string;
    field: string;
    calls: readonly CoReferrerCall[];
    resolve: DefResolver;
    kindOf: (d: IndexedDeclaration) => string;
    sitesOf: (d: IndexedDeclaration) => ReachSite[];
  },
): void {
  if (args.calls.length === 0) return;
  for (const d of index.declarations) {
    const written = new Map<string, string>();
    for (const site of args.sitesOf(d)) {
      if (site.refs.length === 0 || written.has(site.path)) continue;
      const shown = shownReference(site.data);
      if (shown) written.set(site.path, shown);
    }
    for (const call of scopedCoReferrerCalls(args.kindOf(d), new Set(written.keys()), args.calls, args.resolve)) {
      const target = index.targetOf(d, call);
      if (!target || index.holds(target)) continue;
      const slot = pointerToPath(call.slot);
      throw new RuntimeError(
        "ERR_CO_REFERRER_SCOPED",
        coReferrerScopedMessage({
          kind: d.manifest.kind as string,
          name: d.name,
          target: written.get(slot)!,
          slot,
          scope: args.field,
          owner: args.holder,
          through: args.alias,
        }),
      );
    }
  }
}
