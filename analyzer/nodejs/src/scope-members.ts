import type { ResourceManifest } from "@telorun/sdk";
import { isTaggedSentinel } from "@telorun/templating";
import { isForwardedDeclaration } from "./forwarded-declaration.js";
import { isModuleKind } from "./module-kinds.js";
import type { ReachSite } from "./reference-reach.js";
import { scopeAddress, type ScopeAddress, type ScopeSite } from "./scope-address.js";
import {
  declaredScopes,
  isScopeMember,
  outsideScopesOf,
  type DeclaredScope,
  type OutsideScope,
} from "./scope-declarations.js";
import { isKindDocumentOrImport } from "./system-kinds.js";
import type { AnalysisDiagnostic } from "./types.js";

/**
 * The members of every `x-telo-scope` array, as DECLARATIONS of their holder's
 * module — what the kernel creates when the scope opens, so what the analysis
 * checks as it checks a top-level resource.
 *
 * A member is analysed as the very object its holder's array holds (inline
 * extractions placed there included), its `metadata` re-stamped with what a
 * top-level declaration of the holder's module carries — `module`,
 * `moduleGlobals`, a dependency's `forwardedInternal` — so every pass resolves
 * its kind and types its CEL in that module. Its `metadata.source` is a token
 * naming its address: a diagnostic any pass writes about it carries the token
 * as its file, and {@link ScopeMembers.relocate} moves it to the position the
 * member is written at inside its top-level holder (`with[0].valeu`), the
 * holder becoming its `data.resource`. The kernel's own copy is untouched:
 * analysis owns a deep clone.
 *
 * Which members are in scope where is the scoped name resolver's — it files a
 * member under its scope (`DeclarationReading.scopeOf`), never at module level.
 *
 * Browser-safe.
 */
export interface ScopeMember {
  /** The member, as the analysis holds it — the object in its holder's array. */
  readonly declaration: ResourceManifest;
  /** The scope declaring it. */
  readonly site: ScopeSite;
  readonly address: ScopeAddress;
  /** The resource declaring the scope — a top-level declaration or a member. */
  readonly holder: ResourceManifest;
  /** The holder's scope, with its regions and array. */
  readonly scope: DeclaredScope;
  /** Its `metadata.source` while analysed: what a diagnostic about it carries. */
  readonly token: string;
}

const members = new WeakMap<object, ScopeMember>();
/** The scopes each declaration the collection walked declares. */
const heldScopes = new WeakMap<object, readonly DeclaredScope[]>();
/** A declaration standing in for what a scope member creates — a template
 *  forward view, or what one extracted — and the member's scope. */
const placed = new WeakMap<object, ScopeSite>();
const TOKEN_PREFIX = "telo-scope-member:";
let nextToken = 0;

/** The scope member `manifest` is, when it is one. */
export function scopeMemberOf(manifest: unknown): ScopeMember | undefined {
  return manifest && typeof manifest === "object" ? members.get(manifest) : undefined;
}

/** A declaration's address: a scope member's own, or its module-level one. */
export function declarationAddress(manifest: ResourceManifest): ScopeAddress | undefined {
  const member = members.get(manifest);
  if (member) return member.address;
  const name = (manifest?.metadata as { name?: unknown } | undefined)?.name;
  if (typeof name !== "string") return undefined;
  const site = placed.get(manifest);
  return scopeAddress(site ?? (manifest.metadata as { module?: string }).module, name);
}

/** The scope `manifest` is declared in: a scope member's, or the scope of the
 *  member a declaration stands in for. */
export function declaringScopeOf(manifest: unknown): ScopeSite | undefined {
  if (!manifest || typeof manifest !== "object") return undefined;
  return members.get(manifest)?.site ?? placed.get(manifest);
}

/** The scopes `manifest` declares, as the member collection read them — empty
 *  for a declaration it did not walk. */
