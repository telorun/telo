import type { ResourceManifest } from "@telorun/sdk";
import { isKindDocument } from "./kind-declaration.js";
import { isModuleKind } from "./module-kinds.js";
import { isScopeMemberDeclaration } from "./scope-members.js";
import { importPathOf } from "./scoped-name-resolver.js";

/**
 * What a `Telo.Import` declared as a scope member names, read off the stamps
 * the flattening writes on it: the holders it sits under and the module it
 * reached. It gives its scope INSTANCE names only — `!ref <Member>.<name>` and
 * `resources.<Member>.<name>` from the scope's members and regions — and never a
 * module name, so no kind or module function resolves through it.
 *
 * Browser-safe.
 */

/** The holder names a scoped `Telo.Import` member sits under, or undefined for
 *  any other document. */
export function scopeHoldersOf(manifest: unknown): readonly string[] | undefined {
  const holders = (manifest as { metadata?: { scopeHolders?: unknown } } | undefined)?.metadata?.scopeHolders;
  return Array.isArray(holders) ? (holders as string[]) : undefined;
}

/** Whether `manifest` is a `Telo.Import` declared as a scope member. */
export function isScopedImport(manifest: unknown): boolean {
  return (manifest as { kind?: unknown } | undefined)?.kind === "Telo.Import" && scopeHoldersOf(manifest) !== undefined;
}

/** The module a scoped import reaches and the instance path a reference
 *  through it, written in `writer`, names. */
export function scopedImportReach(
  member: unknown,
  writer: unknown,
): { module: string; importPath: string[] } | undefined {
  const holders = scopeHoldersOf(member);
  const meta = (member as { metadata?: { name?: unknown; resolvedModuleName?: unknown } }).metadata;
  if (!holders || typeof meta?.name !== "string" || typeof meta.resolvedModuleName !== "string") return undefined;
  return {
    module: meta.resolvedModuleName,
    importPath: [...(importPathOf(writer) ?? []), ...holders, meta.name],
  };
}

/** Where a scoped `Telo.Import` is declared: the holder whose scope holds it
 *  and that scope's field. */
export interface ScopedImportPlace {
  readonly alias: string;
  readonly holder: string;
  readonly field: string;
}

/** The place of a scoped import member from its stamps. */
export function scopedImportPlace(member: unknown): ScopedImportPlace | undefined {
  const holders = scopeHoldersOf(member);
  const meta = (member as { metadata?: { name?: unknown; scopePath?: unknown } }).metadata;
  if (!holders?.length || typeof meta?.name !== "string" || typeof meta.scopePath !== "string") return undefined;
  const last = meta.scopePath.split(".").pop() ?? "";
  return { alias: meta.name, holder: holders[holders.length - 1]!, field: last.replace(/\[\d+\]$/, "") };
}

/** The `UNDEFINED_KIND` sentence for a kind spelled through a scoped import. */
export function scopedImportKindMessage(kind: string, place: ScopedImportPlace): string {
  return (
    `Kind '${kind}': '${place.alias}' is a Telo.Import declared in the \`${place.field}:\` scope of ` +
    `'${place.holder}', which gives that scope its exported instances (\`!ref ${place.alias}.<name>\`, ` +
    `\`resources.${place.alias}.<name>\`) and no kinds or functions. To use its kinds or functions, ` +
    `import that module under 'imports:'.`
  );
}

/** Where a diagnostic about a scoped `Telo.Import` member is reported: the
 *  member's place inside its top-level holder, in the declaring file. */
export interface ScopedImportAnchor {
  filePath: string;
  resource: { kind: string; name: string };
  path: string;
}

/** The anchor of a scoped `Telo.Import` member, or undefined for any other. */
export function scopedImportAnchorOf(manifest: unknown): ScopedImportAnchor | undefined {
  const anchor = (manifest as { metadata?: { scopeAnchor?: unknown } } | undefined)?.metadata?.scopeAnchor;
  return anchor && typeof anchor === "object" ? (anchor as ScopedImportAnchor) : undefined;
}

/** A scoped `Telo.Import` member found beneath a top-level declaration. */
export interface ScopedImportMember {
  readonly member: ResourceManifest;
  /** The top-level declaration holding it. */
  readonly top: ResourceManifest;
  /** Its place inside `top` (`with[0]`). */
  readonly path: string;
}

/** Every scoped `Telo.Import` member beneath `manifests`, at any depth, as
 *  {@link stampScopedImportIdentity} marked them, in document order. */
export function scopedImportMembers(manifests: readonly unknown[]): ScopedImportMember[] {
  const out: ScopedImportMember[] = [];
  const seen = new Set<object>();
  const visit = (value: unknown, top: ResourceManifest, isTop: boolean): void => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item, top, false);
      return;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return;
    const node = value as Record<string, unknown>;
    if (!isTop && node.kind === "Telo.Import" && scopeHoldersOf(node)) {
      const path = (node.metadata as { scopePath?: unknown }).scopePath;
      out.push({ member: node as unknown as ResourceManifest, top, path: typeof path === "string" ? path : "" });
      return;
    }
    for (const [key, child] of Object.entries(node)) if (key !== "metadata") visit(child, top, false);
  };
  for (const m of manifests) {
    if (!m || typeof m !== "object") continue;
    const kind = (m as { kind?: unknown }).kind;
    if (kind === "Telo.Import" || isModuleKind(kind as string) || isKindDocument(m as { kind?: unknown })) continue;
    // A scope member the analysis holds beside its holder is walked through it.
    if (isScopeMemberDeclaration(m)) continue;
    visit(m, m as ResourceManifest, true);
  }
  return out;
}

