/**
 * How a builder on the CEL judging path reads OTHER declarations: by request,
 * never by scanning a list.
 *
 * Two request forms, and nothing else:
 *  - **by name** — what a name names, under the scoped rule
 *    (`ScopedNameResolver`): `names`;
 *  - **named enumeration** — one method per set a builder needs whole, named
 *    for what is asked (`kindDocuments()`, `published()`, `referrersOf(m)`, …).
 *
 * The analysis of one configuration, the editor and the kernel answer every
 * request from their full list ({@link listRequests}). A per-key environment
 * answers from what its key covers, and refuses what no class covers — which a
 * builder handed a list could never tell it: a list missing a declaration
 * answers a scan quietly, over a subset.
 *
 * Browser-safe.
 */
import type { ResourceManifest } from "@telorun/sdk";
import { isKindDocument } from "./kind-declaration.js";
import { isModuleKind } from "./module-kinds.js";
import { manifestNames, type ScopedNameResolver } from "./scoped-name-resolver.js";

/** The by-name form: the scoped rule over the declarations of a set. */
export type NameRequests = Pick<
  ScopedNameResolver<ResourceManifest>,
  "resolve" | "locate" | "scopeMember" | "declarationsOf" | "inModule"
>;

/** One slot referencing a declaration: the declaration holding it and the
 *  slot's concrete path. */
export interface ReferringSlot {
  readonly manifest: ResourceManifest;
  readonly path: string;
}

export interface DeclarationRequests {
  /** By name. */
  readonly names: NameRequests;
  /** The kind documents (`Telo.Definition`, `Telo.Abstract`, need types). */
  kindDocuments(): readonly ResourceManifest[];
  /** The module documents (`Telo.Application`, `Telo.Library`). */
  moduleDocuments(): readonly ResourceManifest[];
  /** Every declaration a `resources` record and the observed-state index may
   *  list — each builder keeps those its own rule admits. */
  published(): readonly ResourceManifest[];
  /** Every declaration a module call may reach, and the imports a call reaches
   *  an exported function through. */
  callables(): readonly ResourceManifest[];
  /** Every declaration a catch ladder reads: a catch list, what it encloses,
   *  and what that throws. */
  catchScope(): readonly ResourceManifest[];
  /** The slots referencing `m`. */
  referrersOf(m: ResourceManifest): readonly ReferringSlot[];
  /** Whether the content of a declaration `published()` lists is answered —
   *  absent, every one's is. A `resources` record lists one whose content is
   *  not under a type that holds no member. */
  holdsContentOf?(m: ResourceManifest): boolean;
}

/** What the full-list requests need beside the list. */
export interface ListRequestOptions {
  /** The slots referencing a declaration; absent, none. */
  readonly referrersOf?: (m: ResourceManifest) => readonly ReferringSlot[];
}

const NO_REFERRERS = (): readonly ReferringSlot[] => [];

const memo = new WeakMap<readonly ResourceManifest[], DeclarationRequests>();

/**
 * Every request answered from `manifests`, read as it stands when asked — a
 * list a pass grows (scope members, forward views) answers with what it holds
 * then. One object per list, so whatever is memoized per request object holds
 * for every reader of the list.
 */
export function listRequests(
  manifests: readonly ResourceManifest[],
  options: ListRequestOptions = {},
): DeclarationRequests {
  if (!options.referrersOf) {
    const known = memo.get(manifests);
    if (known) return known;
  }
  const filtered = (keep: (m: ResourceManifest) => boolean) => {
    let size = -1;
    let out: ResourceManifest[] = [];
    return (): readonly ResourceManifest[] => {
      if (size !== manifests.length) {
        size = manifests.length;
        out = manifests.filter(keep);
      }
      return out;
    };
  };
  const requests: DeclarationRequests = {
    get names() {
      return manifestNames(manifests);
    },
    kindDocuments: filtered((m) => isKindDocument(m)),
    moduleDocuments: filtered((m) => isModuleKind(m.kind as string | undefined)),
    published: () => manifests,
    callables: () => manifests,
    catchScope: () => manifests,
    referrersOf: options.referrersOf ?? NO_REFERRERS,
  };
  if (!options.referrersOf) memo.set(manifests, requests);
  return requests;
}