export function scopesDeclaredBy(manifest: unknown): readonly DeclaredScope[] {
  return manifest && typeof manifest === "object" ? (heldScopes.get(manifest) ?? []) : [];
}

/**
 * Declare `declaration` in the scope `consumer` is declared in, when it is: a
 * declaration the analysis builds for a scope member (a template forward view,
 * what one extracted) holds values written in the member's scope, so it reads
 * names there.
 */
export function declareInScopeOf(declaration: ResourceManifest, consumer: ResourceManifest): void {
  const site = declaringScopeOf(consumer);
  if (site) placed.set(declaration, site);
}

/**
 * Declare `declaration` in `site`, when there is one: a declaration the
 * analysis builds for a consumer written beneath another declaration stands
 * where that consumer is written, so it reads names in the scope declaring it
 * there.
 */
export function declareInScope(declaration: ResourceManifest, site: ScopeSite | undefined): void {
  if (site) placed.set(declaration, site);
}

/** Whether `manifest` is a scope member — what a whole-application pass that
 *  places it through its holder skips. */
export function isScopeMemberDeclaration(manifest: unknown): boolean {
  return scopeMemberOf(manifest) !== undefined;
}

/**
 * The names `declaration` cannot reach although it is written where they read
 * as reachable, each with the scope declaring it: those its own extraction
 * recorded (`xTeloOrigin.outsideScopes`), and those of every holder it is a
 * member of — a member is created where its holder is — the innermost winning.
 */
export function outOfReachNames(declaration: ResourceManifest): Map<string, OutsideScope> {
  const chain: ResourceManifest[] = [];
  for (let d: ResourceManifest | undefined = declaration; d; d = members.get(d)?.holder) chain.unshift(d);
  const reach = new Map<string, OutsideScope>();
  for (const holder of chain) {
    for (const scope of outsideScopesOf(holder)) {
      for (const name of scope.names) reach.set(name, scope);
    }
  }
  return reach;
}

/** Every scope member of one analysis. */
export class ScopeMembers {
  private readonly byToken = new Map<string, ScopeMember>();

  constructor(readonly all: readonly ScopeMember[]) {
    for (const member of all) this.byToken.set(member.token, member);
  }

  /**
   * Move every diagnostic written about a member to its holder: `data.resource`
   * the top-level declaration holding it, `data.filePath` that declaration's
   * file, and `data.path` the member's place in it (`with[0].steps[1].invoke`),
   * at every depth of nested scopes. The index is the member's position in its
   * scope array when the diagnostic is moved — an extraction placed there is
   * moved again, to where it was written, with the rest of the extractions.
   */
  relocate(diagnostics: AnalysisDiagnostic[]): AnalysisDiagnostic[] {
    if (this.all.length === 0) return diagnostics;
    return diagnostics.map((d) => {
      const data = d.data as { filePath?: unknown; path?: unknown } | undefined;
      const member = typeof data?.filePath === "string" ? this.byToken.get(data.filePath) : undefined;
      if (!member) return d;
      let path = typeof data!.path === "string" ? data!.path : "";
      let current: ScopeMember | undefined = member;
      let root: ResourceManifest = member.holder;
      while (current) {
        const index = current.scope.declarations.indexOf(current.declaration);
        const at = `${current.scope.path}[${index}]`;
        path = path ? (path.startsWith("[") ? `${at}${path}` : `${at}.${path}`) : at;
        root = current.holder;
        current = members.get(current.holder);
      }
      const meta = root.metadata as { name?: string; source?: string };
      return {
        ...d,
        data: {
          ...(d.data as Record<string, unknown>),
          resource: { kind: root.kind, name: meta.name },
          filePath: meta.source,
          path,
        },
      };
    });
  }
}

/** A declaration the analysis checks as a resource — never a module, kind or
 *  import document, whose scope membership the kernel refuses or reads apart. */
function isAnalysedMember(member: ResourceManifest): boolean {
  return !isKindDocumentOrImport(member) && !isModuleKind(member.kind);
}

/**
 * Every scope member beneath `holders`, at any depth, each re-stamped as a
 * declaration of its holder's module and recorded as a member. `sitesOf` is the
 * registry's reach of a declaration; a member is read through it once stamped,
 * so its own scopes are found in its module's aliases.
 *
 * Kind and module documents and imports are recorded (`kindDocuments`) but not
 * returned as analysed declarations.
 */
export function collectScopeMembers(
  holders: readonly ResourceManifest[],
  sitesOf: (declaration: ResourceManifest) => readonly ReachSite[],
): { analysed: ScopeMember[]; kindDocuments: ScopeMember[] } {
  const analysed: ScopeMember[] = [];
  const kindDocuments: ScopeMember[] = [];
  const queue: ResourceManifest[] = [];
  for (const m of holders) {
    if (typeof m?.kind !== "string" || typeof m.metadata?.name !== "string") continue;
    if (isKindDocumentOrImport(m) || isModuleKind(m.kind)) continue;
    queue.push(m);
  }
  for (let i = 0; i < queue.length; i++) {
    const holder = queue[i]!;
    const holderAddress = declarationAddress(holder);
    if (!holderAddress) continue;
    const scopes = declaredScopes(sitesOf(holder));
    heldScopes.set(holder, scopes);
    for (const scope of scopes) {
      const site: ScopeSite = { holder: holderAddress, field: scope.path };
      for (const entry of scope.declarations) {
        if (!isScopeMember(entry) || members.has(entry)) continue;
        const token = `${TOKEN_PREFIX}${nextToken++}`;
        stampAsMember(entry, holder, token);
        const member: ScopeMember = {
          declaration: entry,
          site,
          address: scopeAddress(site, entry.metadata.name),
          holder,
          scope,
          token,
        };
        members.set(entry, member);
        if (isAnalysedMember(entry)) {
          analysed.push(member);
          queue.push(entry);
        } else {
          kindDocuments.push(member);
        }
      }
    }
  }
  return { analysed, kindDocuments };
}

/** Give a member the provenance a top-level declaration of its holder's module
 *  carries: the module, its config contract, its position, and whether it is a
 *  dependency's code. */
function stampAsMember(member: ResourceManifest, holder: ResourceManifest, token: string): void {
  const own = member.metadata as Record<string, unknown>;
  const from = holder.metadata as Record<string, unknown>;
  const stamped: Record<string, unknown> = { ...own };
  if (typeof from.module === "string" && typeof own.module !== "string") stamped.module = from.module;
  if (from.moduleGlobals !== undefined && own.moduleGlobals === undefined) {
    stamped.moduleGlobals = from.moduleGlobals;
  }
  if (isForwardedDeclaration(holder)) stamped.forwardedInternal = true;
  stamped.source = token;
  if (typeof from.sourceLine === "number") stamped.sourceLine = from.sourceLine;
  member.metadata = stamped as ResourceManifest["metadata"];
}

/**
 * Every CEL expression of `value`, as `walkCelExpressions` finds them, but
 * stopping at a scope member: what a member declares is its own, checked when
 * the member is. `isMember` says what a member is where the set holds no member
 * declarations (an editor's projection, which finds members through holders).
 */
export function walkOwnCelExpressions(
  value: unknown,
  path: string,
  cb: (source: string, path: string, engineName: string) => void,
  isMember: (value: unknown) => boolean = isScopeMemberDeclaration,
): void {
  if (isTaggedSentinel(value)) {
    cb(value.source, path, value.engine);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      if (!isMember(v)) walkOwnCelExpressions(v, `${path}[${i}]`, cb, isMember);
    });
    return;
  }
  if (
    value !== null &&
    typeof value === "object" &&
    !(value as { __compiled?: unknown }).__compiled &&
    isPlainObject(value)
  ) {
    for (const k in value) {
      walkOwnCelExpressions((value as Record<string, unknown>)[k], path ? `${path}.${k}` : k, cb, isMember);
    }
  }
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
